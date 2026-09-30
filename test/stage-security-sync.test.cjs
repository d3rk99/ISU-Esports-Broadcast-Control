const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { StageDisplayManager, safeTokenEqual } = require('../electron/stage-displays/stage-display-manager.cjs');
const { ClockSync } = require('../electron/stage-displays/clock-sync.cjs');

let nextPort = 38000 + Math.floor(Math.random() * 2000);

async function startManager(options = {}) {
  const port = nextPort++;
  const manager = new StageDisplayManager({ port, host: '127.0.0.1', ...options });
  await manager.start();
  await new Promise((resolve) => (manager.wss.address() ? resolve() : manager.wss.once('listening', resolve)));
  return { manager, url: `ws://127.0.0.1:${port}/stage` };
}

function connect(url, register) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    const messages = [];
    socket.on('message', (data) => messages.push(JSON.parse(String(data))));
    socket.on('open', () => socket.send(JSON.stringify({ type: 'register', ...register })));
    socket.on('close', (code, reason) => { socket.closedWith = { code, reason: String(reason) }; });
    setTimeout(() => resolve({ socket, messages }), 150);
  });
}

function stop(manager, ...sockets) {
  for (const s of sockets) { try { s.terminate(); } catch {} }
  manager.shutdown();
}

test('stage key: stations with a wrong or missing key are refused', async () => {
  const { manager, url } = await startManager({ token: 'correct-horse' });
  const bad = await connect(url, { station: 3, hostname: 'PC-3', token: 'nope' });
  const none = await connect(url, { station: 4, hostname: 'PC-4' });
  assert.equal(bad.socket.closedWith?.code, 1008);
  assert.equal(none.socket.closedWith?.code, 1008);
  assert.equal(manager.stations.get(3).online, false);
  assert.equal(manager.stations.get(4).online, false);
  assert.ok(manager.eventLog.some((e) => e.type === 'client_rejected' && e.station === 3));
  stop(manager, bad.socket, none.socket);
});

test('stage key: correct key registers; no key configured stays open (backwards compatible)', async () => {
  const locked = await startManager({ token: 'correct-horse' });
  const good = await connect(locked.url, { station: 5, hostname: 'PC-5', token: 'correct-horse' });
  assert.equal(good.socket.closedWith, undefined);
  assert.equal(locked.manager.stations.get(5).online, true);
  assert.equal(good.messages[0].command, 'registered');
  stop(locked.manager, good.socket);

  const open = await startManager();
  const legacy = await connect(open.url, { station: 6, hostname: 'PC-6' });
  assert.equal(open.manager.stations.get(6).online, true);
  assert.equal(open.manager.status().keyRequired, false);
  stop(open.manager, legacy.socket);
});

test('duplicate station: a second PC claiming the same number is refused and warned about', async () => {
  const { manager, url } = await startManager();
  const first = await connect(url, { station: 2, hostname: 'STAGE-PC-A' });
  const second = await connect(url, { station: 2, hostname: 'STAGE-PC-B' });
  assert.equal(first.socket.closedWith, undefined, 'the original owner stays connected');
  assert.equal(second.socket.closedWith?.code, 4009);
  assert.equal(manager.stations.get(2).hostname, 'STAGE-PC-A');
  assert.ok(manager.status().warnings.some((w) => w.includes('Station 02') && w.includes('STAGE-PC-B')));
  stop(manager, first.socket, second.socket);
});

test('duplicate station: the same PC reconnecting replaces its old socket', async () => {
  const { manager, url } = await startManager();
  const first = await connect(url, { station: 7, hostname: 'STAGE-PC-7' });
  const again = await connect(url, { station: 7, hostname: 'STAGE-PC-7' });
  assert.equal(first.socket.closedWith?.code, 4000);
  assert.equal(again.socket.closedWith, undefined);
  assert.equal(manager.stations.get(7).online, true);
  stop(manager, first.socket, again.socket);
});

test('time sync: manager echoes pings with its own clock', async () => {
  let fakeNow = 5_000_000;
  const { manager, url } = await startManager({ now: () => fakeNow });
  const client = await connect(url, { station: 8, hostname: 'PC-8' });
  client.socket.send(JSON.stringify({ type: 'time_sync', clientSentAt: 123, offsetMs: 400, rttMs: 12 }));
  await new Promise((r) => setTimeout(r, 100));
  const reply = client.messages.find((m) => m.command === 'time_sync');
  assert.deepEqual({ clientSentAt: reply.clientSentAt, serverAt: reply.serverAt }, { clientSentAt: 123, serverAt: 5_000_000 });
  assert.equal(manager.stations.get(8).clockOffsetMs, 400);
  stop(manager, client.socket);
});

test('clock sync: executeAt is translated onto a station clock that is 750 ms behind', () => {
  // Station clock = controller clock - 750 ms. Network one-way = 5 ms.
  const sync = new ClockSync();
  for (let i = 0; i < 4; i += 1) {
    const localSent = 1_000_000 + i * 100;
    const serverAt = localSent + 750 + 5;
    sync.addSample(localSent, serverAt, localSent + 10);
  }
  assert.equal(Math.round(sync.offsetMs), 750);
  // Controller says "play at controller time 2,000,000 ms" -> station must fire at its own 1,999,250 ms.
  assert.equal(sync.toLocalSeconds(2000), 1999.25);
  assert.equal(sync.toLocalSeconds(0), null);
});

test('clock sync: slow/noisy samples do not drag the estimate', () => {
  const sync = new ClockSync();
  sync.addSample(0, 205, 10);        // offset 200, rtt 10 (good)
  sync.addSample(100, 305, 110);     // offset 200, rtt 10 (good)
  sync.addSample(200, 900, 800);     // rtt 600 (noisy, offset 400)
  sync.addSample(300, 5000, 2500);   // rtt 2200 -> rejected outright
  assert.equal(Math.round(sync.offsetMs), 200);
});

test('http: stage API requires the key when one is set; OPTIONS stays open for preflight', async () => {
  const manager = new StageDisplayManager({ token: 'correct-horse' });
  const server = http.createServer((req, res) => manager.handleHttp(req, res, new URL(req.url, 'http://x')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'text/plain', ...headers }, body: '{}' });
  assert.equal((await post('/api/stage/mode/blackout')).status, 401);
  assert.equal((await post('/api/stage/mode/blackout', { 'X-Stage-Token': 'wrong' })).status, 401);
  assert.equal((await post('/api/stage/mode/blackout', { 'X-Stage-Token': 'correct-horse' })).status, 200);
  assert.equal((await post('/api/stage/mode/blackout?token=correct-horse')).status, 200);
  assert.equal((await fetch(`${base}/api/stage/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/stage/status`, { method: 'OPTIONS' })).status, 204);
  server.close();
});

test('http: oversized bodies get a 413 instead of a hung request', async () => {
  const manager = new StageDisplayManager();
  const server = http.createServer((req, res) => manager.handleHttp(req, res, new URL(req.url, 'http://x')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/stage/mode/blackout`, {
    method: 'POST', body: 'x'.repeat(1024 * 1024 + 10)
  });
  assert.equal(response.status, 413);
  server.close();
});

test('safeTokenEqual rejects empty and different-length keys', () => {
  assert.equal(safeTokenEqual('', ''), false);
  assert.equal(safeTokenEqual('abc', 'abcd'), false);
  assert.equal(safeTokenEqual('abc', 'abc'), true);
});
