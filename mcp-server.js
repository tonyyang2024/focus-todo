// Simple MCP Server - Adds external tools to AI capabilities
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MCP_PORT = 3001;

// ====== TOOLS ======
const tools = {
  web_fetch: {
    name: 'web_fetch',
    description: 'Fetch content from a URL and return as text',
    parameters: { url: 'string (required) - The URL to fetch' },
    handler: async (params) => {
      const u = new URL(params.url);
      const mod = u.protocol === 'https:' ? https : http;
      return new Promise((resolve) => {
        mod.get(params.url, (res) => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => {
            const text = d.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000);
            resolve({ ok: true, status: res.statusCode, text, length: text.length });
          });
        }).on('error', e => resolve({ ok: false, error: e.message }));
      });
    }
  },

  file_info: {
    name: 'file_info',
    description: 'Get file or directory information',
    parameters: { path: 'string (required) - File path relative to workspace' },
    handler: async (params) => {
      const fp = path.join(__dirname, params.path.replace(/^\/+/, ''));
      try {
        const stat = fs.statSync(fp);
        return {
          ok: true, path: fp, size: stat.size,
          isDir: stat.isDirectory(), isFile: stat.isFile(),
          modified: stat.mtime.toISOString(),
          sizeFormatted: stat.isDirectory() ? 'DIR' : formatSize(stat.size)
        };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  list_files: {
    name: 'list_files',
    description: 'List files in a directory',
    parameters: { path: 'string (optional) - Directory path relative to workspace, default root' },
    handler: async (params) => {
      const fp = params.path ? path.join(__dirname, params.path.replace(/^\/+/, '')) : __dirname;
      try {
        const files = fs.readdirSync(fp).map(f => {
          const s = fs.statSync(path.join(fp, f));
          return { name: f, size: s.size, dir: s.isDirectory(), modified: s.mtime.toISOString() };
        });
        return { ok: true, path: fp, count: files.length, files: files.slice(0, 50) };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  system_info: {
    name: 'system_info',
    description: 'Get system information',
    handler: async () => {
      return {
        ok: true,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        uptime: Math.floor(process.uptime()),
        memory: Math.floor(process.memoryUsage().rss / 1024 / 1024) + ' MB',
        cwd: process.cwd()
      };
    }
  },

  search_kb: {
    name: 'search_kb',
    description: 'Search the local knowledge base',
    parameters: { query: 'string (required) - Search query' },
    handler: async (params) => {
      try {
        const db = require('./db');
        const results = db.searchMemory(params.query || '');
        return { ok: true, count: results.length, results: results.map(r => ({ key: r.key, tags: r.tags, updated: r.updated_at })) };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  document_parse: {
    name: 'document_parse',
    description: 'Retrieve a parsed document by its docId (from /api/documents/upload). Returns text content and metadata.',
    parameters: { docId: 'string (required) - Document ID from /api/documents/upload' },
    handler: async (params) => {
      try {
        const docPath = path.join(__dirname, 'data', 'documents', params.docId + '.json');
        if (!fs.existsSync(docPath)) return { ok: false, error: 'Document not found or expired' };
        const doc = JSON.parse(fs.readFileSync(docPath, 'utf8'));
        return { ok: true, text: doc.text, metadata: doc.metadata, fileName: doc.fileName };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  task_queue_manage: {
    name: 'task_queue_manage',
    description: 'List or update task queue items. action: "list" to view pending tasks, "complete" to mark a task done, "update" to change status.',
    parameters: {
      action: 'string (required) - "list", "complete", or "update"',
      taskId: 'string (optional) - Task ID for complete/update actions',
      status: 'string (optional) - New status for update action (pending/processing/completed/failed)',
      result: 'string (optional) - Result text for completed tasks'
    },
    handler: async (params) => {
      try {
        const db = require('./db');
        if (params.action === 'list') {
          const rows = db.searchMemory('task:');
          const tasks = rows.map(r => {
            try { return { id: r.key, ...JSON.parse(r.value), tags: r.tags }; }
            catch { return { id: r.key, tags: r.tags }; }
          });
          return { ok: true, count: tasks.length, tasks };
        }
        if ((params.action === 'complete' || params.action === 'update') && params.taskId) {
          const rows = db.searchMemory(params.taskId);
          if (!rows.length) return { ok: false, error: 'Task not found' };
          const task = JSON.parse(rows[0].value);
          if (params.action === 'complete') {
            task.status = 'completed';
            task.result = params.result || '';
            task.completedAt = new Date().toISOString();
          } else {
            if (params.status) task.status = params.status;
            if (params.result !== undefined) task.result = params.result;
          }
          db.saveMemory(params.taskId, task, ['task', task.status || 'pending']);
          return { ok: true, task: { id: params.taskId, ...task } };
        }
        return { ok: false, error: 'Invalid action. Use "list", "complete", or "update".' };
      } catch (e) { return { ok: false, error: e.message }; }
    }
  },

  // ====== SAP Joule (A2A Protocol) Tools ======
  joule_chat: {
    name: 'joule_chat',
    description: 'Send a natural language query to SAP Joule AI via A2A protocol. Ask about sales orders, business partners, inventory, or any SAP business data.',
    parameters: { query: 'string (required) - Natural language question for Joule', config: 'object (required) - {jouleURL, clientId, clientSecret, tokenURL}' },
    handler: async (params) => {
      const cfg = loadJouleConfig(params.config);
      if (!cfg.jouleURL) return { ok: false, error: 'Joule endpoint not configured. Set in Workbench Project Context.' };
      return await callJouleA2A(cfg, params.query);
    }
  },

  joule_sales_order: {
    name: 'joule_sales_order',
    description: 'Query SAP Joule about sales orders using natural language. Example: "Show me order 12345" or "List pending orders for customer ACME"',
    parameters: { query: 'string (required) - Natural language query about sales orders', config: 'object (required) - Joule configuration' },
    handler: async (params) => {
      const cfg = loadJouleConfig(params.config);
      if (!cfg.jouleURL) return { ok: false, error: 'Joule endpoint not configured.' };
      return await callJouleA2A(cfg, 'Sales Order: ' + params.query);
    }
  },

  joule_business_data: {
    name: 'joule_business_data',
    description: 'Ask SAP Joule any business-related question - customers, inventory, financials, procurement, etc.',
    parameters: { query: 'string (required) - Business question', config: 'object (required) - Joule configuration' },
    handler: async (params) => {
      const cfg = loadJouleConfig(params.config);
      if (!cfg.jouleURL) return { ok: false, error: 'Joule endpoint not configured.' };
      return await callJouleA2A(cfg, params.query);
    }
  },

  joule_status: {
    name: 'joule_status',
    description: 'Check SAP Joule A2A connection status',
    parameters: { config: 'object (required) - Joule configuration' },
    handler: async (params) => {
      const cfg = loadJouleConfig(params.config);
      if (!cfg.jouleURL) return { ok: false, error: 'Joule endpoint not configured' };
      try {
        const result = await callJouleA2A(cfg, 'ping');
        return { ok: true, connected: true, endpoint: cfg.jouleURL, message: 'Joule A2A connection established' };
      } catch (e) {
        return { ok: false, connected: false, message: 'Joule connection failed: ' + e.message };
      }
    }
  },

  joule_agent_invoke: {
    name: 'joule_agent_invoke',
    description: 'Invoke a custom Joule agent/skill for complex multi-step workflows',
    parameters: { agentId: 'string (required) - Joule agent/skill ID', input: 'object (required) - Input parameters for the agent', config: 'object (required) - Joule configuration' },
    handler: async (params) => {
      const cfg = loadJouleConfig(params.config);
      if (!cfg.jouleURL) return { ok: false, error: 'Joule endpoint not configured.' };
      // A2A agent invocation
      const a2aPayload = {
        jsonrpc: '2.0',
        method: 'agent/invoke',
        params: { agentId: params.agentId, input: params.input },
        id: Date.now().toString()
      };
      return await sendA2ARequest(cfg, a2aPayload);
    }
  }
};

// ====== Joule A2A Protocol ======
const JOULE_CONFIG_FILE = path.join(__dirname, 'data', 'joule-config.json');

function loadJouleConfig(providedConfig) {
  let stored = {};
  try {
    if (fs.existsSync(JOULE_CONFIG_FILE)) stored = JSON.parse(fs.readFileSync(JOULE_CONFIG_FILE, 'utf8'));
  } catch {}
  return {
    jouleURL: providedConfig?.jouleURL || stored.jouleURL || process.env.JOULE_URL || '',
    clientId: providedConfig?.clientId || stored.clientId || process.env.JOULE_CLIENT_ID || '',
    clientSecret: providedConfig?.clientSecret || stored.clientSecret || process.env.JOULE_CLIENT_SECRET || '',
    tokenURL: providedConfig?.tokenURL || stored.tokenURL || process.env.JOULE_TOKEN_URL || '',
  };
}

async function getJouleToken(cfg) {
  if (!cfg.tokenURL || !cfg.clientId || !cfg.clientSecret) return null;
  return new Promise((resolve) => {
    const body = 'grant_type=client_credentials&client_id=' + encodeURIComponent(cfg.clientId) + '&client_secret=' + encodeURIComponent(cfg.clientSecret);
    const u = new URL(cfg.tokenURL);
    const opts = {
      hostname: u.hostname, port: 443, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      rejectUnauthorized: false, timeout: 15000
    };
    const req = https.request(opts, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { const j = JSON.parse(d); resolve(j.access_token || null); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

function sendA2ARequest(cfg, payload) {
  return new Promise((resolve) => {
    const u = new URL(cfg.jouleURL);
    const body = JSON.stringify(payload);
    const opts = {
      hostname: u.hostname, port: 443, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      rejectUnauthorized: false, timeout: 60000
    };
    const req = https.request(opts, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          resolve({ ok: res.statusCode < 400, status: res.statusCode, data: j.result || j });
        } catch { resolve({ ok: false, status: res.statusCode, raw: d.slice(0, 1000) }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(body); req.end();
  });
}

async function callJouleA2A(cfg, query) {
  // A2A tasks/send protocol
  const payload = {
    jsonrpc: '2.0',
    method: 'tasks/send',
    params: {
      id: 'joule-' + Date.now(),
      message: { role: 'user', parts: [{ type: 'text', text: query }] }
    },
    id: Date.now().toString()
  };

  // Try with OAuth token first
  const token = await getJouleToken(cfg);
  if (token) {
    const u = new URL(cfg.jouleURL);
    const body = JSON.stringify(payload);
    const opts = {
      hostname: u.hostname, port: 443, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'Content-Length': Buffer.byteLength(body) },
      rejectUnauthorized: false, timeout: 60000
    };
    return new Promise((resolve) => {
      const req = https.request(opts, (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(d);
            const result = j.result || j;
            const answer = result.output?.message?.parts?.[0]?.text || result.answer || result.message || JSON.stringify(result).slice(0, 2000);
            resolve({ ok: true, query, answer, source: 'SAP Joule', timestamp: new Date().toISOString() });
          } catch { resolve({ ok: false, error: 'Joule response parse error', raw: d.slice(0, 500) }); }
        });
      });
      req.on('error', (e) => resolve({ ok: false, error: 'Joule connection error: ' + e.message }));
      req.write(body); req.end();
    });
  }

  // Fallback: direct A2A call without OAuth
  return await sendA2ARequest(cfg, payload);
}

function formatSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}

// ====== HTTP Server ======
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.end('{}');
  if (req.method === 'GET' && req.url === '/tools') {
    const list = Object.values(tools).map(t => ({ name: t.name, description: t.description, parameters: t.parameters || 'none' }));
    return res.end(JSON.stringify({ ok: true, tools: list }));
  }

  if (req.method === 'POST' && req.url === '/call') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { tool, params } = JSON.parse(body);
        if (!tools[tool]) return res.end(JSON.stringify({ ok: false, error: 'Unknown tool: ' + tool }));
        const result = await tools[tool].handler(params || {});
        res.end(JSON.stringify(result));
      } catch (e) { res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
  }

  res.end(JSON.stringify({ name: 'Focus MCP Server', tools: Object.keys(tools), usage: { list: 'GET /tools', call: 'POST /call {tool, params}' } }));
});

server.listen(MCP_PORT, () => {
  console.log('MCP Server running on port', MCP_PORT);
  console.log('Tools:', Object.keys(tools).join(', '));
});
