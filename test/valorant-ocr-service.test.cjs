const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const net = require('node:net');
const { ValorantOcrService, normalizeSettings } = require('../electron/valorant-ocr-service.cjs');

function fakeFrame(now = Date.now()) {
  return { sourceName: 'VALORANT', capturedAt: now, width: 1920, height: 1080, image: {} };
}

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

test('OCR settings constrain capture rate and ROI geometry', () => {
  const settings = normalizeSettings({ captureFps: 99, recordedVideoMode: true, roiOverrides: { timer: { x: -10, y: 5, w: 99999, h: 60 } } });
  assert.equal(settings.captureFps, 15);
  assert.equal(settings.recordedVideoMode, true);
  assert.equal(settings.roiOverrides.timer.x, 0);
  assert.equal(settings.roiOverrides.timer.w, 1920);
});

test('service turns fake OCR readings into normalized state', async (t) => {
  let now = 1000;
  const states = [];
  const capture = {
    capture: async () => fakeFrame(now),
    crop: () => ({ image: Buffer.from('test') }),
    snapshot: () => ({ frameDataUrl: 'data:image/png;base64,test', crops: {} }),
    listWindows: async () => [{ id: 'window:1', name: 'VALORANT' }]
  };
  const texts = ['2', '1:30', '1', '2', '1:30', '1', '2', '1:30', '1'];
  const ocr = { recognize: async () => ({ text: texts.shift(), confidence: 0.99, latencyMs: 4 }) };
  const service = new ValorantOcrService({ capture, ocr, onState: (state) => states.push(state), now: () => now });
  t.after(() => service.stop());
  service.settings = normalizeSettings({ enabled: true });
  await service.tick();
  now += 400;
  await service.tick();
  now += 400;
  await service.tick();
  const latest = states.at(-1);
  assert.equal(latest.fields.homeScore.value, 2);
  assert.equal(latest.fields.timer.displayValue, '1:30');
  assert.equal(latest.fields.awayScore.value, 1);
  assert.equal(latest.source, 'valorant-ocr');
  assert.equal(latest.capture.width, 1920);
  assert.equal(latest.teams.home.score, 2);
  assert.equal(latest.match.timerSeconds, 90);
  assert.equal(service.status.state, 'reading');
  assert.deepEqual(await service.listWindows(), [{ id: 'window:1', name: 'VALORANT' }]);
});

test('temporary empty captures retain the last good frame and recover automatically', async (t) => {
  let now = 1000;
  let attempt = 0;
  const statuses = [];
  const capture = {
    capture: async () => {
      attempt += 1;
      if (attempt >= 2 && attempt <= 5) throw Object.assign(new Error('Window returned an empty frame'), { code: 'CAPTURE_EMPTY' });
      return fakeFrame(now);
    },
    crop: () => ({ image: Buffer.from('test') })
  };
  const ocr = { recognize: async ({}) => ({ text: '0', confidence: 0.99, latencyMs: 1 }) };
  const service = new ValorantOcrService({ capture, ocr, onStatus: (status) => statuses.push(status), now: () => now });
  t.after(() => service.stop());
  service.settings = normalizeSettings({ enabled: true });
  await service.tick();
  const lastGoodFrame = service.latestFrame;
  now += 250;
  await service.tick();
  assert.equal(service.latestFrame, lastGoodFrame);
  assert.equal(statuses.at(-1).state, 'recovering');
  assert.equal(statuses.at(-1).usingLastGoodFrame, true);
  assert.equal(statuses.at(-1).consecutiveCaptureFailures, 1);
  for (let index = 0; index < 3; index += 1) {
    now += 250;
    await service.tick();
  }
  assert.equal(service.status.state, 'degraded');
  assert.equal(service.latestFrame, lastGoodFrame);
  assert.equal(service.status.consecutiveCaptureFailures, 4);
  now += 250;
  await service.tick();
  assert.notEqual(service.status.state, 'recovering');
  assert.equal(service.status.consecutiveCaptureFailures, 0);
  assert.equal(service.status.captureFailures, 4);
  assert.equal(service.status.lastCaptureRecoveredAt, now);
});

test('capture failures provide actionable status', async (t) => {
  const statuses = [];
  const error = Object.assign(new Error('Window containing “VALORANT” was not found'), { code: 'WINDOW_NOT_FOUND' });
  const service = new ValorantOcrService({
    capture: { capture: async () => { throw error; } },
    ocr: {},
    onStatus: (status) => statuses.push(status)
  });
  t.after(() => service.stop());
  service.settings = normalizeSettings({ enabled: true });
  await service.tick();
  assert.equal(statuses.at(-1).state, 'searching-window');
});

test('simulator immediately emits stable test data', (t) => {
  const states = [];
  const service = new ValorantOcrService({ onState: (state) => states.push(state) });
  t.after(() => service.stop());
  service.startSimulator();
  assert.equal(service.status.state, 'simulating');
  assert.equal(states.at(-1).fields.timer.value, 100);
  assert.equal(states.at(-1).fields.homeScore.value, 0);
});

test('remote receiver accepts current universal bridge state and rejects old sequences', async (t) => {
  const port = await reservePort();
  const states = [];
  let listening;
  const ready = new Promise((resolve) => { listening = resolve; });
  const service = new ValorantOcrService({
    onState: (state) => states.push(state),
    onStatus: (status) => { if (status.state === 'listening') listening(); }
  });
  t.after(() => service.stop());
  service.configure({ enabled: true, source: 'remote', bridgePort: port, bridgeToken: 'valorant-test-key' });
  await ready;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/game-bridge?game=valorant&token=valorant-test-key`);
  t.after(() => socket.close());
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const state = {
    source: 'valorant-ocr', connected: true,
    capture: { width: 1920, height: 1080, fps: 8 },
    match: { timerSeconds: 73, timerDisplay: '1:13' },
    teams: { home: { score: 3 }, away: { score: 2 } },
    fields: {
      homeScore: { value: 3, updatedAt: Date.now(), stale: false },
      timer: { value: 73, updatedAt: Date.now(), stale: false },
      awayScore: { value: 2, updatedAt: Date.now(), stale: false }
    },
    metrics: { observations: 20, accepted: 18, rejected: 2 }
  };
  socket.send(JSON.stringify({ type: 'game-state', game: 'valorant', version: 1, sequence: 2, payload: state }));
  socket.send(JSON.stringify({ type: 'game-state', game: 'valorant', version: 1, sequence: 1, payload: { ...state, teams: { home: { score: 0 }, away: { score: 0 } } } }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(states.at(-1).teams.home.score, 3);
  assert.equal(states.at(-1).match.timerSeconds, 73);
  assert.equal(service.status.state, 'reading');
  service.clearState();
  assert.equal(states.at(-1).teams.home.score, null);
});
