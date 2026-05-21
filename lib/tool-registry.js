// Tool Registry — tool definitions with allowlist enforcement
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORKSPACE = process.env.WORKSPACE || __dirname.replace(/\\/g, '/').replace(/\/lib$/, '');

let permissions = { allow: [], deny: [] };
try {
  const settingsPath = path.join(WORKSPACE, '.claude', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (settings.permissions) permissions = settings.permissions;
  }
} catch {}

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read file contents. Returns the file text with line numbers.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to read' }
      },
      required: ['file_path']
    },
    handler: async (params) => {
      const fp = params.file_path;
      if (!fp) return { ok: false, error: 'file_path required' };
      if (!fs.existsSync(fp)) return { ok: false, error: 'File not found: ' + fp };
      const stat = fs.statSync(fp);
      if (stat.isDirectory()) return { ok: false, error: 'Path is a directory' };
      if (stat.size > 1024 * 1024) return { ok: false, error: 'File too large (>1MB)' };
      const content = fs.readFileSync(fp, 'utf8');
      const lines = content.split('\n');
      const numbered = lines.map((l, i) => `${String(i + 1).padStart(4, ' ')}\t${l}`).join('\n');
      return { ok: true, path: fp, size: stat.size, lines: lines.length, content: numbered };
    }
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates parent directories if needed. Overwrites existing files.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to write' },
        content: { type: 'string', description: 'Content to write to the file' }
      },
      required: ['file_path', 'content']
    },
    handler: async (params) => {
      if (!isAllowed('write_file', params)) return { ok: false, error: 'Operation not allowed' };
      const fp = params.file_path;
      const dir = path.dirname(fp);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fp, params.content, 'utf8');
      return { ok: true, path: fp, size: Buffer.byteLength(params.content, 'utf8') };
    }
  },
  {
    name: 'edit_file',
    description: 'Replace a string in a file with a new string. The old_string must be unique in the file.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to edit' },
        old_string: { type: 'string', description: 'The exact text to replace' },
        new_string: { type: 'string', description: 'The replacement text' }
      },
      required: ['file_path', 'old_string', 'new_string']
    },
    handler: async (params) => {
      if (!isAllowed('write_file', params)) return { ok: false, error: 'Operation not allowed' };
      const fp = params.file_path;
      if (!fs.existsSync(fp)) return { ok: false, error: 'File not found: ' + fp };
      let content = fs.readFileSync(fp, 'utf8');
      if (!content.includes(params.old_string)) {
        return { ok: false, error: 'old_string not found in file (must be exact match)' };
      }
      const count = content.split(params.old_string).length - 1;
      if (count > 1) {
        return { ok: false, error: `old_string appears ${count} times — must be unique` };
      }
      content = content.replace(params.old_string, params.new_string);
      fs.writeFileSync(fp, content, 'utf8');
      return { ok: true, path: fp };
    }
  },
  {
    name: 'bash_exec',
    description: 'Execute a bash command. Commands are checked against allow/deny lists. Timeout: 2 minutes.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' }
      },
      required: ['command']
    },
    handler: async (params) => {
      if (!isAllowed('bash_exec', params)) return { ok: false, error: 'Command not allowed: ' + params.command };
      try {
        const opts = { cwd: WORKSPACE, timeout: 120000, encoding: 'utf8', maxBuffer: 1024 * 1024 };
        const stdout = execSync(params.command, opts);
        return { ok: true, stdout: stdout.slice(0, 50000), stderr: '' };
      } catch (e) {
        return { ok: false, error: e.message, stdout: (e.stdout || '').slice(0, 10000), stderr: (e.stderr || '').slice(0, 10000) };
      }
    }
  },
  {
    name: 'glob_search',
    description: 'Find files matching a glob pattern (e.g. "**/*.js", "src/**/*.ts"). Returns matching file paths.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match' },
        path: { type: 'string', description: 'Directory to search in (default: workspace root)' }
      },
      required: ['pattern']
    },
    handler: async (params) => {
      const dir = params.path || WORKSPACE;
      const { globSync } = require('glob');
      try {
        const files = globSync(params.pattern, { cwd: dir, nodir: true, ignore: ['node_modules/**', '.git/**'] });
        return { ok: true, count: files.length, files: files.slice(0, 100) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  },
  {
    name: 'grep_search',
    description: 'Search file contents by regex pattern. Returns matching lines with file paths.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression pattern to search for' },
        path: { type: 'string', description: 'File or directory to search in (default: workspace root)' },
        glob: { type: 'string', description: 'Optional glob filter for files (e.g. "*.js")' }
      },
      required: ['pattern']
    },
    handler: async (params) => {
      try {
        // Use the installed grep/ripgrep if available
        const dir = params.path || WORKSPACE;
        let cmd = `cd "${dir}" && grep -rn --include="${params.glob || '*'}" "${params.pattern.replace(/"/g, '\\"')}" . 2>nul | head -100`;
        const stdout = execSync(cmd, { cwd: dir, timeout: 30000, encoding: 'utf8', maxBuffer: 500000 });
        return { ok: true, matches: stdout.slice(0, 10000) };
      } catch (e) {
        return { ok: false, error: e.message, stdout: (e.stdout || '').slice(0, 5000) };
      }
    }
  },
  {
    name: 'web_search',
    description: 'Search the web using WebSearch. Returns formatted results with links.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' }
      },
      required: ['query']
    },
    handler: async (params) => {
      if (!isAllowed('web_search', params)) return { ok: false, error: 'WebSearch not allowed' };
      return { ok: true, note: 'web_search must be handled by the calling agent via WebSearch tool', query: params.query };
    }
  },
  {
    name: 'web_fetch',
    description: 'Fetch content from a URL. Returns text content (HTML tags stripped, max 5000 chars).',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' }
      },
      required: ['url']
    },
    handler: async (params) => {
      if (!isAllowed('web_fetch', params)) return { ok: false, error: 'WebFetch not allowed' };
      const { get } = require(params.url.startsWith('https') ? 'https' : 'http');
      return new Promise((resolve) => {
        get(params.url, { timeout: 15000, rejectUnauthorized: false }, (res) => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => {
            const text = d.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
            resolve({ ok: true, status: res.statusCode, text, length: text.length });
          });
        }).on('error', e => resolve({ ok: false, error: e.message }));
      });
    }
  },
  {
    name: 'list_files',
    description: 'List files in a directory. Returns filenames, sizes, and types.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (absolute, default: workspace root)' }
      },
      required: []
    },
    handler: async (params) => {
      const dir = params.path || WORKSPACE;
      if (!fs.existsSync(dir)) return { ok: false, error: 'Directory not found: ' + dir };
      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) return { ok: false, error: 'Path is not a directory' };
      const files = fs.readdirSync(dir).slice(0, 100).map(f => {
        try {
          const s = fs.statSync(path.join(dir, f));
          return { name: f, size: s.size, isDir: s.isDirectory(), modified: s.mtime.toISOString() };
        } catch { return { name: f }; }
      });
      return { ok: true, path: dir, count: files.length, files };
    }
  },
  {
    name: 'system_info',
    description: 'Get system information: platform, memory, uptime, node version.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    },
    handler: async () => {
      return {
        ok: true,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        uptime: Math.floor(process.uptime()),
        memory: Math.floor(process.memoryUsage().rss / 1024 / 1024) + ' MB',
        cwd: WORKSPACE
      };
    }
  },
  {
    name: 'search_kb',
    description: 'Search the knowledge base (agent_memory table). Returns matching entries by keyword.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keyword' },
        tag: { type: 'string', description: 'Optional tag filter' }
      },
      required: ['query']
    },
    handler: async (params) => {
      try {
        const db = require('../db');
        const results = db.searchMemory(params.query || '');
        return { ok: true, count: results.length, results: results.slice(0, 20).map(r => ({
          key: r.key,
          tags: r.tags,
          preview: (r.value || '').slice(0, 200)
        })) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  },
  {
    name: 'task_queue_list',
    description: 'List pending tasks from the task queue.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    },
    handler: async () => {
      try {
        const db = require('../db');
        const rows = db.searchMemory('task:');
        const tasks = rows.map(r => {
          try { return { id: r.key, ...JSON.parse(r.value), tags: r.tags }; }
          catch { return { id: r.key, tags: r.tags }; }
        });
        return { ok: true, count: tasks.length, tasks };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  },
  {
    name: 'task_queue_update',
    description: 'Update a task queue item (mark complete, update status, etc.).',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID (e.g., task:1234567890)' },
        status: { type: 'string', enum: ['pending', 'processing', 'completed', 'failed'], description: 'New status' },
        result: { type: 'string', description: 'Optional result text (for completed tasks)' }
      },
      required: ['task_id']
    },
    handler: async (params) => {
      try {
        const db = require('../db');
        const rows = db.searchMemory(params.task_id);
        if (!rows.length) return { ok: false, error: 'Task not found' };
        const task = JSON.parse(rows[0].value);
        if (params.status) task.status = params.status;
        if (params.result) task.result = params.result;
        db.saveMemory(params.task_id, task, ['task', task.status || 'pending']);
        return { ok: true, task: { id: params.task_id, ...task } };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  },
  {
    name: 'document_parse',
    description: 'Retrieve full text and metadata of a previously uploaded document by its docId. Use this when you need the complete content of a requirements document, specification, or reference file to generate accurate code.',
    parameters: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'Document ID from /api/documents/upload (e.g., "doc:1234567890:abc123")' }
      },
      required: ['docId']
    },
    handler: async (params) => {
      try {
        const docPath = path.join(WORKSPACE, 'data', 'documents', params.docId + '.json');
        if (!fs.existsSync(docPath)) return { ok: false, error: 'Document not found or expired' };
        const doc = JSON.parse(fs.readFileSync(docPath, 'utf8'));
        return { ok: true, text: doc.text, metadata: doc.metadata, fileName: doc.fileName };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  },
  {
    name: 'save_memory',
    description: 'Save a key-value entry to the knowledge base with optional tags.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Unique identifier' },
        value: { type: 'object', description: 'Value object to store' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' }
      },
      required: ['key', 'value']
    },
    handler: async (params) => {
      try {
        const db = require('../db');
        db.saveMemory(params.key, params.value, params.tags || []);
        return { ok: true, key: params.key };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  }
];

function isAllowed(toolName, params) {
  if (toolName === 'write_file' || toolName === 'edit_file') toolName = 'write_file';
  if (toolName === 'bash_exec') toolName = 'bash_exec';

  // Deny always takes priority
  for (const pattern of (permissions.deny || [])) {
    if (matchPermission(pattern, toolName, params)) return false;
  }

  // If allow list is empty, allow safe tools by default
  const explicitAllow = (permissions.allow || []).filter(p => p.startsWith('Bash') || p.startsWith('WebSearch') || p.startsWith('WebFetch') || p.startsWith('Read') || p.startsWith('Write') || p.startsWith('Edit'));
  if (explicitAllow.length === 0 && toolName !== 'bash_exec' && toolName !== 'web_search' && toolName !== 'web_fetch') {
    return true; // Safe read-only tools allowed by default
  }

  for (const pattern of (permissions.allow || [])) {
    if (matchPermission(pattern, toolName, params)) return true;
  }
  return false;
}

function matchPermission(pattern, toolName, params) {
  const pat = pattern.replace(/\(.*\)$/, '');
  const pLower = pat.toLowerCase();

  if (pLower === 'bash' && toolName === 'bash_exec') {
    if (pattern.includes('(') && pattern.includes(')')) {
      const argPattern = pattern.slice(pattern.indexOf('(') + 1, pattern.lastIndexOf(')'));
      if (argPattern === '*') return true;
      const cmd = (params.command || '').trim();
      // Match command prefix (e.g., "npm:*" matches "npm install", "npm test")
      if (argPattern.endsWith(':*')) {
        const prefix = argPattern.slice(0, -2);
        return cmd.startsWith(prefix + ' ') || cmd === prefix;
      }
      if (argPattern.endsWith('*')) {
        return cmd.startsWith(argPattern.slice(0, -1));
      }
      return cmd === argPattern || cmd.startsWith(argPattern + ' ');
    }
    return true;
  }
  if (pLower === 'read' && toolName === 'read_file') return true;
  if (pLower === 'write' && (toolName === 'write_file' || toolName === 'edit_file')) return true;
  if (pLower === 'edit' && toolName === 'edit_file') return true;
  if (pLower === 'websearch' && toolName === 'web_search') return true;
  if (pLower === 'webfetch' && toolName === 'web_fetch') return true;

  return false;
}

function getToolDefinitions() {
  return TOOLS.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }
  }));
}

function getSystemToolPrompt() {
  return TOOLS.map(t =>
    `- **${t.name}**: ${t.description} Params: ${JSON.stringify(t.parameters)}`
  ).join('\n');
}

async function executeTool(name, params) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  try {
    return await tool.handler(params);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { TOOLS, getToolDefinitions, getSystemToolPrompt, executeTool, isAllowed };
