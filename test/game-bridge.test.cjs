const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { UniversalGameBridge, createGameEnvelope, normalizeBridgeSettings } = require('../electron/game-bridge.cjs');
const { ValorantOcrService } = require('../electron/valorant-ocr-service.cjs');

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

test('universal bridge settings preserve isolated game adapters', () => {
  const settings = normalizeBridgeSettings({
    game: 'valorant', graphicsHost: ' 192.168.1.50 ', bridgePort: 3175, bridgeToken: 'key',
    rocketLeague: { tcpPort: 49130 },
    valorant: { windowName: 'VALORANT-Win64-Shipping', captureFps: 12 }
  });
  assert.equal(settings.game, 'valorant');
  assert.equal(settings.graphicsHost, '192.168.1.50');
  assert.equal(settings.rocketLeague.tcpPort, 49130);
  assert.equal(settings.valorant.windowName, 'VALORANT-Win64-Shipping');
  assert.equal(settings.valorant.captureFps, 12);
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

test('VALORANT adapter sends normalized simulator state end to end', async (t) => {
  const port = await reservePort();
  const received = [];
  let receiverListening;
  const receiverReady = new Promise((resolve) => { receiverListening = resolve; });
  const receiver = new ValorantOcrService({
    onState: (state) => received.push(state),
    onStatus: (status) => { if (status.state === 'listening') receiverListening(); }
  });
  let bridgeConnected;
  const bridgeReady = new Promise((resolve) => { bridgeConnected = resolve; });
  const bridge = new UniversalGameBridge({
    onStatus: (status) => { if (status.remote?.state === 'connected') bridgeConnected(); }
  });
  t.after(async () => { bridge.stop(); receiver.stop(); });
  receiver.configure({ enabled: true, source: 'remote', bridgePort: port, bridgeToken: 'shared-test-key' });
  await receiverReady;
  bridge.start({ game: 'valorant', graphicsHost: '127.0.0.1', bridgePort: port, bridgeToken: 'shared-test-key' });
  await bridgeReady;
  bridge.startSimulator();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(received.at(-1).source, 'valorant-ocr');
  assert.equal(received.at(-1).match.timerSeconds, 100);
  assert.equal(received.at(-1).teams.home.score, 0);
});
