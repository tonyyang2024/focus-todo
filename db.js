const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'todo.db');

let db;
let saveTimer;

async function init() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      quadrant INTEGER NOT NULL CHECK(quadrant BETWEEN 1 AND 4),
      timeframe TEXT NOT NULL CHECK(timeframe IN ('daily','weekly','monthly')),
      completed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS pomodoro_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, date)
    )
  `);

  save();

  // Seed admin
  const adminRow = queryOne('SELECT id FROM users WHERE username = ?', ['admin']);
  if (!adminRow) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.run('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', ['admin', hash, 'admin']);
    save();
    console.log('Default admin created: admin / admin123');
  }

  return db;
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }, 100);
}

function saveSync() {
  clearTimeout(saveTimer);
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// --- Query helpers ---
function queryOne(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function queryAll(sql, params = []) {
  const rows = [];
  const stmt = db.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function run(sql, params = []) {
  db.run(sql, params);
  save();
}

function lastInsertRowid() {
  const row = queryOne('SELECT last_insert_rowid() AS id');
  return row ? row.id : null;
}

// --- User operations ---
function createUser(username, password, role) {
  const hash = bcrypt.hashSync(password, 10);
  run('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [username, hash, role || 'user']);
  const id = lastInsertRowid();
  return { id, username, role: role || 'user' };
}

function getUserByUsername(username) {
  return queryOne('SELECT * FROM users WHERE username = ?', [username]);
}

function getUserById(id) {
  return queryOne('SELECT id, username, role, created_at FROM users WHERE id = ?', [id]);
}

function listUsers() {
  return queryAll('SELECT id, username, role, created_at FROM users ORDER BY id');
}

function deleteUser(id) {
  run('DELETE FROM users WHERE id = ? AND role != ?', [id, 'admin']);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

function updatePassword(userId, newPassword) {
  const hash = bcrypt.hashSync(newPassword, 10);
  run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);
}

// --- Task operations ---
function getTasks(userId, timeframe) {
  if (timeframe) {
    return queryAll('SELECT * FROM tasks WHERE user_id = ? AND timeframe = ? ORDER BY created_at DESC', [userId, timeframe]);
  }
  return queryAll('SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC', [userId]);
}

function createTask(task) {
  run(
    'INSERT INTO tasks (id, user_id, title, quadrant, timeframe, completed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [task.id, task.user_id, task.title, task.quadrant, task.timeframe, task.completed ? 1 : 0, task.created_at || new Date().toISOString()]
  );
  return getTaskById(task.id);
}

function getTaskById(id) {
  return queryOne('SELECT * FROM tasks WHERE id = ?', [id]);
}

function updateTask(id, userId, updates) {
  const task = queryOne('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [id, userId]);
  if (!task) return null;
  const completed = updates.completed !== undefined ? (updates.completed ? 1 : 0) : task.completed;
  const title = updates.title !== undefined ? updates.title : task.title;
  const quadrant = updates.quadrant !== undefined ? updates.quadrant : task.quadrant;
  const timeframe = updates.timeframe !== undefined ? updates.timeframe : task.timeframe;
  run('UPDATE tasks SET title=?, quadrant=?, timeframe=?, completed=? WHERE id=? AND user_id=?',
    [title, quadrant, timeframe, completed, id, userId]);
  return getTaskById(id);
}

function deleteTask(id, userId) {
  const before = queryOne('SELECT id FROM tasks WHERE id = ? AND user_id = ?', [id, userId]);
  if (!before) return false;
  run('DELETE FROM tasks WHERE id = ? AND user_id = ?', [id, userId]);
  return true;
}

// --- Pomodoro ---
function getTodayPomodoroCount(userId) {
  const today = new Date().toDateString();
  const row = queryOne('SELECT count FROM pomodoro_sessions WHERE user_id = ? AND date = ?', [userId, today]);
  return row ? row.count : 0;
}

function incrementPomodoro(userId) {
  const today = new Date().toDateString();
  const existing = queryOne('SELECT id FROM pomodoro_sessions WHERE user_id = ? AND date = ?', [userId, today]);
  if (existing) {
    run('UPDATE pomodoro_sessions SET count = count + 1 WHERE user_id = ? AND date = ?', [userId, today]);
  } else {
    run('INSERT INTO pomodoro_sessions (user_id, date, count) VALUES (?, ?, 1)', [userId, today]);
  }
  return getTodayPomodoroCount(userId);
}

module.exports = {
  init,
  createUser, getUserByUsername, getUserById, listUsers, deleteUser,
  verifyPassword, updatePassword,
  getTasks, createTask, updateTask, deleteTask,
  getTodayPomodoroCount, incrementPomodoro
};
