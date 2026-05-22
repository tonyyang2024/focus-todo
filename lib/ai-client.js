// AI Client — Agentic loop with streaming LLM calls
const https = require('https');
const http = require('http');
const toolRegistry = require('./tool-registry');

const MAX_TOOL_ITERATIONS = 10;
const AI_API_BASE = process.env.AI_API_BASE || 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = process.env.AI_MODEL || 'deepseek-chat';

/**
 * Run the agentic loop: think → act → observe → repeat
 */
async function runAgent(userMessage, history, apiKey, callbacks, options = {}) {
  const maxIter = options.maxIterations || MAX_TOOL_ITERATIONS;
  const model = options.model || DEFAULT_MODEL;
  const tools = toolRegistry.getToolDefinitions();

  const messages = buildMessages(userMessage, history);

  for (let iter = 0; iter < maxIter; iter++) {
    const result = await callLLM(messages, tools, apiKey, model, (token) => {
      callbacks.onToken({ text: token });
    });

    if (result.error) {
      callbacks.onError({ code: 'api_error', message: result.error });
      return;
    }

    // Check for tool calls
    const toolCalls = result.toolCalls;
    if (!toolCalls || toolCalls.length === 0) {
      callbacks.onDone({ text: result.content });
      return;
    }

    // Execute each tool call
    for (const tc of toolCalls) {
      callbacks.onToolCall({ id: tc.id, tool: tc.name, params: tc.arguments });

      let toolResult;
      try {
        toolResult = await toolRegistry.executeTool(tc.name, tc.arguments);
      } catch (e) {
        toolResult = { ok: false, error: e.message };
      }

      callbacks.onToolResult({ id: tc.id, tool: tc.name, result: toolResult });

      // Add tool call + result to messages for next iteration
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
        }]
      });
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(toolResult)
      });
    }
  }

  callbacks.onError({ code: 'max_iterations', message: `Exceeded maximum tool call iterations (${maxIter})` });
}

function buildMessages(userMessage, history) {
  const systemPrompt = `You are Yoohome, an AI programming and life assistant running in a web chat.
You have access to tools. Use them when needed — think step by step, act, observe results, then continue.

## Available Tools
${toolRegistry.getSystemToolPrompt()}

## Rules
- When you need information from a file, use read_file.
- When you need to write code, use write_file.
- When you need to edit existing code, use edit_file (the old_string must match exactly).
- When you need to run a command, use bash_exec.
- When you need to find files, use glob_search or list_files.
- When you need to search file contents, use grep_search.
- When you need information from the web, use web_search or web_fetch.
- When you need to read an uploaded document (PDF, Word, Excel, requirements doc), use document_parse with the docId.
- When you need to access the knowledge base, use search_kb or save_memory.
- For task queue operations, use task_queue_list and task_queue_update.
- Respond in the user's language (Chinese or English).
- Be concise and direct. Give the answer first, then details.
- Max ${MAX_TOOL_ITERATIONS} tool calls per turn.
- Code blocks should use markdown with language tags.

## Tool Call Format
When you need to use a tool, respond ONLY with the tool call, nothing else. The platform will execute it and give you the result.`;

  const msgs = [
    { role: 'system', content: systemPrompt },
    ...(history || []).filter(m => m.role !== 'system'),
    { role: 'user', content: userMessage }
  ];
  return msgs;
}

// Token usage tracking
let totalTokensIn = 0;
let totalTokensOut = 0;
let totalRequests = 0;
function getUsage() { return { tokensIn: totalTokensIn, tokensOut: totalTokensOut, requests: totalRequests }; }

/**
 * Call LLM API with streaming + retry. Returns { content, toolCalls, error, usage }
 */
async function callLLM(messages, tools, apiKey, model, onToken, retries = 2) {
  const isAnthropic = AI_API_BASE.includes('anthropic');
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      await new Promise(r => setTimeout(r, delay));
    }

    const result = isAnthropic
      ? await callAnthropic(messages, tools, apiKey, model, onToken)
      : await callOpenAICompatible(messages, tools, apiKey, model, onToken);

    totalRequests++;

    // Estimate token counts
    const inputStr = JSON.stringify(messages);
    totalTokensIn += Math.ceil(inputStr.length / 3.5);
    if (result.content) totalTokensOut += Math.ceil(result.content.length / 3.5);

    result.usage = { tokensIn: totalTokensIn, tokensOut: totalTokensOut, requests: totalRequests };

    if (!result.error) return result;

    // Retry on server errors (5xx) and network errors
    const isRetryable = result.error.includes('API 5') ||
                        result.error.includes('Request error') ||
                        result.error.includes('timeout') ||
                        result.error.includes('ECONNREFUSED') ||
                        result.error.includes('ETIMEDOUT');

    if (isRetryable && attempt < retries) {
      lastError = result.error;
      continue;
    }

    return result;
  }

  return { error: lastError || 'All retries exhausted', usage: getUsage() };
}

function resetUsage() { totalTokensIn = 0; totalTokensOut = 0; totalRequests = 0; }

function callOpenAICompatible(messages, tools, apiKey, model, onToken) {
  const urlObj = new URL(AI_API_BASE.replace(/\/+$/, '') + '/chat/completions');
  const body = JSON.stringify({
    model,
    messages,
    tools,
    tool_choice: 'auto',
    stream: true,
    max_tokens: 8192
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body)
      },
      rejectUnauthorized: false,
      timeout: 120000
    }, (res) => {
      if (res.statusCode !== 200) {
        let errData = '';
        res.on('data', c => errData += c);
        res.on('end', () => resolve({ error: `API ${res.statusCode}: ${errData.slice(0, 500)}` }));
        return;
      }

      let content = '';
      let buffer = '';
      const toolCallMap = {};

      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;

          try {
            const data = JSON.parse(dataStr);
            const delta = data.choices?.[0]?.delta;
            if (!delta) continue;

            // Text token
            if (delta.content) {
              content += delta.content;
              onToken(delta.content);
            }

            // Tool calls in delta
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (!toolCallMap[idx]) {
                  toolCallMap[idx] = { id: tc.id || '', name: '', arguments: '' };
                }
                if (tc.id) toolCallMap[idx].id = tc.id;
                if (tc.function?.name) toolCallMap[idx].name += tc.function.name;
                if (tc.function?.arguments) toolCallMap[idx].arguments += tc.function.arguments;
              }
            }
          } catch {}
        }
      });

      res.on('end', () => {
        const toolCalls = Object.values(toolCallMap).map(tc => {
          let args = {};
          try { args = JSON.parse(tc.arguments); } catch {}
          return { id: tc.id, name: tc.name, arguments: args };
        });

        // Fallback: parse text tool calls if LLM didn't use native function calling
        if (toolCalls.length === 0 && content) {
          const textToolCalls = parseTextToolCalls(content);
          if (textToolCalls.length > 0) {
            resolve({ content: '', toolCalls: textToolCalls });
            return;
          }
        }

        resolve({ content, toolCalls });
      });

      res.on('error', (e) => {
        resolve({ error: 'Response error: ' + e.message });
      });
    });

    req.on('error', (e) => resolve({ error: 'Request error: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'Request timeout (120s)' }); });
    req.write(body);
    req.end();
  });
}

function callAnthropic(messages, tools, apiKey, model, onToken) {
  const urlObj = new URL(AI_API_BASE.replace(/\/+$/, '') + '/messages');

  // Convert to Anthropic format
  const systemMsg = messages.find(m => m.role === 'system');
  const system = systemMsg ? [{ type: 'text', text: systemMsg.content }] : [];
  const convMessages = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role,
    content: m.content || ''
  }));

  const anthropicTools = tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters
  }));

  const body = JSON.stringify({
    model: model === 'deepseek-chat' ? 'claude-sonnet-4-6' : model,
    system,
    messages: convMessages,
    tools: anthropicTools,
    max_tokens: 8192,
    stream: true
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      },
      rejectUnauthorized: false,
      timeout: 120000
    }, (res) => {
      if (res.statusCode !== 200) {
        let errData = '';
        res.on('data', c => errData += c);
        res.on('end', () => resolve({ error: `API ${res.statusCode}: ${errData.slice(0, 500)}` }));
        return;
      }

      let content = '';
      let buffer = '';
      const toolCallMap = {};

      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const dataStr = trimmed.slice(6);

          try {
            const data = JSON.parse(dataStr);

            if (data.type === 'content_block_delta') {
              if (data.delta?.type === 'text_delta') {
                content += data.delta.text;
                onToken(data.delta.text);
              }
              if (data.delta?.type === 'input_json_delta' && data.index !== undefined) {
                if (!toolCallMap[data.index]) {
                  toolCallMap[data.index] = { id: '', name: '', arguments: '' };
                }
                toolCallMap[data.index].arguments += data.delta.partial_json;
              }
            }

            if (data.type === 'content_block_start') {
              if (data.content_block?.type === 'tool_use') {
                toolCallMap[data.index] = {
                  id: data.content_block.id,
                  name: data.content_block.name,
                  arguments: ''
                };
              }
            }
          } catch {}
        }
      });

      res.on('end', () => {
        const toolCalls = Object.values(toolCallMap).map(tc => {
          let args = {};
          try { args = JSON.parse(tc.arguments); } catch {}
          return { id: tc.id, name: tc.name, arguments: args };
        });
        resolve({ content, toolCalls });
      });

      res.on('error', (e) => resolve({ error: 'Response error: ' + e.message }));
    });

    req.on('error', (e) => resolve({ error: 'Request error: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'Request timeout (120s)' }); });
    req.write(body);
    req.end();
  });
}

/**
 * Fallback: parse text for [[TOOL_CALL:tool_name:{"param":"value"}]] markers
 */
function parseTextToolCalls(text) {
  const toolCalls = [];
  const regex = /\[\[TOOL_CALL:\s*(\w+)\s*:\s*(\{.+?\})\s*\]\]/gs;
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      toolCalls.push({
        id: 'call_' + Math.random().toString(36).slice(2, 10),
        name: match[1],
        arguments: JSON.parse(match[2])
      });
    } catch {}
  }
  return toolCalls;
}

module.exports = { runAgent, buildMessages, parseTextToolCalls, callLLM, getUsage, resetUsage };
