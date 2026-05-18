const express = require('express');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const SftpClient = require('ssh2-sftp-client');
const db = require('./db');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const SFTP_CONFIG_FILE = path.join(__dirname, 'data', 'sftp-config.json');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'focus-todo-secret-change-in-production';
const JWT_EXPIRY = '7d';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// --- SPA fallback ---
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await db.init();
  app.listen(PORT, () => {
    console.log(`Focus Todo running at http://localhost:${PORT}`);
  });
}
start();
