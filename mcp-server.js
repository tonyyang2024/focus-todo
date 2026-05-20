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
  }
};

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
