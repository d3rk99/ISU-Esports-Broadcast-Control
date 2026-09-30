const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { bridgeKeyMatches, keepAlive } = require('../electron/bridge-link.cjs');
const { ValorantOcrService, normalizeSettings } = require('../electron/valorant-ocr-service.cjs');
const { createGameEnvelope } = require('../electron/game-bridge.cjs');

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

// A real, fully-shaped VALORANT state (same shape the Bridge forwards), tagged with a marker.
const baseState = new ValorantOcrService().normalizedState();

function sendState(socket, sequence, marker) {
  socket.send(JSON.stringify(createGameEnvelope('valorant', { ...JSON.parse(JSON.stringify(baseState)), marker }, sequence)));
}

test('valorant receiver accepts a restarted Bridge whose sequence starts over at 1', async (t) => {
  const port = await reservePort();
  const received = [];
  const service = new ValorantOcrService({ onState: () => {} });
  const originalOnState = service.onState;
  service.onState = (state) => { received.push(service.remoteState?.marker); originalOnState?.(state); };
  service.configure(normalizeSettings({ enabled: true, source: 'remote', bridgePort: port, bridgeToken: 'bridge-key' }));
  t.after(() => service.stop());
  await wait(100);

  // First Bridge session gets far into the match.
  const first = await openBridge(port);
  sendState(first, 4811, 'before-restart-a');
  sendState(first, 4812, 'before-restart-b');
  await wait(100);
  assert.equal(service.remoteState.marker, 'before-restart-b');
  first.terminate();
  await wait(100);

  // Bridge app restarts: its counter is back to 1.
  const second = await openBridge(port);
  sendState(second, 1, 'after-restart');
  await wait(100);
  assert.equal(service.remoteState.marker, 'after-restart', 'data after a Bridge restart must not be dropped');

  // Within one connection, stale/out-of-order packets are still ignored.
  sendState(second, 3, 'newer');
  sendState(second, 2, 'older-late-packet');
  await wait(100);
  assert.equal(service.remoteState.marker, 'newer');
  second.terminate();
});

test('valorant receiver still rejects a wrong bridge key', async (t) => {
  const port = await reservePort();
  const service = new ValorantOcrService({ onState: () => {} });
  service.configure(normalizeSettings({ enabled: true, source: 'remote', bridgePort: port, bridgeToken: 'bridge-key' }));
  t.after(() => service.stop());
  await wait(100);
  const code = await new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/game-bridge?token=wrong-key&game=valorant`);
    socket.on('close', (closeCode) => resolve(closeCode));
    socket.on('error', () => {});
  });
  assert.equal(code, 1008);
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
