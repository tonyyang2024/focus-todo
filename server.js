const express = require('express');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const compression = require('compression');
const SftpClient = require('ssh2-sftp-client');
const db = require('./db');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const SFTP_CONFIG_FILE = path.join(__dirname, 'data', 'sftp-config.json');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'focus-todo-secret-change-in-production';
const JWT_EXPIRY = '7d';

const app = express();
app.use(compression());
app.use(express.json());

// Cache static assets (1 hour for HTML, 1 week for others)
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    } else if (filePath.match(/\.(js|css|png|jpg|svg|ico|json)$/)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }
  }
}));

// --- Auth middleware ---
function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '请先登录' });
  }
  try {
    req.user = jwt.verify(header.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

function adminRequired(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '仅管理员可操作' });
  }
  next();
}

// --- Auth routes ---
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });

  const user = db.getUserByUsername(username);
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });

  if (!db.verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );

  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role },
    pomodoroToday: db.getTodayPomodoroCount(user.id)
  });
});

app.get('/api/auth/me', authRequired, (req, res) => {
  const user = db.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ ...user, pomodoroToday: db.getTodayPomodoroCount(user.id) });
});

app.post('/api/auth/change-password', authRequired, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const user = db.getUserByUsername(req.user.username);
  if (!db.verifyPassword(oldPassword, user.password_hash)) {
    return res.status(400).json({ error: '原密码错误' });
  }
  db.updatePassword(req.user.id, newPassword);
  res.json({ message: '密码修改成功' });
});

// --- User management (admin only) ---
app.get('/api/users', authRequired, adminRequired, (req, res) => {
  res.json(db.listUsers());
});

app.post('/api/auth/register', authRequired, adminRequired, (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (username.length < 2) return res.status(400).json({ error: '用户名至少2个字符' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6个字符' });

  const existing = db.getUserByUsername(username);
  if (existing) return res.status(400).json({ error: '用户名已存在' });

  const newUser = db.createUser(username, password, role);
  res.status(201).json({ id: newUser.id, username: newUser.username, role: newUser.role });
});

app.delete('/api/users/:id', authRequired, adminRequired, (req, res) => {
  const target = db.getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  if (target.role === 'admin') return res.status(400).json({ error: '不能删除管理员' });
  db.deleteUser(req.params.id);
  res.json({ message: '用户已删除' });
});

// --- Task routes ---
app.get('/api/tasks', authRequired, (req, res) => {
  const { timeframe } = req.query;
  const tasks = db.getTasks(req.user.id, timeframe || null);
  res.json(tasks.map(t => ({ ...t, completed: !!t.completed })));
});

app.post('/api/tasks', authRequired, (req, res) => {
  const { title, quadrant, timeframe } = req.body;
  if (!title || !quadrant || !timeframe) {
    return res.status(400).json({ error: '缺少必要字段' });
  }
  const task = db.createTask({
    id: Date.now().toString() + Math.random().toString(36).slice(2, 8),
    user_id: req.user.id,
    title,
    quadrant,
    timeframe,
    completed: false,
    created_at: new Date().toISOString()
  });
  res.status(201).json({ ...task, completed: !!task.completed });
});

app.patch('/api/tasks/:id', authRequired, (req, res) => {
  const updated = db.updateTask(req.params.id, req.user.id, req.body);
  if (!updated) return res.status(404).json({ error: '任务不存在' });
  res.json({ ...updated, completed: !!updated.completed });
});

app.delete('/api/tasks/:id', authRequired, (req, res) => {
  const ok = db.deleteTask(req.params.id, req.user.id);
  if (!ok) return res.status(404).json({ error: '任务不存在' });
  res.json({ message: '已删除' });
});

// --- Pomodoro ---
app.post('/api/pomodoro/increment', authRequired, (req, res) => {
  const count = db.incrementPomodoro(req.user.id);
  res.json({ todaySessions: count });
});

app.get('/api/pomodoro/count', authRequired, (req, res) => {
  res.json({ todaySessions: db.getTodayPomodoroCount(req.user.id) });
});

// --- SFTP Config ---
app.get('/api/sftp/config', (req, res) => {
  try {
    if (fs.existsSync(SFTP_CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(SFTP_CONFIG_FILE, 'utf8'));
      if (cfg.password) cfg.password = '********';
      res.json(cfg);
    } else {
      res.json({ host: '', port: 22, username: '', password: '', remotePath: '/uploads' });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sftp/config', express.json(), (req, res) => {
  try {
    const { host, port, username, password, remotePath } = req.body;
    const cfg = { host, port: port || 22, username, remotePath: remotePath || '/uploads' };
    // Only update password if a new one is provided
    if (password && password !== '********') cfg.password = password;
    else {
      const existing = fs.existsSync(SFTP_CONFIG_FILE) ? JSON.parse(fs.readFileSync(SFTP_CONFIG_FILE, 'utf8')) : {};
      cfg.password = existing.password || '';
    }
    fs.writeFileSync(SFTP_CONFIG_FILE, JSON.stringify(cfg, null, 2));
    res.json({ message: '配置已保存' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sftp/test', express.json(), async (req, res) => {
  const sftp = new SftpClient();
  try {
    const cfg = getSftpConfig(req.body);
    await sftp.connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password });
    const list = await sftp.list(cfg.remotePath);
    await sftp.end();
    res.json({ ok: true, files: list.length, message: '连接成功！目录下有 ' + list.length + ' 个文件' });
  } catch (e) {
    try { await sftp.end(); } catch {}
    res.json({ ok: false, message: '连接失败: ' + e.message });
  }
});

// --- SFTP Upload ---
app.post('/api/sftp/upload', upload.array('files', 50), async (req, res) => {
  const sftp = new SftpClient();
  const results = [];
  try {
    const cfg = getSftpConfig(req.body);
    await sftp.connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password });

    // Ensure remote path exists (create recursively)
    await ensureDir(sftp, cfg.remotePath);

    for (const file of req.files) {
      try {
        const remoteFile = cfg.remotePath.replace(/\/$/, '') + '/' + (req.body.prefix || '') + file.originalname;
        await sftp.put(file.buffer, remoteFile);
        results.push({ name: file.originalname, size: file.size, status: 'ok' });
      } catch (e) {
        results.push({ name: file.originalname, size: file.size, status: 'error', error: e.message });
      }
    }
    await sftp.end();
    res.json({ results });
  } catch (e) {
    try { await sftp.end(); } catch {}
    res.status(500).json({ error: 'SFTP 连接失败: ' + e.message });
  }
});

function getSftpConfig(body) {
  const fileCfg = fs.existsSync(SFTP_CONFIG_FILE) ? JSON.parse(fs.readFileSync(SFTP_CONFIG_FILE, 'utf8')) : {};
  return {
    host: body.host || fileCfg.host || '',
    port: parseInt(body.port) || fileCfg.port || 22,
    username: body.username || fileCfg.username || '',
    password: body.password || fileCfg.password || '',
    remotePath: body.remotePath || fileCfg.remotePath || '/uploads'
  };
}

async function ensureDir(sftp, dirPath) {
  const parts = dirPath.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += '/' + part;
    try { await sftp.mkdir(current); } catch {}
  }
}

// --- AgentDB Memory ---
app.post('/api/memory/save', express.json(), (req, res) => {
  try {
    const { key, value, tags } = req.body;
    if (!key || !value) return res.status(400).json({ error: 'key and value required' });
    db.saveMemory(key, value, tags || []);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/memory/search', (req, res) => {
  try {
    const rows = db.searchMemory(req.query.q || '');
    res.json(rows.map(r => ({ key: r.key, value: JSON.parse(r.value), tags: r.tags, updatedAt: r.updated_at })));
  } catch (e) { res.json([]); }
});

app.get('/api/memory/keys', (req, res) => {
  try {
    const rows = db.listMemoryKeys();
    res.json(rows.map(r => ({ key: r.key, tags: r.tags, updatedAt: r.updated_at })));
  } catch (e) { res.json([]); }
});

app.delete('/api/memory/:key', (req, res) => {
  try { db.deleteMemory(req.params.key); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Knowledge Base ---
app.get('/api/kb/search', (req, res) => {
  try {
    const { q, tag } = req.query;
    let rows = db.listMemoryKeys();
    if (q) rows = db.searchMemory(q);
    if (tag) rows = rows.filter(r => (r.tags || '').includes(tag));
    res.json(rows.map(r => ({ key: r.key, tags: r.tags, updatedAt: r.updated_at })));
  } catch (e) { res.json([]); }
});

app.get('/api/kb/:key', (req, res) => {
  try {
    const results = db.searchMemory(req.params.key);
    res.json(results[0] ? { key: results[0].key, value: JSON.parse(results[0].value), tags: results[0].tags } : null);
  } catch (e) { res.status(404).json({ error: 'Not found' }); }
});

// --- Task Queue ---
app.get('/api/tasks/queue', (req, res) => {
  try { res.json(db.searchMemory('task:').map(r => ({ id: r.key, ...JSON.parse(r.value), tags: r.tags }))); }
  catch (e) { res.json([]); }
});

app.post('/api/tasks/queue', express.json(), (req, res) => {
  try {
    const { title, description, priority, skill } = req.body;
    const id = 'task:' + Date.now();
    db.saveMemory(id, { title, description, priority: priority || 'normal', skill, status: 'pending', createdAt: new Date().toISOString() }, ['task', 'pending']);
    res.status(201).json({ id, status: 'pending' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/tasks/queue/:id', express.json(), (req, res) => {
  try {
    const rows = db.searchMemory(req.params.id);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const task = JSON.parse(rows[0].value);
    Object.assign(task, req.body);
    db.saveMemory(req.params.id, task, ['task', task.status || 'pending']);
    res.json(task);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- SAP Inventory Upload (Node.js, zero Python) ---
const inventoryUpload = require('./inventory-upload');
const INVENTORY_UPLOAD_DIR = path.join(__dirname, 'data', 'inventory-uploads');
const SAP_CONFIG_FILE = path.join(__dirname, 'data', 'sap-config.json');

app.get('/api/inventory/config', (req, res) => {
  try {
    if (fs.existsSync(SAP_CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(SAP_CONFIG_FILE, 'utf8'));
      res.json({ url: cfg.url || '', username: cfg.username || '', password: '' }); // hide password
    } else {
      res.json({ url: '', username: '', password: '' });
    }
  } catch (e) { res.json({ url: '', username: '', password: '' }); }
});

app.post('/api/inventory/config', express.json(), (req, res) => {
  try {
    const { url, username, password } = req.body;
    const cfg = { url: url || '', username: username || '' };
    if (password && password !== '********') cfg.password = password;
    else if (fs.existsSync(SAP_CONFIG_FILE)) {
      cfg.password = JSON.parse(fs.readFileSync(SAP_CONFIG_FILE, 'utf8')).password || '';
    }
    fs.writeFileSync(SAP_CONFIG_FILE, JSON.stringify(cfg, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/inventory/upload', upload.single('file'), async (req, res) => {
  try {
    if (!fs.existsSync(INVENTORY_UPLOAD_DIR)) fs.mkdirSync(INVENTORY_UPLOAD_DIR, { recursive: true });
    const ts = Date.now();
    const excelPath = path.join(INVENTORY_UPLOAD_DIR, `upload_${ts}_${req.file.originalname}`);
    fs.writeFileSync(excelPath, req.file.buffer);

    const sheetName = req.body.sheetName || 'InventoryUploadTemplate';
    const { summary, successDocs, failedDocs, jsonFile, xlsxFile } = await inventoryUpload.run(excelPath, sheetName, INVENTORY_UPLOAD_DIR);

    // Save result JSON with consistent naming for history API
    const resultJson = { summary, success: successDocs, failed: failedDocs };
    fs.writeFileSync(path.join(INVENTORY_UPLOAD_DIR, `result_${ts}.json`), JSON.stringify(resultJson, null, 2));

    res.json({ ok: true, summary, success: successDocs, failed: failedDocs });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/inventory/history', (req, res) => {
  try {
    if (!fs.existsSync(INVENTORY_UPLOAD_DIR)) return res.json([]);
    const files = fs.readdirSync(INVENTORY_UPLOAD_DIR)
      .filter(f => f.startsWith('result_') && f.endsWith('.json'))
      .map(f => {
        const data = JSON.parse(fs.readFileSync(path.join(INVENTORY_UPLOAD_DIR, f), 'utf8'));
        data._id = f.replace('result_', '').replace('.json', '');
        data._time = new Date(parseInt(data._id)).toISOString();
        return data;
      })
      .sort((a, b) => b._id.localeCompare(a._id));
    res.json(files);
  } catch (e) { res.json([]); }
});

app.delete('/api/inventory/history', (req, res) => {
  try {
    if (fs.existsSync(INVENTORY_UPLOAD_DIR)) {
      fs.readdirSync(INVENTORY_UPLOAD_DIR).forEach(f => {
        fs.unlinkSync(path.join(INVENTORY_UPLOAD_DIR, f));
      });
    }
    res.json({ ok: true, message: 'History cleared' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/inventory/download/:id', (req, res) => {
  const xlsxFile = path.join(INVENTORY_UPLOAD_DIR, `inventory_upload_result_${req.params.id}.xlsx`);
  const jsonFile = path.join(INVENTORY_UPLOAD_DIR, `result_${req.params.id}.json`);
  if (fs.existsSync(xlsxFile)) res.download(xlsxFile);
  else if (fs.existsSync(jsonFile)) res.download(jsonFile);
  else res.status(404).json({ error: 'File not found' });
});

// --- Workbench: Build & Execute ---
const WORKBENCH_DIR = path.join(__dirname, 'public', 'builds');

app.post('/api/workbench/build', express.json(), (req, res) => {
  try {
    const { code, filename } = req.body;
    if (!code || !filename) return res.status(400).json({ error: 'code and filename required' });
    if (!fs.existsSync(WORKBENCH_DIR)) fs.mkdirSync(WORKBENCH_DIR, { recursive: true });
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(WORKBENCH_DIR, safeName);
    fs.writeFileSync(filePath, code, 'utf8');
    const url = '/builds/' + safeName;
    res.json({ ok: true, url, path: filePath });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Joule Config ---
app.post('/api/joule/config', express.json(), (req, res) => {
  try {
    const { baseURL, username, password } = req.body;
    const cfg = { baseURL: baseURL || '', username: username || '' };
    if (password && password !== '********') cfg.password = password;
    else {
      const existing = fs.existsSync(JOULE_CONFIG_FILE) ? JSON.parse(fs.readFileSync(JOULE_CONFIG_FILE, 'utf8')) : {};
      cfg.password = existing.password || '';
    }
    fs.writeFileSync(JOULE_CONFIG_FILE, JSON.stringify(cfg, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/joule/config', (req, res) => {
  try {
    if (fs.existsSync(JOULE_CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(JOULE_CONFIG_FILE, 'utf8'));
      cfg.password = cfg.password ? '********' : '';
      res.json(cfg);
    } else res.json({ baseURL: '', username: '', password: '' });
  } catch (e) { res.json({ baseURL: '', username: '', password: '' }); }
});

const JOULE_CONFIG_FILE = path.join(__dirname, 'data', 'joule-config.json');

// --- BTP Deploy ---
const BTP_BUILDS_DIR = path.join(__dirname, 'data', 'btp-builds');

app.post('/api/btp/deploy', express.json(), async (req, res) => {
  try {
    const { code, appName, config: btpCfg } = req.body;
    if (!code || !btpCfg || !btpCfg.api) return res.status(400).json({ ok: false, error: 'Missing code or BTP config' });

    if (!fs.existsSync(BTP_BUILDS_DIR)) fs.mkdirSync(BTP_BUILDS_DIR, { recursive: true });
    const buildId = Date.now().toString();
    const buildDir = path.join(BTP_BUILDS_DIR, buildId);
    fs.mkdirSync(buildDir, { recursive: true });

    const safeName = (appName || 'fiori-app').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 50);

    // Generate BTP package
    const manifest = { _version: '1.12.0', 'sap.app': { id: safeName, applicationVersion: { version: '1.0.0' } }, 'sap.ui5': { rootView: { viewName: safeName.replace(/-/g, '.') + '.Main', type: 'XML', async: true }, dependencies: { minUI5Version: '1.108.0', libs: { 'sap.m': {} } }, contentDensities: { compact: true, cozy: true } } };
    const xsApp = { welcomeFile: 'index.html', routes: [{ source: '/(.*)', localDir: '.' }] };
    const pkgJson = { name: safeName, version: '1.0.0', scripts: { start: 'npx serve .' } };

    fs.writeFileSync(path.join(buildDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(buildDir, 'xs-app.json'), JSON.stringify(xsApp, null, 2));
    fs.writeFileSync(path.join(buildDir, 'package.json'), JSON.stringify(pkgJson, null, 2));
    fs.writeFileSync(path.join(buildDir, 'index.html'), code);
    fs.writeFileSync(path.join(buildDir, 'README.md'), `# ${safeName}\nDeployed from Workbench at ${new Date().toISOString()}`);

    // Try CF deploy if credentials provided
    let cfResult = null;
    if (btpCfg.user && btpCfg.pass && btpCfg.org && btpCfg.space) {
      try {
        cfResult = await cfDeploy(buildDir, btpCfg, safeName);
      } catch (e) {
        cfResult = { ok: false, error: e.message };
      }
    }

    // Package as zip for download
    const zipFile = path.join(BTP_BUILDS_DIR, `${safeName}.zip`);
    const { execSync } = require('child_process');
    try {
      execSync(`cd "${BTP_BUILDS_DIR}" && tar -czf "${safeName}.tar.gz" -C "${buildId}" .`, { stdio: 'pipe' });
    } catch {}

    const localUrl = `/api/btp/download/${safeName}`;
    res.json({
      ok: true,
      buildId,
      packageUrl: localUrl,
      files: ['manifest.json', 'xs-app.json', 'package.json', 'index.html', 'README.md'],
      cfDeploy: cfResult,
      instructions: cfResult?.ok
        ? `Deployed to BTP: ${cfResult.url}`
        : `1. Download package\n2. Open SAP Business Application Studio\n3. Import project from archive\n4. Deploy to BTP Cloud Foundry\n\nOr use cf CLI:\ncf login -a ${btpCfg.api}\ncf push ${safeName} -p ${buildDir}`
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

async function cfDeploy(buildDir, cfg, appName) {
  const https = require('https');
  // CF Login
  const loginData = JSON.stringify({ grant_type: 'password', username: cfg.user, password: cfg.pass, client_id: 'cf', client_secret: '' });
  const tokenRes = await cfApiRequest(cfg.api, '/oauth/token', 'POST', loginData, 'application/x-www-form-urlencoded');
  if (!tokenRes.ok) throw new Error('CF login failed: ' + (tokenRes.error || 'invalid credentials'));

  const token = tokenRes.data.access_token;
  // Create app
  const appRes = await cfApiRequest(cfg.api, '/v3/apps', 'POST', JSON.stringify({ name: appName, relationships: { space: { data: { guid: cfg.space } } }, lifecycle: { type: 'buildpack', data: { buildpacks: ['staticfile_buildpack'] } } }), 'application/json', token);
  if (!appRes.ok && !appRes.data?.errors?.some(e => e.title === 'CF-AppAlreadyExists')) throw new Error('CF create app failed: ' + JSON.stringify(appRes.data).slice(0, 200));

  return { ok: true, url: `https://${appName}.cfapps.${new URL(cfg.api).hostname.split('.').slice(1).join('.')}` };
}

function cfApiRequest(api, path, method, body, contentType, token) {
  return new Promise((resolve) => {
    const u = new URL(api);
    const opts = {
      hostname: u.hostname, port: 443, path, method,
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) },
      rejectUnauthorized: false, timeout: 30000
    };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode < 400, data: JSON.parse(d) }); }
        catch { resolve({ ok: false, error: d.slice(0, 200) }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(body); req.end();
  });
}

app.get('/api/btp/download/:name', (req, res) => {
  const tgz = path.join(BTP_BUILDS_DIR, req.params.name + '.tar.gz');
  const zip = path.join(BTP_BUILDS_DIR, req.params.name + '.zip');
  if (fs.existsSync(tgz)) return res.download(tgz);
  if (fs.existsSync(zip)) return res.download(zip);
  res.status(404).json({ error: 'Package not found' });
});

// --- Route fallbacks ---
app.get('/todolist', (req, res) => res.redirect('/todolist/'));
app.get('/todolist/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'todolist', 'index.html')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await db.init();
  app.listen(PORT, () => {
    console.log(`Focus Todo running at http://localhost:${PORT}`);
  });
  // Also start MCP server
  try { require('./mcp-server'); } catch {}
}
start();
