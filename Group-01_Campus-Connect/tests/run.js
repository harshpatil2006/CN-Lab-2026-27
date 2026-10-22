'use strict';
// End-to-end checks. Starts the real server on a spare port with a fresh data folder, then talks to it
// over HTTP and Socket.IO exactly like browsers do. Run with:  npm test
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { io } = require('socket.io-client');

let passed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); } else { failures.push(name); console.log(`  FAIL ${name}${extra ? `  (${extra})` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

async function startServer(dataDir, port, env = {}) {
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, AUTH_RATE_LIMIT: '1000', MAX_UPLOAD_MB: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return { proc, log: () => log }; } catch (_) { /* not up yet */ }
    await sleep(150);
  }
  throw new Error(`server did not start\n${log}`);
}
const stop = (s) => new Promise((res) => { s.proc.once('exit', res); s.proc.kill('SIGTERM'); });

function client(base) {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const init = { method, headers: { cookie, ...headers } };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    const r = await fetch(base + url, init);
    const sc = r.headers.get('set-cookie');
    if (sc && sc.includes('cc_session=')) cookie = sc.split(';')[0];
    let data = null; const ct = r.headers.get('content-type') || '';
    if (ct.includes('json')) data = await r.json(); else data = Buffer.from(await r.arrayBuffer());
    return { status: r.status, data, headers: r.headers, setCookie: sc };
  };
  return { call, get cookie() { return cookie; } };
}
function connectSocket(base, cookie, opts = {}) {
  return new Promise((resolve, reject) => {
    const s = io(base, { extraHeaders: { cookie }, transports: ['websocket'], reconnection: false, ...opts });
    s.on('net:probe', (cb) => cb()); // browsers answer the server's latency probe; so does this test client
    s.once('connect', () => resolve(s));
    s.once('connect_error', (e) => reject(e));
  });
}
const waitFor = (sock, evt, ms = 4000, pred = () => true) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { sock.off(evt, h); reject(new Error(`timeout waiting for ${evt}`)); }, ms);
  const h = (d) => { if (pred(d)) { clearTimeout(t); sock.off(evt, h); resolve(d); } };
  sock.on(evt, h);
});
const once = (sock, evt, ms = 5000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`timeout waiting for ${evt}`)), ms); sock.once(evt, (d) => { clearTimeout(t); res(d); }); });
const emitAck = (sock, evt, payload) => new Promise((res) => sock.timeout(3000).emit(evt, payload, (err, r) => res(err ? { ok: false, error: 'timeout' } : r)));

function fileForm(name, bytes, caption) {
  const fd = new FormData();
  if (caption !== undefined) fd.append('caption', caption);
  fd.append('file', new Blob([bytes]), name);
  return fd;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let server = await startServer(dataDir, port);
  console.log(`\nCampus Connect tests (server on port ${port})\n`);

  console.log('Health and protection');
  const anon = client(base);
  const h = await anon.call('GET', '/health');
  check('health endpoint answers ok', h.status === 200 && h.data.status === 'ok' && h.data.database === 'ok');
  check('security headers are set', (h.headers.get('content-security-policy') || '').includes("default-src 'self'") && h.headers.get('x-content-type-options') === 'nosniff');
  check('chat API needs a login', (await anon.call('GET', '/api/conversations')).status === 401);
  check('file download needs a login', (await anon.call('GET', '/api/files/1')).status === 401);
  let sockErr = null;
  try { await connectSocket(base, ''); } catch (e) { sockErr = e; }
  check('live channel refuses visitors who are not signed in', sockErr && sockErr.message === 'unauthorized');
  const evil = await anon.call('POST', '/api/auth/login', { username: 'x', password: 'y' }, { origin: 'https://evil.example' });
  check('requests from another website are blocked', evil.status === 403);

  console.log('\nAccounts');
  const A = client(base), B = client(base), C = client(base);
  const ra = await A.call('POST', '/api/auth/register', { displayName: 'Asha Rao', username: 'asha', password: 'correct-horse-1' });
  check('register works', ra.status === 201 && ra.data.user.username === 'asha');
  check('session cookie is HttpOnly and SameSite=Lax', /HttpOnly/i.test(ra.setCookie) && /SameSite=Lax/i.test(ra.setCookie));
  check('register again with the same username is refused', (await anon.call('POST', '/api/auth/register', { displayName: 'Other', username: 'ASHA', password: 'another-pass-1' })).status === 409);
  check('short password is refused', (await anon.call('POST', '/api/auth/register', { displayName: 'Short Pw', username: 'shorty', password: '123' })).status === 400);
  check('bad username is refused', (await anon.call('POST', '/api/auth/register', { displayName: 'Bad Name', username: 'no spaces!', password: 'longenough1' })).status === 400);
  const rb = await B.call('POST', '/api/auth/register', { displayName: 'Bilal Khan', username: 'bilal', password: 'bilal-pass-22' });
  const rc = await C.call('POST', '/api/auth/register', { displayName: 'Chitra Nair', username: 'chitra', password: 'chitra-pass-33' });
  check('three students registered', rb.status === 201 && rc.status === 201);
  const rawDb = fs.readFileSync(path.join(dataDir, 'campus-connect.db'));
  check('passwords are not stored as plain text', !rawDb.includes('correct-horse-1') && !rawDb.includes('bilal-pass-22'));
  const bad = await anon.call('POST', '/api/auth/login', { username: 'asha', password: 'wrong-password' });
  check('wrong password is refused', bad.status === 401);
  const A2 = client(base);
  check('login works', (await A2.call('POST', '/api/auth/login', { username: 'asha', password: 'correct-horse-1' })).status === 200);
  const me = await A.call('GET', '/api/me');
  check('/api/me returns the signed-in student', me.status === 200 && me.data.user.displayName === 'Asha Rao');
  const ids = { a: ra.data.user.id, b: rb.data.user.id, c: rc.data.user.id };

  console.log('\nLive messaging');
  const sa = await connectSocket(base, A.cookie);
  const sb = await connectSocket(base, B.cookie);
  const sc = await connectSocket(base, C.cookie);
  const users = await B.call('GET', '/api/users');
  const asha = users.data.users.find((u) => u.username === 'asha');
  check('online status shows connected students', asha && asha.online === true && users.data.onlineCount === 3);
  const newConvP = waitFor(sb, 'conversation:new');
  const dc = await A.call('POST', '/api/conversations', { kind: 'direct', userId: ids.b });
  check('direct chat created', dc.status === 201 && dc.data.conversation.kind === 'direct' && dc.data.conversation.name === 'Bilal Khan');
  await newConvP;
  check('the other student is told about the new chat', true);
  const dc2 = await B.call('POST', '/api/conversations', { kind: 'direct', userId: ids.a });
  check('same pair gets the same chat (no duplicates)', dc2.status === 200 && dc2.data.conversation.id === dc.data.conversation.id);
  const cid = dc.data.conversation.id;
  const gotP = waitFor(sb, 'message:new');
  const ack = await emitAck(sa, 'message:send', { conversationId: cid, body: '  Hello Bilal, notes tonight?  ' });
  const got = await gotP;
  check('message is acknowledged', ack.ok === true && ack.message.body === 'Hello Bilal, notes tonight?');
  check('recipient receives it instantly with sender and time', got.body === 'Hello Bilal, notes tonight?' && got.sender.displayName === 'Asha Rao' && got.createdAt > 0);
  const convB = (await B.call('GET', '/api/conversations')).data.conversations.find((c) => c.id === cid);
  check('unread count is 1 for the recipient', convB.unread === 1 && convB.last.text.startsWith('Hello'));
  await B.call('POST', `/api/conversations/${cid}/read`, {});
  const convB2 = (await B.call('GET', '/api/conversations')).data.conversations.find((c) => c.id === cid);
  check('marking as read clears the unread count', convB2.unread === 0);
  check('empty message is refused', (await emitAck(sa, 'message:send', { conversationId: cid, body: '   ' })).ok === false);
  check('too long message is refused', (await emitAck(sa, 'message:send', { conversationId: cid, body: 'x'.repeat(2001) })).ok === false);
  check('a student outside the chat cannot post in it', (await emitAck(sc, 'message:send', { conversationId: cid, body: 'sneaky' })).ok === false);
  check('a student outside the chat cannot read it', (await C.call('GET', `/api/conversations/${cid}/messages`)).status === 404);
  const hist = await B.call('GET', `/api/conversations/${cid}/messages`);
  check('history is stored and returned', hist.data.messages.length === 1 && hist.data.messages[0].body.startsWith('Hello'));

  const gp = waitFor(sa, 'conversation:new');
  const grp = await C.call('POST', '/api/conversations', { kind: 'group', name: 'CN project team', memberIds: [ids.a, ids.b] });
  check('group chat created with three members', grp.status === 201 && grp.data.conversation.members.length === 3);
  await gp;
  const gA = waitFor(sa, 'message:new', 4000, (m) => m.conversationId === grp.data.conversation.id);
  const gB = waitFor(sb, 'message:new', 4000, (m) => m.conversationId === grp.data.conversation.id);
  await emitAck(sc, 'message:send', { conversationId: grp.data.conversation.id, body: 'Meeting at 5?' });
  const [ma, mb] = await Promise.all([gA, gB]);
  check('group message reaches every member', ma.body === 'Meeting at 5?' && mb.sender.displayName === 'Chitra Nair');

  console.log('\nFile sharing');
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n% test file for Campus Connect\n'), Buffer.alloc(5000, 65), Buffer.from('\n%%EOF\n')]);
  const fileMsgP = waitFor(sb, 'message:new', 4000, (m) => m.file);
  const up = await A.call('POST', `/api/conversations/${cid}/files`, fileForm('Unit 3 Notes.pdf', pdf, 'Unit 3'));
  check('PDF upload accepted', up.status === 201 && up.data.message.file.name === 'Unit 3 Notes.pdf' && up.data.message.file.size === pdf.length);
  const fm = await fileMsgP;
  check('recipient is notified live with file name and size', fm.file.name === 'Unit 3 Notes.pdf' && fm.file.size === pdf.length && fm.body === 'Unit 3');
  const dl = await B.call('GET', `/api/files/${fm.file.id}`);
  check('recipient can download the same bytes', dl.status === 200 && Buffer.compare(dl.data, pdf) === 0);
  check('download is sent as an attachment and not sniffed', /attachment/.test(dl.headers.get('content-disposition')) && dl.headers.get('x-content-type-options') === 'nosniff' && dl.headers.get('content-type') === 'application/pdf');
  check('student outside the chat cannot download it', (await C.call('GET', `/api/files/${fm.file.id}`)).status === 404);
  check('file ids that do not exist look the same (404)', (await B.call('GET', '/api/files/99999')).status === 404);
  check('fake PDF (text renamed .pdf) is rejected', (await A.call('POST', `/api/conversations/${cid}/files`, fileForm('fake.pdf', Buffer.from('just some text'), ''))).status === 400);
  check('program files (.exe) are rejected', (await A.call('POST', `/api/conversations/${cid}/files`, fileForm('setup.exe', Buffer.from('MZ....'), ''))).status === 400);
  const big = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(1.2 * 1024 * 1024)]);
  check('files over the limit are refused (413)', (await A.call('POST', `/api/conversations/${cid}/files`, fileForm('big.zip', big, ''))).status === 413);
  check('outsider cannot upload into a chat', (await C.call('POST', `/api/conversations/${cid}/files`, fileForm('x.pdf', pdf, ''))).status === 404);
  const trav = await A.call('POST', `/api/conversations/${cid}/files`, fileForm('../../etc/passwd.txt', Buffer.from('plain text'), ''));
  check('folder tricks in a file name are cleaned', trav.status === 201 && trav.data.message.file.name === 'passwd.txt');
  const stored = fs.readdirSync(path.join(dataDir, 'uploads'));
  check('files are stored outside the web folder with random names', stored.length === 2 && stored.every((n) => /^[0-9a-f]{32}$/.test(n)));
  const zipData = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(300, 1)]);
  const z = await A.call('POST', `/api/conversations/${cid}/files`, fileForm('Étude 笔记.zip', zipData, ''));
  check('names with accents and other scripts are kept', z.status === 201 && z.data.message.file.name === 'Étude 笔记.zip');
  const list = await B.call('GET', '/api/files');
  check('file list shows files shared with the student', list.data.files.length === 3 && list.data.files.every((f) => f.sentByMe === false));
  const dls = await B.call('GET', '/api/dashboard');
  check('dashboard totals are right', dls.data.totalStudents === 3 && dls.data.onlineCount === 3 && dls.data.files.length === 3);

  console.log('\nSearch');
  const s1 = await B.call('GET', '/api/search?q=ash');
  check('search finds students by name', s1.data.users.some((u) => u.username === 'asha'));
  const s2 = await B.call('GET', '/api/search?q=Notes');
  check('search finds files by name', s2.data.files.some((f) => f.name === 'Unit 3 Notes.pdf'));
  const s3 = await B.call('GET', '/api/search?q=notes%20tonight');
  check('search finds messages', s3.data.messages.length === 1);
  const s4 = await C.call('GET', '/api/search?q=Notes');
  check('search never shows files from other people\'s chats', s4.data.files.length === 0);

  console.log('\nNetwork monitor (real measurements)');
  await sleep(6500); // wait for at least one 5-second probe round
  const mon = (await B.call('GET', '/api/monitor')).data.snapshot;
  check('active connections counted', mon.activeConnections === 3 && mon.onlineStudents === 3);
  check('messages counted', mon.sinceStart.messagesSent === 2 && mon.sinceStart.deliveries >= 3, JSON.stringify(mon.sinceStart));
  check('uploads and bytes counted', mon.sinceStart.filesUploaded === 3 && mon.sinceStart.bytesUploaded === pdf.length + 'plain text'.length + zipData.length);
  check('download counted', mon.sinceStart.filesDownloaded === 1 && mon.sinceStart.bytesDownloaded === pdf.length);
  check('latency was measured by the server', mon.latency.count >= 3 && mon.latency.last > 0 && mon.latency.last < 1000, JSON.stringify(mon.latency).slice(0, 120));
  check('transport types are reported', mon.transports.websocket === 3);
  const kinds = new Set((await B.call('GET', '/api/activity')).data.activity.map((a) => a.kind));
  check('activity log has connections, messages, uploads and downloads', ['connect', 'message', 'upload', 'download', 'register'].every((k) => kinds.has(k)), [...kinds].join(','));

  const subSock = await connectSocket(base, B.cookie);
  subSock.emit('monitor:subscribe');
  const live = await waitFor(subSock, 'monitor:snapshot', 4000);
  check('monitor pushes live snapshots', live.activeConnections === 4);
  const offP = waitFor(sb, 'presence', 4000, (p) => p.userId === ids.a && p.online === false);
  sa.close();
  const off = await offP;
  check('students see someone go offline', off.online === false && off.onlineCount === 2);
  const kinds2 = (await B.call('GET', '/api/activity?kind=disconnect')).data.activity;
  check('disconnect is logged with the reason', kinds2.length >= 1 && /disconnected \(/.test(kinds2[0].detail));
  subSock.close();

  console.log('\nPolling fallback and reconnection');
  const poll = io(base, { extraHeaders: { cookie: A.cookie }, transports: ['polling'], reconnection: false });
  await new Promise((r, j) => { poll.once('connect', r); poll.once('connect_error', j); });
  check('HTTP long-polling works when WebSocket is not used', poll.io.engine.transport.name === 'polling');
  const pm = waitFor(sb, 'message:new', 4000, (m) => m.body === 'sent over polling');
  await emitAck(poll, 'message:send', { conversationId: cid, body: 'sent over polling' });
  check('messages flow over the fallback too', (await pm).body === 'sent over polling');
  poll.close();
  const re = io(base, { extraHeaders: { cookie: B.cookie }, transports: ['websocket'], reconnection: true, reconnectionDelay: 200 });
  re.on('net:probe', (cb) => cb());
  await once(re, 'connect');
  const dropped = once(re, 'disconnect');
  re.io.engine.close();
  const why = await dropped;
  await once(re, 'connect', 8000);
  check('a dropped connection reconnects by itself', re.connected === true && ['transport close', 'forced close'].includes(why), String(why));
  re.close();

  console.log('\nRestart: saved data survives');
  [sb, sc].forEach((s) => s.close());
  await stop(server);
  server = await startServer(dataDir, port);
  const B2 = client(base);
  check('login still works after restart', (await B2.call('POST', '/api/auth/login', { username: 'bilal', password: 'bilal-pass-22' })).status === 200);
  const hist2 = await B2.call('GET', `/api/conversations/${cid}/messages`);
  check('messages are still there', hist2.data.messages.length >= 4 && hist2.data.messages[0].body.startsWith('Hello'));
  const dl2 = await B2.call('GET', `/api/files/${fm.file.id}`);
  check('uploaded file is still downloadable and identical', dl2.status === 200 && Buffer.compare(dl2.data, pdf) === 0);
  const oldCookie = await B.call('GET', '/api/me');
  check('existing sign-in still valid after restart', oldCookie.status === 200);
  const lo = await B.call('POST', '/api/auth/logout', {});
  const meAfter = await B.call('GET', '/api/me');
  check('logout ends the session', lo.status === 200 && meAfter.status === 200 && meAfter.data.user === null);
  check('private data is refused after logout', (await B.call('GET', '/api/users')).status === 401);
  await stop(server);

  console.log('\nSign-in rate limit');
  const port2 = await freePort();
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test2-'));
  const s2srv = await startServer(dir2, port2, { AUTH_RATE_LIMIT: '5' });
  const R = client(`http://127.0.0.1:${port2}`);
  let last = 0;
  for (let i = 0; i < 8; i++) last = (await R.call('POST', '/api/auth/login', { username: 'nobody', password: 'nothing-here' })).status;
  check('too many sign-in attempts get a 429', last === 429);
  await stop(s2srv);

  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  if (failures.length) { console.log('Failed:\n - ' + failures.join('\n - ')); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
