const { Server } = require('ssh2');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.SFTP_PORT) || 2222;
const ROOT = path.resolve(process.env.SFTP_ROOT || 'H:\\sftp-storage');
const USERS_FILE = path.join(__dirname, 'data', 'sftp-users.json');

if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch {
    const pwd = crypto.randomBytes(6).toString('hex');
    const defaults = { sftpuser: { password: pwd, home: '/' } };
    fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(defaults, null, 2));
    console.log('Created user: sftpuser /', pwd);
    return defaults;
  }
}

function getHostKey() {
  const keyPath = path.join(__dirname, 'data', 'ssh_host_rsa_key');
  if (fs.existsSync(keyPath)) return fs.readFileSync(keyPath);
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  });
  fs.writeFileSync(keyPath, privateKey);
  return privateKey;
}

const users = loadUsers();

new Server({ hostKeys: [getHostKey()] }, (client) => {
  let username = '';

  client.on('authentication', (ctx) => {
    const u = users[ctx.username];
    if (ctx.method === 'none') return ctx.reject(['password']);
    if (ctx.method === 'password' && u && ctx.password === u.password) {
      username = ctx.username;
      ctx.accept();
    } else {
      ctx.reject();
    }
  });

  client.on('ready', () => {
    console.log('Connected:', username, client._sock.remoteAddress);
    client.on('session', (accept) => {
      const session = accept();
      session.on('sftp', (accept) => {
        const sftp = accept();
        setupSftp(sftp, username);
      });
    });
  });

  client.on('end', () => console.log('Disconnected:', username));
  client.on('error', () => {});
}).listen(PORT, () => {
  console.log('SFTP Server running on port', PORT);
  console.log('Root directory:', ROOT);
  const u = Object.keys(users)[0];
  console.log('Connect: sftp -P', PORT, u + '@<host>');
  console.log('Password:', users[u].password);
});

// --- CLI user management ---
if (process.argv.includes('--add-user')) {
  const idx = process.argv.indexOf('--add-user');
  const name = process.argv[idx + 1];
  const pass = process.argv[idx + 2] || crypto.randomBytes(6).toString('hex');
  if (!name) { console.log('Usage: node sftp-server.js --add-user <username> [password]'); process.exit(1); }
  const all = loadUsers();
  all[name] = { password: pass, home: '/' };
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(all, null, 2));
  console.log('User added:', name, '/', pass);
  process.exit(0);
}

if (process.argv.includes('--list-users')) {
  const all = loadUsers();
  console.log('Users:');
  Object.entries(all).forEach(([u, cfg]) => console.log(' ', u, cfg.home === '/' ? '(root)' : '(' + cfg.home + ')'));
  process.exit(0);
}

function resolvePath(username, p) {
  const cfg = users[username] || { home: '/' };
  const base = cfg.home === '/' ? ROOT : path.join(ROOT, cfg.home);
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
  const safe = p.replace(/^\/+/, '').replace(/\.\./g, '');
  const resolved = path.join(base, safe);
  return resolved.startsWith(path.resolve(ROOT)) ? resolved : base;
}

function fileAttrs(s) {
  return {
    mode: s.isDirectory() ? 0o40755 : 0o100644,
    size: s.size, uid: 0, gid: 0,
    atime: Math.floor(s.atimeMs / 1000),
    mtime: Math.floor(s.mtimeMs / 1000)
  };
}

const dirCache = {};
let dirHandleId = 100000;

function setupSftp(sftp, username) {
  sftp.on('OPEN', (reqId, filename, flags) => {
    const fp = resolvePath(username, filename);
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const access = (flags & 2) ? 'w' : 'r'; // 1=READ, 2=WRITE
    try {
      const fd = fs.openSync(fp, access);
      const handle = Buffer.alloc(4);
      handle.writeUInt32BE(fd, 0);
      sftp.handle(reqId, handle);
    } catch (e) {
      sftp.status(reqId, 4);
    }
  });

  sftp.on('WRITE', (reqId, handle, offset, data) => {
    try {
      fs.writeSync(handle.readUInt32BE(0), data, 0, data.length, offset);
      sftp.status(reqId, 0);
    } catch (e) { sftp.status(reqId, 4); }
  });

  sftp.on('READ', (reqId, handle, offset, length) => {
    const buf = Buffer.alloc(length);
    try {
      const n = fs.readSync(handle.readUInt32BE(0), buf, 0, length, offset);
      if (n === 0) sftp.status(reqId, 1);
      else sftp.data(reqId, buf.slice(0, n), 'utf8');
    } catch (e) { sftp.status(reqId, 4); }
  });

  sftp.on('CLOSE', (reqId, handle) => {
    const hid = handle.readUInt32BE(0);
    if (dirCache[hid] !== undefined) { delete dirCache[hid]; }
    else { try { fs.closeSync(hid); } catch {} }
    sftp.status(reqId, 0);
  });

  sftp.on('FSTAT', (reqId, handle) => {
    try {
      const s = fs.fstatSync(handle.readUInt32BE(0));
      sftp.attrs(reqId, fileAttrs(s));
    } catch (e) { sftp.status(reqId, 4); }
  });

  sftp.on('STAT', (reqId, p) => {
    try {
      const s = fs.statSync(resolvePath(username, p));
      sftp.attrs(reqId, fileAttrs(s));
    } catch (e) { sftp.status(reqId, 2); }
  });

  sftp.on('LSTAT', (reqId, p) => {
    try {
      const s = fs.lstatSync(resolvePath(username, p));
      sftp.attrs(reqId, fileAttrs(s));
    } catch (e) { sftp.status(reqId, 2); }
  });

  sftp.on('OPENDIR', (reqId, p) => {
    try {
      const dir = resolvePath(username, p);
      const names = fs.readdirSync(dir);
      const entries = names.map(name => {
        try {
          const st = fs.statSync(path.join(dir, name));
          return { filename: name, longname: name, attrs: fileAttrs(st) };
        } catch { return { filename: name, longname: name, attrs: {} }; }
      });
      const h = Buffer.alloc(4);
      const hid = ++dirHandleId;
      h.writeUInt32BE(hid, 0);
      dirCache[hid] = { entries, sent: false };
      sftp.handle(reqId, h);
    } catch (e) {
      sftp.status(reqId, 2);
    }
  });

  sftp.on('READDIR', (reqId, handle) => {
    const hid = handle.readUInt32BE(0);
    const cached = dirCache[hid];
    if (cached && !cached.sent) {
      cached.sent = true;
      sftp.name(reqId, cached.entries);
    } else {
      delete dirCache[hid];
      sftp.status(reqId, 1); // EOF
    }
  });

  sftp.on('SETSTAT', (reqId, p, attrs) => {
    try {
      if (attrs.mode !== undefined) fs.chmodSync(resolvePath(username, p), attrs.mode);
      sftp.status(reqId, 0);
    } catch (e) { sftp.status(reqId, 4); }
  });

  sftp.on('MKDIR', (reqId, p) => {
    try { fs.mkdirSync(resolvePath(username, p), { recursive: true }); sftp.status(reqId, 0); }
    catch (e) { sftp.status(reqId, 4); }
  });

  sftp.on('RMDIR', (reqId, p) => {
    try { fs.rmdirSync(resolvePath(username, p)); sftp.status(reqId, 0); }
    catch (e) { sftp.status(reqId, 4); }
  });

  sftp.on('REMOVE', (reqId, p) => {
    try { fs.unlinkSync(resolvePath(username, p)); sftp.status(reqId, 0); }
    catch (e) { sftp.status(reqId, 4); }
  });

  sftp.on('RENAME', (reqId, oldP, newP) => {
    try {
      fs.renameSync(resolvePath(username, oldP), resolvePath(username, newP));
      sftp.status(reqId, 0);
    } catch (e) { sftp.status(reqId, 4); }
  });

  sftp.on('REALPATH', (reqId, p) => {
    sftp.name(reqId, [{ filename: resolvePath(username, p) }]);
  });
}
