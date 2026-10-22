'use strict';
// Live check: tests a running Campus Connect site from the outside, the same way two students would use it.
//   node scripts/live-check.js https://your-site.up.railway.app
// It creates two small test accounts ("Live check A" and "Live check B"), so run it only when you are happy
// to have those two names in the student list. It needs `npm install` first (for socket.io-client).
const { io } = require('socket.io-client');

const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('Usage: node scripts/live-check.js https://your-site.up.railway.app');
  process.exit(2);
}

let passed = 0, failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); } else { failed += 1; console.log(`  FAIL ${name}${extra ? `  (${extra})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const init = { method, headers: { cookie } };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    const r = await fetch(base + url, init);
    const sc = r.headers.get('set-cookie');
    if (sc && sc.includes('cc_session=')) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
    return { status: r.status, data, headers: r.headers, setCookie: sc };
  };
  return { call, get cookie() { return cookie; } };
}

function connect(cookie) {
  return new Promise((resolve, reject) => {
    const s = io(base, { extraHeaders: { cookie }, reconnection: false, timeout: 15000 });
    s.on('net:probe', (cb) => cb());
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}
const waitFor = (sock, evt, pred = () => true, ms = 10000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timed out waiting for ${evt}`)), ms);
  const h = (d) => { if (pred(d)) { clearTimeout(t); sock.off(evt, h); resolve(d); } };
  sock.on(evt, h);
});
const emitAck = (sock, evt, payload) => new Promise((res) => sock.timeout(8000).emit(evt, payload, (err, r) => res(err ? { ok: false, error: 'timeout' } : r)));

async function main() {
  console.log(`\nChecking ${base}\n`);
  const tag = Math.random().toString(16).slice(2, 8);
  const pass = `check-${tag}-pw`;

  console.log('Site');
  const anon = client();
  const h = await anon.call('GET', '/health');
  ok('health endpoint answers', h.status === 200 && h.data.status === 'ok');
  ok('database is working', h.data && h.data.database === 'ok');
  ok('uploads folder is writable', h.data && h.data.storageWritable === true);
  ok('persistent volume is attached (data survives restarts)', h.data && h.data.persistentVolume === true,
    'the volume is missing: run  npx @railway/cli volume add --mount-path /app/data  then redeploy');
  ok('served over HTTPS', base.startsWith('https://'), 'plain http was used');
  ok('chat API refuses visitors who are not signed in', (await anon.call('GET', '/api/conversations')).status === 401);

  console.log('\nAccounts');
  const A = client(), B = client();
  const ra = await A.call('POST', '/api/auth/register', { displayName: 'Live check A', username: `chk_${tag}a`, password: pass });
  const rb = await B.call('POST', '/api/auth/register', { displayName: 'Live check B', username: `chk_${tag}b`, password: pass });
  ok('two students can register', ra.status === 201 && rb.status === 201, `${ra.status}/${rb.status}`);
  if (ra.status !== 201 || rb.status !== 201) throw new Error('registration failed, cannot continue');
  ok('session cookie is HttpOnly and Secure', /HttpOnly/i.test(ra.setCookie) && /Secure/i.test(ra.setCookie));
  const A2 = client();
  ok('login works', (await A2.call('POST', '/api/auth/login', { username: `chk_${tag}a`, password: pass })).status === 200);

  console.log('\nLive messaging (Socket.IO)');
  const sa = await connect(A.cookie);
  const sb = await connect(B.cookie);
  ok('both students connected', sa.connected && sb.connected);
  const transport = sa.io.engine.transport.name;
  console.log(`       transport in use: ${transport}`);
  const conv = await A.call('POST', '/api/conversations', { kind: 'direct', userId: rb.data.user.id });
  ok('chat created', conv.status === 201 || conv.status === 200);
  const cid = conv.data.conversation.id;
  const text = `Hello from the live check ${tag}`;
  const arrives = waitFor(sb, 'message:new', (m) => m.body === text);
  const t0 = Date.now();
  const ack = await emitAck(sa, 'message:send', { conversationId: cid, body: text });
  const msg = await arrives.catch(() => null);
  const ms = Date.now() - t0;
  ok('message is acknowledged by the server', ack.ok === true);
  ok('message reaches the other student', Boolean(msg) && msg.sender.displayName === 'Live check A');
  if (msg) console.log(`       send to delivery took ${ms} ms (includes the round trip to the server)`);
  const hist = await B.call('GET', `/api/conversations/${cid}/messages`);
  ok('history is saved', hist.status === 200 && hist.data.messages.some((m) => m.body === text));

  console.log('\nFile sharing (HTTP upload, Socket.IO notice)');
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n% live check\n'), Buffer.alloc(4000, 66), Buffer.from('\n%%EOF\n')]);
  const fd = new FormData();
  fd.append('caption', 'live check file');
  fd.append('file', new Blob([pdf]), 'live-check.pdf');
  const note = waitFor(sb, 'message:new', (m) => m.file);
  const up = await A.call('POST', `/api/conversations/${cid}/files`, fd);
  ok('upload accepted', up.status === 201, `status ${up.status}`);
  const fm = await note.catch(() => null);
  ok('other student is told about the file', Boolean(fm) && fm.file.name === 'live-check.pdf' && fm.file.size === pdf.length);
  if (fm) {
    const dl = await B.call('GET', `/api/files/${fm.file.id}`);
    ok('other student downloads identical bytes', dl.status === 200 && Buffer.compare(dl.data, pdf) === 0);
    const out = client();
    ok('a visitor who is not signed in cannot download it', (await out.call('GET', `/api/files/${fm.file.id}`)).status === 401);
  }

  console.log('\nNetwork monitor');
  await sleep(6000); // wait for at least one server probe
  const mon = await A.call('GET', '/api/monitor');
  ok('monitor answers', mon.status === 200);
  const snap = (mon.data && mon.data.snapshot) || {};
  ok('active connections are counted', snap.activeConnections >= 2, `got ${snap.activeConnections}`);
  const lat = snap.latency || {};
  ok('server measured a real round-trip time', lat.count > 0 && lat.last > 0, JSON.stringify({ count: lat.count, last: lat.last }));
  if (lat.count > 0) console.log(`       server-measured round trip: last ${lat.last} ms, average ${lat.avg} ms`);

  sa.close(); sb.close();
  console.log(`\n${passed} checks passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(`\nLive check stopped: ${e.message}`); process.exit(1); });
