'use strict';
// Campus Connect: one Node.js program that serves the website, the API, file transfers and the live (Socket.IO) channel.
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { Server } = require('socket.io');

const { q, tx, UPLOAD_DIR } = require('./src/db');
const auth = require('./src/auth');
const files = require('./src/files');
const metrics = require('./src/metrics');

const PORT = Number(process.env.PORT) || 3000;
const MAX_MB = Number(process.env.MAX_UPLOAD_MB) || 20;
const MAX_BYTES = MAX_MB * 1024 * 1024;
const VERSION = require('./package.json').version;

const app = express();
const server = http.createServer(app);
app.set('trust proxy', 1); // Railway puts a proxy in front of the app
app.disable('x-powered-by');

const sameHost = (origin, host) => { try { return new URL(origin).host === host; } catch (_) { return false; } };

const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 8000,
  maxHttpBufferSize: 1e5,
  allowRequest: (req, cb) => cb(null, !req.headers.origin || sameHost(req.headers.origin, req.headers.host)),
});

// ---------- small helpers ----------
const presence = new Map(); // userId -> Set of socket ids (a student can have several tabs open)
const isOnline = (id) => presence.has(id);
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function userView(r) {
  return { id: r.id, username: r.username, displayName: r.displayName, online: isOnline(r.id), lastSeen: r.lastSeen || null };
}
const USER_COLS = 'id, username, display_name AS displayName, last_seen AS lastSeen';
const totalStudents = () => q.get('SELECT COUNT(*) AS n FROM users').n;

function isMember(cid, uid) { return !!q.get('SELECT 1 AS x FROM members WHERE conversation_id = ? AND user_id = ?', cid, uid); }

function messageView(id) {
  const m = q.get(
    `SELECT m.id, m.conversation_id AS conversationId, m.sender_id AS senderId, u.display_name AS senderName, u.username AS senderUsername,
            m.body, m.created_at AS createdAt, f.id AS fileId, f.original_name AS fileName, f.size AS fileSize, f.mime AS fileMime
       FROM messages m JOIN users u ON u.id = m.sender_id LEFT JOIN files f ON f.id = m.file_id WHERE m.id = ?`, id);
  if (!m) return null;
  return {
    id: m.id, conversationId: m.conversationId, body: m.body, createdAt: m.createdAt,
    sender: { id: m.senderId, displayName: m.senderName, username: m.senderUsername },
    file: m.fileId ? { id: m.fileId, name: m.fileName, size: m.fileSize, mime: m.fileMime, isImage: files.IMAGE_MIMES.has(m.fileMime) } : null,
  };
}

function conversationView(cid, myId) {
  const c = q.get('SELECT id, kind, name, created_at AS createdAt FROM conversations WHERE id = ?', cid);
  if (!c) return null;
  const members = q.all(
    `SELECT u.id, u.username, u.display_name AS displayName, u.last_seen AS lastSeen FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id = ? ORDER BY u.display_name`, cid).map(userView);
  const peer = c.kind === 'direct' ? members.find((m) => m.id !== myId) || members[0] : null;
  const last = q.get(
    `SELECT m.id, m.body, m.sender_id AS senderId, m.created_at AS createdAt, f.original_name AS fileName
       FROM messages m LEFT JOIN files f ON f.id = m.file_id WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT 1`, cid);
  const unread = q.get(
    `SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender_id != ?
        AND id > (SELECT last_read_id FROM members WHERE conversation_id = ? AND user_id = ?)`, cid, myId, cid, myId).n;
  return {
    id: c.id, kind: c.kind, name: c.kind === 'direct' ? peer.displayName : c.name, peer, members,
    createdAt: c.createdAt, unread,
    last: last ? { id: last.id, text: last.fileName ? `File: ${last.fileName}` : last.body, senderId: last.senderId, createdAt: last.createdAt } : null,
  };
}

function myConversations(uid) {
  const ids = q.all('SELECT conversation_id AS id FROM members WHERE user_id = ?', uid).map((r) => r.id);
  return ids.map((id) => conversationView(id, uid)).filter(Boolean)
    .sort((a, b) => ((b.last ? b.last.createdAt : b.createdAt) - (a.last ? a.last.createdAt : a.createdAt)));
}

function addToRooms(cid, userIds) {
  for (const id of userIds) {
    io.in(`user:${id}`).socketsJoin(`conv:${cid}`);
    io.to(`user:${id}`).emit('conversation:new', { conversationId: cid });
  }
}

// Save a message, push it to everyone in the conversation, and count it.
function postMessage({ cid, userId, body, fileId = null }) {
  const id = tx(() => {
    const r = q.run('INSERT INTO messages (conversation_id, sender_id, body, file_id, created_at) VALUES (?,?,?,?,?)', cid, userId, body, fileId, Date.now());
    const mid = Number(r.lastInsertRowid);
    q.run('UPDATE members SET last_read_id = ? WHERE conversation_id = ? AND user_id = ?', mid, cid, userId);
    return mid;
  });
  const msg = messageView(id);
  const room = io.sockets.adapter.rooms.get(`conv:${cid}`) || new Set();
  let deliveries = 0;
  for (const sid of room) {
    const s = io.sockets.sockets.get(sid);
    if (s && s.data.user.id !== userId) deliveries += 1;
  }
  io.to(`conv:${cid}`).emit('message:new', msg);
  io.to('monitor').emit('monitor:pulse', { kind: msg.file ? 'file' : 'message' });
  return { msg, deliveries };
}

// ---------- middleware ----------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use((req, res, next) => {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => metrics.onHttp(Number(process.hrtime.bigint() - t0) / 1e6, res.statusCode));
  next();
});
// Block state-changing requests that come from another website.
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers.origin && !sameHost(req.headers.origin, req.headers.host)) return res.status(403).json({ error: 'Request blocked.' });
  next();
});
app.use(express.json({ limit: '20kb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Wait a few minutes and try again.' },
});

// ---------- health ----------
app.get('/health', (req, res) => {
  try {
    q.get('SELECT 1 AS ok');
    fs.accessSync(UPLOAD_DIR, fs.constants.W_OK);
    res.json({
      status: 'ok', version: VERSION, time: new Date().toISOString(), uptimeSec: Math.floor(process.uptime()),
      database: 'ok', storageWritable: true, persistentVolume: Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH),
      connections: metrics.connections.size,
    });
  } catch (err) {
    res.status(503).json({ status: 'error', message: 'Storage or database problem.' });
  }
});

// ---------- accounts ----------
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { errors, name, user } = auth.validateRegistration(req.body || {});
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Please fix the highlighted fields.', errors });
  let id;
  try {
    id = await auth.createUser(name, user, req.body.password);
  } catch (err) {
    if (/UNIQUE/i.test(String(err.message))) return res.status(409).json({ error: 'That username is already taken.', errors: { username: 'That username is already taken.' } });
    throw err;
  }
  auth.startSession(res, id);
  const me = q.get(`SELECT ${USER_COLS} FROM users WHERE id = ?`, id);
  metrics.logActivity('register', id, 'created an account');
  io.emit('user:new', { user: userView(me), totalStudents: totalStudents() });
  res.status(201).json({ user: userView(me) });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const id = await auth.checkLogin(req.body && req.body.username, req.body && req.body.password);
  if (!id) return res.status(401).json({ error: 'Wrong username or password.' });
  auth.startSession(res, id);
  metrics.logActivity('login', id, 'signed in');
  res.json({ user: userView(q.get(`SELECT ${USER_COLS} FROM users WHERE id = ?`, id)) });
});

app.post('/api/auth/logout', auth.requireAuth, (req, res) => {
  auth.endSession(req.sessionToken);
  metrics.logActivity('logout', req.user.id, 'signed out');
  io.in(`user:${req.user.id}`).disconnectSockets(true);
  res.clearCookie(auth.COOKIE, { path: '/' });
  res.json({ ok: true });
});

// Answers 200 for everyone so the sign-in screen does not cause a red 401 in the browser console.
// Signed-out visitors get { user: null }.
app.get('/api/me', (req, res) => {
  const config = { maxUploadMb: MAX_MB, allowedExtensions: files.allowedList() };
  const user = auth.userFromToken(auth.tokenFromCookieHeader(req.headers.cookie));
  if (!user) return res.json({ user: null, config });
  res.json({ user: userView(q.get(`SELECT ${USER_COLS} FROM users WHERE id = ?`, user.id)), config });
});

// ---------- people and conversations ----------
app.get('/api/users', auth.requireAuth, (req, res) => {
  const rows = q.all(`SELECT ${USER_COLS} FROM users WHERE id != ? ORDER BY display_name LIMIT 500`, req.user.id);
  res.json({ users: rows.map(userView), totalStudents: totalStudents(), onlineCount: presence.size });
});

app.get('/api/conversations', auth.requireAuth, (req, res) => {
  res.json({ conversations: myConversations(req.user.id) });
});

app.post('/api/conversations', auth.requireAuth, (req, res) => {
  const body = req.body || {};
  const me = req.user.id;
  if (body.kind === 'direct') {
    const other = Number(body.userId);
    if (!Number.isInteger(other) || other === me || !q.get('SELECT 1 AS x FROM users WHERE id = ?', other)) return res.status(400).json({ error: 'Choose another student.' });
    const key = `${Math.min(me, other)}:${Math.max(me, other)}`;
    let c = q.get('SELECT id FROM conversations WHERE direct_key = ?', key);
    let created = false;
    if (!c) {
      const cid = tx(() => {
        const r = q.run("INSERT INTO conversations (kind, direct_key, created_by, created_at) VALUES ('direct', ?, ?, ?)", key, me, Date.now());
        const id = Number(r.lastInsertRowid);
        for (const u of [me, other]) q.run('INSERT INTO members (conversation_id, user_id, joined_at) VALUES (?,?,?)', id, u, Date.now());
        return id;
      });
      c = { id: cid };
      created = true;
      addToRooms(cid, [me, other]);
    }
    return res.status(created ? 201 : 200).json({ conversation: conversationView(c.id, me) });
  }
  if (body.kind === 'group') {
    const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
    if (name.length < 2 || name.length > 40 || /[<>\u0000-\u001f]/.test(name)) return res.status(400).json({ error: 'Give the group a name (2 to 40 characters).' });
    const ids = [...new Set((Array.isArray(body.memberIds) ? body.memberIds : []).map(Number))]
      .filter((n) => Number.isInteger(n) && n !== me && q.get('SELECT 1 AS x FROM users WHERE id = ?', n)).slice(0, 49);
    if (!ids.length) return res.status(400).json({ error: 'Add at least one other student to the group.' });
    const cid = tx(() => {
      const r = q.run("INSERT INTO conversations (kind, name, created_by, created_at) VALUES ('group', ?, ?, ?)", name, me, Date.now());
      const id = Number(r.lastInsertRowid);
      for (const u of [me, ...ids]) q.run('INSERT INTO members (conversation_id, user_id, joined_at) VALUES (?,?,?)', id, u, Date.now());
      return id;
    });
    addToRooms(cid, [me, ...ids]);
    return res.status(201).json({ conversation: conversationView(cid, me) });
  }
  res.status(400).json({ error: 'Unknown conversation type.' });
});

function memberOnly(req, res, next) {
  const cid = Number(req.params.id);
  if (!Number.isInteger(cid) || !isMember(cid, req.user.id)) return res.status(404).json({ error: 'Conversation not found.' });
  req.cid = cid;
  next();
}

app.get('/api/conversations/:id/messages', auth.requireAuth, memberOnly, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 60, 1), 200);
  const before = parseInt(req.query.before, 10);
  const rows = before
    ? q.all('SELECT id FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?', req.cid, before, limit)
    : q.all('SELECT id FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?', req.cid, limit);
  res.json({ messages: rows.reverse().map((r) => messageView(r.id)), hasMore: rows.length === limit });
});

function markRead(uid, cid, upTo) {
  const top = q.get('SELECT COALESCE(MAX(id),0) AS m FROM messages WHERE conversation_id = ?', cid).m;
  const upto = Math.min(Number(upTo) || top, top);
  q.run('UPDATE members SET last_read_id = MAX(last_read_id, ?) WHERE conversation_id = ? AND user_id = ?', upto, cid, uid);
  io.to(`user:${uid}`).emit('conversation:read', { conversationId: cid });
}
app.post('/api/conversations/:id/read', auth.requireAuth, memberOnly, (req, res) => {
  markRead(req.user.id, req.cid, req.body && req.body.upTo);
  res.json({ ok: true });
});

// ---------- file sharing (uploads use plain HTTP; the live channel only announces them) ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')), // never use the student's file name on disk
  }),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 4, parts: 8 },
  fileFilter: (req, file, cb) => {
    if (files.typeFor(files.cleanName(file.originalname))) return cb(null, true);
    cb(Object.assign(new Error('type'), { userMessage: 'This file type is not allowed. Use a PDF, image, Office or text document, code file, or ZIP.' }));
  },
});

function runUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `That file is larger than ${MAX_MB} MB.` });
    if (err.userMessage) return res.status(400).json({ error: err.userMessage });
    if (err instanceof multer.MulterError) return res.status(400).json({ error: 'The upload could not be read. Try again.' });
    next(err);
  });
}

app.post('/api/conversations/:id/files', auth.requireAuth, memberOnly, runUpload, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a file to send.' });
  const stored = path.join(UPLOAD_DIR, req.file.filename);
  const name = files.cleanName(req.file.originalname);
  const [mime, kind] = files.typeFor(name);
  if (!files.contentLooksRight(stored, kind)) {
    fs.unlink(stored, () => {});
    return res.status(400).json({ error: `"${name}" does not look like a real .${files.extOf(name)} file.` });
  }
  const caption = typeof req.body.caption === 'string' ? req.body.caption.trim().slice(0, 500) : '';
  const fileId = Number(q.run(
    'INSERT INTO files (conversation_id, uploader_id, original_name, stored_name, mime, size, created_at) VALUES (?,?,?,?,?,?,?)',
    req.cid, req.user.id, name, req.file.filename, mime, req.file.size, Date.now()).lastInsertRowid);
  const { msg, deliveries } = postMessage({ cid: req.cid, userId: req.user.id, body: caption, fileId });
  metrics.onUpload(req.file.size);
  metrics.counters.deliveries += deliveries;
  metrics.logActivity('upload', req.user.id, `shared a file (${fmtBytes(req.file.size)})`);
  res.status(201).json({ message: msg });
});

app.get('/api/files', auth.requireAuth, (req, res) => {
  const me = req.user.id;
  const rows = q.all(
    `SELECT f.id, f.original_name AS name, f.size, f.mime, f.downloads, f.created_at AS createdAt, f.uploader_id AS uploaderId,
            u.display_name AS uploaderName, f.conversation_id AS conversationId, c.kind, c.name AS groupName
       FROM files f JOIN members m ON m.conversation_id = f.conversation_id AND m.user_id = ?
       JOIN users u ON u.id = f.uploader_id JOIN conversations c ON c.id = f.conversation_id
      ORDER BY f.id DESC LIMIT 100`, me);
  const out = rows.map((r) => {
    let to = r.groupName;
    if (r.kind === 'direct') {
      const peer = q.get('SELECT u.display_name AS n FROM members m JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ? AND m.user_id != ?', r.conversationId, r.uploaderId);
      to = r.uploaderId === me ? (peer ? peer.n : '') : 'You';
    }
    return { ...r, to, sentByMe: r.uploaderId === me, isImage: files.IMAGE_MIMES.has(r.mime) };
  });
  res.json({ files: out });
});

app.get('/api/files/:id', auth.requireAuth, (req, res) => {
  const f = q.get('SELECT * FROM files WHERE id = ?', Number(req.params.id));
  // Same answer for "does not exist" and "not yours", so file ids cannot be probed.
  if (!f || !isMember(f.conversation_id, req.user.id)) return res.status(404).json({ error: 'File not found.' });
  const full = path.join(UPLOAD_DIR, f.stored_name);
  let stat;
  try { stat = fs.statSync(full); } catch (_) { return res.status(404).json({ error: 'File not found.' }); }
  const inline = req.query.inline === '1' && files.IMAGE_MIMES.has(f.mime);
  if (inline) res.setHeader('Content-Disposition', 'inline');
  else res.attachment(f.original_name);
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Length', stat.size);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  let sent = 0;
  const stream = fs.createReadStream(full);
  stream.on('data', (c) => { sent += c.length; });
  stream.on('error', () => res.destroy());
  res.on('close', () => {
    if (inline || sent < stat.size) return;
    metrics.onDownload(sent);
    q.run('UPDATE files SET downloads = downloads + 1 WHERE id = ?', f.id);
    metrics.logActivity('download', req.user.id, `downloaded a file (${fmtBytes(sent)})`);
  });
  stream.pipe(res);
});

// ---------- dashboard and search ----------
app.get('/api/dashboard', auth.requireAuth, (req, res) => {
  const me = req.user.id;
  const convs = myConversations(me);
  const fr = q.all(
    `SELECT f.id, f.original_name AS name, f.size, f.created_at AS createdAt, f.uploader_id AS uploaderId, u.display_name AS uploaderName
       FROM files f JOIN members m ON m.conversation_id = f.conversation_id AND m.user_id = ?
       JOIN users u ON u.id = f.uploader_id ORDER BY f.id DESC LIMIT 5`, me);
  res.json({
    totalStudents: totalStudents(), onlineCount: presence.size,
    unread: convs.reduce((a, c) => a + c.unread, 0),
    conversations: convs.slice(0, 5), files: fr.map((f) => ({ ...f, sentByMe: f.uploaderId === me })),
    activity: metrics.recentActivity(8),
  });
});

app.get('/api/search', auth.requireAuth, (req, res) => {
  const term = String(req.query.q || '').trim().slice(0, 60);
  if (term.length < 2) return res.json({ users: [], conversations: [], files: [], messages: [] });
  const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const me = req.user.id;
  const users = q.all(`SELECT ${USER_COLS} FROM users WHERE id != ? AND (display_name LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\') ORDER BY display_name LIMIT 8`, me, like, like).map(userView);
  const convs = myConversations(me).filter((c) => c.name.toLowerCase().includes(term.toLowerCase())).slice(0, 6);
  const fl = q.all(
    `SELECT f.id, f.original_name AS name, f.size, f.conversation_id AS conversationId FROM files f
       JOIN members m ON m.conversation_id = f.conversation_id AND m.user_id = ?
      WHERE f.original_name LIKE ? ESCAPE '\\' ORDER BY f.id DESC LIMIT 6`, me, like);
  const msgs = q.all(
    `SELECT m.id, m.conversation_id AS conversationId, m.body, m.created_at AS createdAt, u.display_name AS senderName FROM messages m
       JOIN members mm ON mm.conversation_id = m.conversation_id AND mm.user_id = ? JOIN users u ON u.id = m.sender_id
      WHERE m.body LIKE ? ESCAPE '\\' ORDER BY m.id DESC LIMIT 6`, me, like);
  res.json({ users, conversations: convs.map((c) => ({ id: c.id, name: c.name, kind: c.kind })), files: fl, messages: msgs });
});

// ---------- network monitor ----------
function monitorSnapshot() {
  return metrics.snapshot({
    onlineStudents: presence.size,
    totalStudents: totalStudents(),
    storage: { persistentVolume: Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH), maxUploadMb: MAX_MB },
    server: { node: process.version, version: VERSION },
  });
}
app.get('/api/monitor', auth.requireAuth, (req, res) => {
  res.json({ snapshot: monitorSnapshot(), activity: metrics.recentActivity(30) });
});
app.get('/api/activity', auth.requireAuth, (req, res) => {
  const kinds = typeof req.query.kind === 'string' && req.query.kind ? req.query.kind.split(',').slice(0, 8) : null;
  res.json({ activity: metrics.recentActivity(100, kinds) });
});

// ---------- the website itself ----------
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  setHeaders: (res, file) => {
    if (/\.(woff2|js|css)$/.test(file) && /\/(fonts|vendor)\//.test(file)) res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    else res.setHeader('Cache-Control', 'no-cache');
  },
}));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Request error:', err && err.stack ? err.stack : err);
  if (res.headersSent) return res.destroy();
  res.status(err && err.status && err.status < 500 ? err.status : 500).json({ error: 'Something went wrong on the server.' });
});

// ---------- live channel (Socket.IO: WebSocket first choice, HTTP long-polling as fallback) ----------
io.use((socket, next) => {
  const user = auth.userFromToken(auth.tokenFromCookieHeader(socket.request.headers.cookie));
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = user;
  next();
});

metrics.onActivity((row) => {
  const who = row.userId ? q.get('SELECT display_name AS name, username FROM users WHERE id = ?', row.userId) : null;
  const evt = { ...row, name: who ? who.name : null, username: who ? who.username : null };
  io.to('feed').emit('activity:new', evt);
});

function probe(s) {
  const t0 = process.hrtime.bigint();
  s.timeout(4000).emit('net:probe', (err) => {
    if (err) return;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    metrics.recordRtt(s.data.user.id, ms);
    const c = metrics.connections.get(s.id);
    if (c) c.rtt = Math.round(ms * 10) / 10;
  });
}

io.on('connection', (socket) => {
  const user = socket.data.user;
  const transport = socket.conn.transport.name;
  metrics.counters.connectionsOpened += 1;
  metrics.connections.set(socket.id, { userId: user.id, name: user.displayName, username: user.username, transport, since: Date.now(), rtt: null });
  socket.join([`user:${user.id}`, 'feed']);
  for (const r of q.all('SELECT conversation_id AS id FROM members WHERE user_id = ?', user.id)) socket.join(`conv:${r.id}`);

  const wasOnline = isOnline(user.id);
  if (!presence.has(user.id)) presence.set(user.id, new Set());
  presence.get(user.id).add(socket.id);
  if (!wasOnline) io.emit('presence', { userId: user.id, online: true, onlineCount: presence.size });
  metrics.logActivity('connect', user.id, `connected over ${transport}`);
  socket.emit('ready', { socketId: socket.id, transport });
  setTimeout(() => { if (socket.connected) probe(socket); }, 600);

  socket.conn.on('upgrade', (t) => {
    const c = metrics.connections.get(socket.id);
    if (c) c.transport = t.name;
    metrics.logActivity('upgrade', user.id, `upgraded from ${transport} to ${t.name}`);
  });

  // client-side round-trip test: the client sends, we answer at once, the client times it
  socket.on('net:ping', (ack) => { if (typeof ack === 'function') ack(Date.now()); });

  let burst = []; // timestamps of this socket's recent messages (simple flood limit)
  socket.on('message:send', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const cid = Number(payload && payload.conversationId);
      const body = typeof (payload && payload.body) === 'string' ? payload.body.trim() : '';
      if (!Number.isInteger(cid) || !isMember(cid, user.id)) return reply({ ok: false, error: 'Conversation not found.' });
      if (!body) return reply({ ok: false, error: 'Type a message first.' });
      if (body.length > 2000) return reply({ ok: false, error: 'Messages can be up to 2000 characters.' });
      const now = Date.now();
      burst = burst.filter((t) => now - t < 10000);
      if (burst.length >= 15) return reply({ ok: false, error: 'You are sending too fast. Wait a moment.' });
      burst.push(now);
      const { msg, deliveries } = postMessage({ cid, userId: user.id, body });
      metrics.onMessage(deliveries);
      const kind = q.get('SELECT kind FROM conversations WHERE id = ?', cid).kind;
      metrics.logActivity('message', user.id, `sent a message in a ${kind === 'group' ? 'group' : 'direct'} chat`);
      reply({ ok: true, message: msg });
    } catch (err) {
      console.error('message:send failed', err);
      reply({ ok: false, error: 'The message could not be saved.' });
    }
  });

  socket.on('conversation:read', (p) => {
    const cid = Number(p && p.conversationId);
    if (Number.isInteger(cid) && isMember(cid, user.id)) markRead(user.id, cid, p.upTo);
  });
  socket.on('typing', (p) => {
    const cid = Number(p && p.conversationId);
    if (Number.isInteger(cid) && isMember(cid, user.id)) socket.to(`conv:${cid}`).emit('typing', { conversationId: cid, userId: user.id, name: user.displayName, typing: Boolean(p.typing) });
  });
  socket.on('monitor:subscribe', () => { socket.join('monitor'); socket.emit('monitor:snapshot', monitorSnapshot()); });
  socket.on('monitor:unsubscribe', () => socket.leave('monitor'));

  socket.on('disconnect', (reason) => {
    metrics.counters.disconnections += 1;
    metrics.connections.delete(socket.id);
    const set = presence.get(user.id);
    if (set) {
      set.delete(socket.id);
      if (!set.size) {
        presence.delete(user.id);
        q.run('UPDATE users SET last_seen = ? WHERE id = ?', Date.now(), user.id);
        io.emit('presence', { userId: user.id, online: false, onlineCount: presence.size, lastSeen: Date.now() });
      }
    }
    metrics.logActivity('disconnect', user.id, `disconnected (${reason})`);
  });
});

setInterval(() => { for (const s of io.sockets.sockets.values()) probe(s); }, 5000).unref();
setInterval(() => {
  const room = io.sockets.adapter.rooms.get('monitor');
  if (room && room.size) io.to('monitor').emit('monitor:snapshot', monitorSnapshot());
}, 2000).unref();

server.listen(PORT, '0.0.0.0', () => console.log(`Campus Connect ${VERSION} listening on 0.0.0.0:${PORT}`));

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  io.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
