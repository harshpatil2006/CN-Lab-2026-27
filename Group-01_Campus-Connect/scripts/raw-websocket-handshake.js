// Sends a hand-written WebSocket upgrade request over a plain TCP socket and prints what the server answers.
const net = require('net');
// Usage: node scripts/raw-websocket-handshake.js [host] [port]   (defaults: 127.0.0.1 3000)
const HOST = process.argv[2] || '127.0.0.1';
const PORT = Number(process.argv[3] || 3000);
function attempt(title, headers, keyBytes) {
  return new Promise((resolve) => {
    const lines = ['GET /socket.io/?EIO=4&transport=websocket HTTP/1.1', 'Host: ' + HOST + ':' + PORT, 'Upgrade: websocket', 'Connection: Upgrade',
      'Sec-WebSocket-Key: ' + Buffer.from(keyBytes).toString('base64'), 'Sec-WebSocket-Version: 13', ...headers, '', ''];
    const s = net.connect(PORT, HOST, () => s.write(lines.join('\r\n')));
    let buf = Buffer.alloc(0);
    s.on('data', (d) => { buf = Buffer.concat([buf, d]); });
    setTimeout(() => {
      console.log(`### ${title}`);
      console.log(`local port ${s.localPort} -> ${HOST}:${PORT}`);
      console.log(lines.join('\n').trimEnd());
      console.log('--- reply ---');
      console.log(buf.toString('latin1').replace(/\r\n/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '').trimEnd());
      console.log('');
      s.destroy(); resolve();
    }, 700);
  });
}
(async () => {
  await attempt('A. Valid handshake (16-byte key)', [], 'campusconnect001');
  await attempt('B. Invalid key (17 bytes)', [], 'campusconnect0001');
  await attempt('C. Handshake from another website (Origin: http://evil.example)', ['Origin: http://evil.example'], 'campusconnect001');
})();
