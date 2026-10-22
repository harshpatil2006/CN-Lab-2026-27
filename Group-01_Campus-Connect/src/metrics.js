'use strict';
// Everything here is measured by this server while it runs. Nothing is invented or simulated.
const { q } = require('./db');

const startedAt = Date.now();
const counters = {
  messagesSent: 0,        // messages accepted from clients
  deliveries: 0,          // copies pushed by the server to other connected sockets
  filesUploaded: 0,
  bytesUploaded: 0,
  filesDownloaded: 0,
  bytesDownloaded: 0,
  connectionsOpened: 0,
  disconnections: 0,
  httpRequests: 0,
  httpMsTotal: 0,
  http5xx: 0,
};

// One bucket per minute: messages and uploaded bytes (last 30 minutes kept).
const buckets = new Map();
function minuteKey(t = Date.now()) { return Math.floor(t / 60000) * 60000; }
function bucket() {
  const k = minuteKey();
  if (!buckets.has(k)) {
    buckets.set(k, { t: k, messages: 0, uploadBytes: 0 });
    for (const old of [...buckets.keys()]) if (old < k - 30 * 60000) buckets.delete(old);
  }
  return buckets.get(k);
}

// Live connections (one entry per Socket.IO connection).
const connections = new Map(); // socketId -> { userId, name, username, transport, since, rtt }

// Round-trip times measured by the server (server sends a probe, client answers, server times it).
const rttSamples = []; // { t, rtt, userId }
function recordRtt(userId, ms) {
  rttSamples.push({ t: Date.now(), rtt: Math.round(ms * 10) / 10, userId });
  if (rttSamples.length > 120) rttSamples.shift();
}

function onMessage(deliveries) {
  counters.messagesSent += 1;
  counters.deliveries += deliveries;
  bucket().messages += 1;
}
function onUpload(bytes) {
  counters.filesUploaded += 1;
  counters.bytesUploaded += bytes;
  bucket().uploadBytes += bytes;
}
function onDownload(bytes) {
  counters.filesDownloaded += 1;
  counters.bytesDownloaded += bytes;
}
function onHttp(ms, status) {
  counters.httpRequests += 1;
  counters.httpMsTotal += ms;
  if (status >= 500) counters.http5xx += 1;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

// ---- Activity log (saved in the database, newest first when read) ----
let activityListener = null;
function onActivity(fn) { activityListener = fn; }
function logActivity(kind, userId, detail = '') {
  const createdAt = Date.now();
  const r = q.run('INSERT INTO activity (kind, user_id, detail, created_at) VALUES (?,?,?,?)', kind, userId || null, detail, createdAt);
  // keep the table small: remove everything older than the newest 2000 rows
  if (Number(r.lastInsertRowid) % 200 === 0) q.run('DELETE FROM activity WHERE id <= ?', Number(r.lastInsertRowid) - 2000);
  const row = { id: Number(r.lastInsertRowid), kind, userId: userId || null, detail, createdAt };
  if (activityListener) activityListener(row);
  return row;
}
function recentActivity(limit = 50, kinds = null) {
  const rows = q.all(
    `SELECT a.id, a.kind, a.user_id AS userId, a.detail, a.created_at AS createdAt, u.display_name AS name, u.username
       FROM activity a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.id DESC LIMIT ?`, kinds ? 500 : limit);
  return (kinds ? rows.filter((r) => kinds.includes(r.kind)).slice(0, limit) : rows);
}

function snapshot(extra = {}) {
  const now = Date.now();
  const rtts = rttSamples.map((s) => s.rtt);
  const sorted = [...rtts].sort((a, b) => a - b);
  const all = q.get('SELECT (SELECT COUNT(*) FROM messages WHERE file_id IS NULL) AS messages, (SELECT COUNT(*) FROM files) AS files, (SELECT COALESCE(SUM(size),0) FROM files) AS bytes');
  const per = [];
  for (let i = 14; i >= 0; i--) {
    const k = minuteKey(now - i * 60000);
    const b = buckets.get(k);
    per.push({ t: k, messages: b ? b.messages : 0, uploadBytes: b ? b.uploadBytes : 0 });
  }
  const transports = { websocket: 0, polling: 0 };
  for (const c of connections.values()) transports[c.transport === 'websocket' ? 'websocket' : 'polling'] += 1;
  return {
    serverTime: now,
    startedAt,
    uptimeSec: Math.floor((now - startedAt) / 1000),
    activeConnections: connections.size,
    sinceStart: {
      ...counters,
      httpAvgMs: counters.httpRequests ? Math.round((counters.httpMsTotal / counters.httpRequests) * 10) / 10 : 0,
    },
    allTime: { messages: all.messages, files: all.files, bytesStored: all.bytes },
    latency: {
      count: rtts.length,
      last: rtts.length ? rtts[rtts.length - 1] : null,
      avg: rtts.length ? Math.round((rtts.reduce((a, b) => a + b, 0) / rtts.length) * 10) / 10 : null,
      min: sorted.length ? sorted[0] : null,
      max: sorted.length ? sorted[sorted.length - 1] : null,
      p95: percentile(sorted, 95),
      series: rttSamples.slice(-60).map((s) => ({ t: s.t, rtt: s.rtt })),
    },
    perMinute: per,
    transports,
    connections: [...connections.entries()].map(([id, c]) => ({
      id: id.slice(0, 6), userId: c.userId, name: c.name, username: c.username,
      transport: c.transport, since: c.since, rtt: c.rtt,
    })),
    ...extra,
  };
}

module.exports = {
  counters, connections, startedAt, snapshot, recordRtt, onMessage, onUpload, onDownload, onHttp,
  logActivity, recentActivity, onActivity,
};
