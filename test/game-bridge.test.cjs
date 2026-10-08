const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { UniversalGameBridge, createGameEnvelope, normalizeBridgeSettings } = require('../electron/game-bridge.cjs');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

test('universal bridge settings: VALORANT mode is the spectated-player tracker only (scoreboard is read on the Graphics PC)', () => {
  const settings = normalizeBridgeSettings({
    game: 'valorant', graphicsHost: ' 192.168.1.50 ', bridgePort: 3175, bridgeToken: 'key',
    rocketLeague: { tcpPort: 49130 },
    spectate: { windowName: 'VALORANT-Win64-Shipping', roi: { x: 700, y: 900, w: 500, h: 50 } }
  });
  assert.equal(settings.game, 'valorant');
  assert.equal(settings.graphicsHost, '192.168.1.50');
  assert.equal(settings.rocketLeague.tcpPort, 49130);
  assert.equal(settings.valorant, undefined, 'no scoreboard OCR on the bridge anymore');
  assert.equal(settings.spectate.enabled, true);
  assert.equal(settings.spectate.windowName, 'VALORANT-Win64-Shipping');
  assert.deepEqual(settings.spectate.roi, { x: 700, y: 900, w: 500, h: 50 });
  assert.equal(normalizeBridgeSettings({ game: 'rocketleague' }).spectate.enabled, false, 'RL: API names the spectated player');
});

test('universal bridge envelopes identify game, version, sequence and payload', () => {
  const valorant = createGameEnvelope('valorant', { teams: {} }, 42, 1000);
  assert.deepEqual(valorant, {
    type: 'game-state', game: 'valorant', version: 1, sequence: 42, capturedAt: 1000, payload: { teams: {} }
  });
  const rocketLeague = createGameEnvelope('rocketleague', { Event: 'UpdateState' }, 7, 2000);
  assert.equal(rocketLeague.type, 'game-telemetry');
  assert.equal(rocketLeague.game, 'rocketleague');
});

test('VALORANT bridge: spectate tracker sends who is watched to the Graphics PC receiver', async (t) => {
  const { SpectateReceiver } = require('../electron/spectate-receiver.cjs');
  const port = await reservePort();
  const got = [];
  const rx = new SpectateReceiver({ onSpectated: (s) => got.push(s) });
  rx.setCandidates([{ name: 'Sn0wfal', station: 1, side: 'home' }]);
  rx.configure({ enabled: true, port, token: 'key-123' });
  t.after(() => rx.stop());
  // fake capture + fake OCR that always "reads" the name: 3 sweeps -> confirmed
  const capture = { capture: async () => { await new Promise((r) => setTimeout(r, 16)); return { width: 1920, height: 1080 }; }, rgb: () => [255, 255, 255] };
  const ocr = { recognize: async () => ({ text: 'Sn0wfal', confidence: 0.9 }) };
  const bridge = new UniversalGameBridge({ capture, ocr });
  t.after(() => bridge.stop());
  bridge.spectate.readName = async () => ({ winner: { name: 'Sn0wfal', score: 0.95, n: 4 }, reads: [] });
  bridge.start({ game: 'valorant', graphicsHost: '127.0.0.1', bridgePort: port, bridgeToken: 'key-123', spectate: { intervalMs: 120 } });
  for (let i = 0; i < 40 && !got.some((s) => s.name); i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(bridge.spectate.candidates.length, 1, 'bridge got the names from the controller');
  assert.equal(got.find((s) => s.name)?.name, 'Sn0wfal');
  assert.equal(got.find((s) => s.name)?.station, 1);
});

test('bridge Overwatch mode: spectate tracker with the trained Overwatch name model', () => {
  const s = normalizeBridgeSettings({ game: 'overwatch', graphicsHost: '10.0.0.2', bridgeToken: 'k' });
  assert.equal(s.game, 'overwatch');
  assert.equal(s.spectate.enabled, true, 'tracker on for Overwatch');
  assert.equal(s.spectate.windowName, 'Overwatch');
  assert.equal(s.spectate.portrait, null, 'no portrait fast path for Overwatch (name only)');
});
