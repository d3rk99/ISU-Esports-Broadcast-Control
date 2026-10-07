const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { bridgeKeyMatches, keepAlive } = require('../electron/bridge-link.cjs');
const { SpectateReceiver } = require('../electron/spectate-receiver.cjs');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function openBridge(port, token = 'bridge-key') {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/game-bridge?token=${token}&game=valorant`);
    socket.once('message', () => resolve(socket)); // welcome
    socket.once('error', reject);
  });
}

test('spectate receiver: wrong key rejected; right key gets the candidate names and delivers spectated packets', async (t) => {
  const port = await reservePort();
  const got = [];
  const rx = new SpectateReceiver({ onSpectated: (s) => got.push(s) });
  t.after(() => rx.stop());
  rx.setCandidates([{ name: 'Sn0wfal', station: 1, side: 'home' }, { name: '', station: 2 }]);
  rx.configure({ enabled: true, port, token: 'bridge-key' });
  await wait(100);
  const bad = new WebSocket(`ws://127.0.0.1:${port}/game-bridge?token=nope`);
  const code = await new Promise((r) => bad.on('close', (c) => r(c)));
  assert.equal(code, 1008, 'wrong key closed');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/game-bridge?token=bridge-key&game=valorant`);
  const msgs = [];
  ws.on('message', (raw) => msgs.push(JSON.parse(String(raw))));
  await new Promise((r) => ws.on('open', r)); await wait(100);
  const cands = msgs.find((m) => m.type === 'spectate-candidates');
  assert.deepEqual(cands.candidates.map((c) => c.name), ['Sn0wfal'], 'blank names dropped');
  rx.setCandidates([{ name: 'nyv', station: 8, side: 'away' }]); await wait(80);
  assert.equal(msgs.filter((m) => m.type === 'spectate-candidates').at(-1).candidates[0].name, 'nyv', 'changes pushed live');
  ws.send(JSON.stringify({ type: 'spectated', game: 'valorant', version: 1, sequence: 1, payload: { name: 'nyv', station: 8, side: 'away' } }));
  await wait(80);
  assert.equal(got.at(-1).name, 'nyv'); assert.equal(got.at(-1).station, 8); assert.ok(got.at(-1).receivedAt > 0);
  ws.close();
});

test('keepAlive terminates a link that stops answering pings, and leaves a healthy one alone', () => {
  const ticks = [];
  const fakeTimers = {
    setIntervalImpl: (fn) => { ticks.push(fn); return { unref() {} }; },
    clearIntervalImpl: () => {}
  };
  const healthy = Object.assign(new EventEmitter(), { pings: 0, terminated: false, ping() { this.pings += 1; this.emit('pong'); }, terminate() { this.terminated = true; } });
  keepAlive(healthy, fakeTimers);
  for (let i = 0; i < 5; i += 1) ticks[0]();
  assert.equal(healthy.terminated, false);
  assert.equal(healthy.pings, 5);

  const dead = Object.assign(new EventEmitter(), { pings: 0, terminated: false, ping() { this.pings += 1; }, terminate() { this.terminated = true; } });
  keepAlive(dead, fakeTimers);
  ticks[1](); // first ping goes out, no pong comes back
  assert.equal(dead.terminated, false);
  ticks[1](); // next tick: still no pong -> terminate
  assert.equal(dead.terminated, true);
});

test('bridgeKeyMatches is exact and rejects empty keys', () => {
  assert.equal(bridgeKeyMatches('bridge-key', 'bridge-key'), true);
  assert.equal(bridgeKeyMatches('bridge-key', 'bridge-kez'), false);
  assert.equal(bridgeKeyMatches('bridge-key', 'bridge-key-extra'), false);
  assert.equal(bridgeKeyMatches('bridge-key', null), false);
  assert.equal(bridgeKeyMatches('', ''), false);
});
