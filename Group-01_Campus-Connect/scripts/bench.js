'use strict';
// Measures real timings of a running Campus Connect server.
//   node scripts/bench.js http://127.0.0.1:3000 [--json]
// Everything is timed with a high-resolution clock in this one process, so the numbers are honest for the
// network path you point it at. On localhost they show the cost of the application itself (loopback has no
// real network delay), so do not read them as Internet latency. It creates demo accounts named bench_*.
const { io } = require('socket.io-client');
const { performance } = require('perf_hooks');

const base = (process.argv[2] || '').replace(/\/+$/, '');
const asJson = process.argv.includes('--json');
if (!/^https?:\/\//.test(base)) { console.error('Usage: node scripts/bench.js http://127.0.0.1:3000 [--json]'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const pick = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const r = (x) => Math.round(x * 100) / 100;
  return { n: s.length, min: r(s[0]), mean: r(mean), median: r(pick(50)), p95: r(pick(95)), max: r(s[s.length - 1]) };
};

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
    return { status: r.status, data };
  };
  return { call, get cookie() { return cookie; } };
}
const connect = (cookie, opts = {}) => new Promise((resolve, reject) => {
  const s = io(base, { extraHeaders: { cookie }, reconnection: false, timeout: 15000, ...opts });
  s.on('net:probe', (cb) => cb());
  s.once('connect', () => resolve(s));
  s.once('connect_error', reject);
});
const emitAck = (sock, evt, payload) => new Promise((res) => sock.timeout(10000).emit(evt, payload, (err, r) => res(err ? { ok: false } : r)));

async function register(tag, i) {
  const c = client();
  const r = await c.call('POST', '/api/auth/register', { displayName: `Bench ${i}`, username: `bench_${tag}_${i}`, password: `bench-${tag}-pw` });
  if (r.status !== 201) throw new Error(`register failed (${r.status})`);
  return { c, id: r.data.user.id };
}

async function pingPong(transports, count) {
  const tag = Math.random().toString(16).slice(2, 8);
  const A = await register(tag, 1), B = await register(tag, 2);
  const conv = await A.c.call('POST', '/api/conversations', { kind: 'direct', userId: B.id });
  const cid = conv.data.conversation.id;
  const opts = transports.length === 1 && transports[0] === 'polling' ? { transports: ['polling'], upgrade: false } : { transports };
  const sa = await connect(A.c.cookie, opts), sb = await connect(B.c.cookie, opts);
  const used = sa.io.engine.transport.name;
  const ackMs = [], deliverMs = [];
  for (let i = 0; i < count; i++) {
    const text = `bench ${i} ${tag}`;
    const arrived = new Promise((resolve) => {
      const h = (m) => { if (m.body === text) { sb.off('message:new', h); resolve(performance.now()); } };
      sb.on('message:new', h);
    });
    const t0 = performance.now();
    const ack = await emitAck(sa, 'message:send', { conversationId: cid, body: text });
    const t1 = performance.now();
    if (!ack.ok) throw new Error('send failed');
    const t2 = await arrived;
    ackMs.push(t1 - t0); deliverMs.push(t2 - t0);
    await sleep(700); // the server allows 15 messages per 10 seconds per connection, so the test paces itself
  }
  sa.close(); sb.close();
  return { transport: used, ack: stats(ackMs), delivery: stats(deliverMs) };
}

async function fanOut(receivers, count) {
  const tag = Math.random().toString(16).slice(2, 8);
  const sender = await register(tag, 0);
  const others = [];
  for (let i = 1; i <= receivers; i++) others.push(await register(tag, i));
  const grp = await sender.c.call('POST', '/api/conversations', { kind: 'group', name: `bench ${tag}`, memberIds: others.map((o) => o.id) });
  const cid = grp.data.conversation.id;
  const ss = await connect(sender.c.cookie);
  const rs = await Promise.all(others.map((o) => connect(o.c.cookie)));
  const allMs = [];
  for (let i = 0; i < count; i++) {
    const text = `fan ${i} ${tag}`;
    const got = Promise.all(rs.map((s) => new Promise((resolve) => {
      const h = (m) => { if (m.body === text) { s.off('message:new', h); resolve(performance.now()); } };
      s.on('message:new', h);
    })));
    const t0 = performance.now();
    await emitAck(ss, 'message:send', { conversationId: cid, body: text });
    const times = await got;
    allMs.push(Math.max(...times) - t0);
    await sleep(700); // the sender may only send 15 messages per 10 seconds
  }
  ss.close(); rs.forEach((s) => s.close());
  return { receivers, lastReceiverMs: stats(allMs) };
}

async function httpTimings(count) {
  const ms = [];
  for (let i = 0; i < count; i++) { const t = performance.now(); const r = await fetch(`${base}/health`); await r.arrayBuffer(); ms.push(performance.now() - t); }
  return stats(ms);
}

async function uploads(sizesMb, repeats) {
  const tag = Math.random().toString(16).slice(2, 8);
  const A = await register(tag, 1), B = await register(tag, 2);
  const conv = await A.c.call('POST', '/api/conversations', { kind: 'direct', userId: B.id });
  const cid = conv.data.conversation.id;
  const out = [];
  for (const mb of sizesMb) {
    const bytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(mb * 1024 * 1024, 65), Buffer.from('\n%%EOF\n')]);
    const up = [], down = [];
    for (let i = 0; i < repeats; i++) {
      const fd = new FormData(); fd.append('file', new Blob([bytes]), `bench-${mb}mb.pdf`);
      const t0 = performance.now();
      const r = await A.c.call('POST', `/api/conversations/${cid}/files`, fd);
      const t1 = performance.now();
      if (r.status !== 201) throw new Error(`upload failed (${r.status})`);
      const d = await B.c.call('GET', `/api/files/${r.data.message.file.id}`);
      const t2 = performance.now();
      if (d.status !== 200 || Buffer.compare(d.data, bytes) !== 0) throw new Error('download differs');
      up.push(t1 - t0); down.push(t2 - t1);
    }
    const mbps = (ms) => Math.round(((bytes.length * 8) / 1e6 / (ms / 1000)) * 10) / 10;
    out.push({ sizeMb: mb, uploadMs: stats(up), downloadMs: stats(down), uploadMbps: mbps(stats(up).median), downloadMbps: mbps(stats(down).median) });
  }
  return out;
}

(async () => {
  const result = { base, when: new Date().toISOString(), node: process.version };
  const log = (...a) => { if (!asJson) console.log(...a); };
  log(`Benchmark of ${base}\n`);
  result.http = await httpTimings(200);
  log('HTTP GET /health x200 (ms):', result.http);
  result.websocket = await pingPong(['websocket'], 100);
  log(`\nMessages over ${result.websocket.transport} x100 (ms): ack`, result.websocket.ack, '\n  delivery to the other student', result.websocket.delivery);
  result.polling = await pingPong(['polling'], 40);
  log(`\nMessages over ${result.polling.transport} x40 (ms): ack`, result.polling.ack, '\n  delivery to the other student', result.polling.delivery);
  result.fanOut = await fanOut(10, 20);
  log('\nOne message to a group of 10 receivers x20 (ms until the last receiver has it):', result.fanOut.lastReceiverMs);
  result.files = await uploads([1, 5, 15], 3);
  log('\nFile upload then download (median of 3):'); result.files.forEach((f) => log(`  ${f.sizeMb} MB: upload ${f.uploadMs.median} ms (${f.uploadMbps} Mbit/s), download ${f.downloadMs.median} ms (${f.downloadMbps} Mbit/s)`));
  if (asJson) console.log(JSON.stringify(result, null, 2));
  process.exit(0);
})().catch((e) => { console.error(`Benchmark stopped: ${e.message}`); process.exit(1); });
