const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { OverlayEventHub } = require('../electron/overlay-events.cjs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startHub(options = {}) {
  const hub = new OverlayEventHub(options);
  const server = http.createServer((request, response) => hub.add(request, response, { hello: 'initial' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { hub, server, port: server.address().port };
}

// Raw socket client so the test controls whether it reads (a real stalled viewer).
function openClient(port, { read = true } = {}) {
  const socket = net.connect(port, '127.0.0.1', () => socket.write('GET /events HTTP/1.1\r\nHost: x\r\n\r\n'));
  const chunks = [];
  if (read) socket.on('data', (chunk) => { chunks.push(chunk); });
  else socket.pause();
  const text = () => Buffer.concat(chunks).toString('utf8');
  socket.on('error', () => {});
  return { socket, text };
}

test('overlay events: new viewers get the current state right away', async (t) => {
  const { hub, server, port } = await startHub({ heartbeatMs: 0 });
  t.after(() => { hub.close(); server.close(); });
  const client = openClient(port);
  await wait(100);
  assert.equal(hub.size, 1);
  assert.match(client.text(), /retry: 1000\ndata: \{"hello":"initial"\}\n\n/);
  hub.publish({ score: 3 });
  await wait(50);
  assert.match(client.text(), /data: \{"score":3\}\n\n/);
  client.socket.destroy();
});

test('overlay events: a stalled viewer is dropped instead of piling up memory; healthy viewers keep updating', async (t) => {
  const drops = [];
  const { hub, server, port } = await startHub({ heartbeatMs: 0, maxBufferedBytes: 256 * 1024, onDrop: (info) => drops.push(info) });
  t.after(() => { hub.close(); server.close(); });
  let healthyBytes = 0;
  const healthy = net.connect(port, '127.0.0.1', () => healthy.write('GET /events HTTP/1.1\r\nHost: x\r\n\r\n'));
  healthy.on('data', (chunk) => { healthyBytes += chunk.length; });
  healthy.on('error', () => {});
  await wait(50);
  const stalled = openClient(port, { read: false });
  await wait(100);
  assert.equal(hub.size, 2);
  // Real-ish load: ~40 KB full state at ~100/s (the app caps Rocket League at ~30/s).
  const bigState = { blob: 'x'.repeat(40000) };
  let bytesAtDrop = null;
  for (let i = 0; i < 150; i += 1) {
    hub.publish({ ...bigState, i });
    if (drops.length && bytesAtDrop === null) bytesAtDrop = healthyBytes;
    await wait(10);
  }
  await wait(100);
  assert.equal(drops.length, 1, 'exactly one viewer (the stalled one) is dropped');
  assert.ok(drops[0].buffered > 256 * 1024, 'it was dropped for being over the buffer limit');
  assert.equal(hub.size, 1, 'the healthy viewer stays connected');
  assert.ok(healthyBytes > bytesAtDrop + 1_000_000, 'the healthy viewer kept receiving updates after the drop');
  healthy.destroy();
  stalled.socket.destroy();
});

test('overlay events: heartbeat comments keep the stream alive', async (t) => {
  const { hub, server, port } = await startHub({ heartbeatMs: 30 });
  t.after(() => { hub.close(); server.close(); });
  const client = openClient(port);
  await wait(120);
  assert.match(client.text(), /: ping\n\n/);
  client.socket.destroy();
});

test('overlay events: disconnected viewers are removed', async (t) => {
  const { hub, server, port } = await startHub({ heartbeatMs: 0 });
  t.after(() => { hub.close(); server.close(); });
  const client = openClient(port);
  await wait(100);
  assert.equal(hub.size, 1);
  client.socket.destroy();
  await wait(100);
  assert.equal(hub.size, 0);
});
