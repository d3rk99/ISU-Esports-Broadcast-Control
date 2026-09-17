const test = require('node:test');
const assert = require('node:assert/strict');
const { ValorantOcrService, normalizeSettings } = require('../electron/valorant-ocr-service.cjs');

function fakeFrame(now = Date.now()) {
  return { sourceName: 'VALORANT', capturedAt: now, width: 1920, height: 1080, image: {} };
}

test('OCR settings constrain capture rate and ROI geometry', () => {
  const settings = normalizeSettings({ captureFps: 99, roiOverrides: { timer: { x: -10, y: 5, w: 99999, h: 60 } } });
  assert.equal(settings.captureFps, 15);
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
  const texts = ['2', '1:30', '1'];
  const ocr = { recognize: async () => ({ text: texts.shift(), confidence: 0.99, latencyMs: 4 }) };
  const service = new ValorantOcrService({ capture, ocr, onState: (state) => states.push(state), now: () => now });
  t.after(() => service.stop());
  service.settings = normalizeSettings({ enabled: true });
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
