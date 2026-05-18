const express = require('express');
const jwt = require('jsonwebtoken');
const path = require('path');
const db = require('./db');

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
