const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ApiServer } = require('../core/api.cjs');
const { companionVariables } = require('../core/api-variables.cjs');
const { HealthTracker } = require('../core/health.cjs');

const KEY = 'k'.repeat(48);
function fakeStatus(over = {}) {
  return { engine: 'RUNNING', simulation: false, encoder: 'ENCODING', input: { connected: true }, telemetry: { fps: 59.9, droppedFrames: 0, currentBitrateKbps: 6000 }, buffer: { ready: false, filledSeconds: 30, configuredSeconds: 300 }, outputsLocked: true, programHealth: { healthy: false, problems: ['BUFFERING'] }, recording: { state: 'STOPPED' }, outputs: [{ id: 'output-1', name: 'Twitch', state: 'STOPPED', live: false, healthy: false, health: 'OFF' }, { id: 'output-2', name: 'YouTube', state: 'DISABLED', health: 'DISABLED' }], ...over };
}
async function boot(t, status = fakeStatus()) {
  const calls = [];
  const api = new ApiServer({ getKey: () => KEY, getStatus: () => status, run: async (action, args) => { calls.push([action, args]); if (status.outputsLocked && ['startAll', 'start'].includes(action)) throw new Error('Outputs locked: the delay buffer has not filled'); } });
  await api.start({ port: 0, lan: false });
  t.after(() => api.stop());
  const port = api.server.address().port;
  const call = (method, path, { key = KEY, body, headers = {} } = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(key ? { 'X-ISU-Stream-Key': key } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { api, calls, call, port, status };
}

test('API binds loopback only by default and rejects missing/wrong keys and browser origins', async (t) => {
  const { api, call, calls } = await boot(t);
  assert.match(api.state.address, /^127\.0\.0\.1:/);
  assert.equal((await call('GET', '/api/status', { key: '' })).status, 401);
  assert.equal((await call('GET', '/api/status', { key: 'wrong' })).status, 401);
  assert.equal((await call('POST', '/api/stream/start', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal(calls.length, 0);
  const ok = await call('GET', '/api/status');
  assert.equal(ok.status, 200);
  const text = JSON.stringify(await ok.json());
  assert.ok(!text.includes(KEY), 'key never echoed');
});

test('start is refused while locked (409 + reason), outputs resolve by number/name, bad bodies rejected', async (t) => {
  const { call, calls } = await boot(t);
  const locked = await call('POST', '/api/stream/start');
  assert.equal(locked.status, 409);
  assert.match((await locked.json()).error, /locked/);
  assert.equal((await call('POST', '/api/outputs/1/stop')).status, 200);
  assert.equal((await call('POST', '/api/outputs/youtube/stop')).status, 200);
  assert.equal((await call('POST', '/api/outputs/9/start')).status, 404);
  assert.deepEqual(calls.slice(1).map((c) => c[1].id), ['output-1', 'output-2']);
  assert.equal((await call('POST', '/api/delay', { body: { seconds: -5 } })).status, 400);
  assert.equal((await call('POST', '/api/delay', { body: { seconds: 60 } })).status, 200);
  assert.deepEqual(calls.at(-1), ['setDelay', { seconds: 60 }]);
  const big = await call('POST', '/api/delay', { body: { seconds: 60, pad: 'x'.repeat(20000) } });
  assert.equal(big.status, 413);
});

test('event stream pushes variables', async (t) => {
  const { port } = await boot(t);
  const res = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { 'X-ISU-Stream-Key': KEY } });
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const frame = new TextDecoder().decode(value);
  assert.match(frame, /"delay_percent":10/);
  assert.match(frame, /"out1_name":"Twitch"/);
  await reader.cancel();
});

test('health: CONNECTED but no bytes moving = STALLED; flowing = HEALTHY; reconnecting = FAILED', () => {
  let now = 1000;
  const h = new HealthTracker(() => now);
  assert.equal(h.output({ id: 'a', state: 'CONNECTED', sentBytes: 0 }).health, 'STALLED');
  now += 1000;
  assert.equal(h.output({ id: 'a', state: 'CONNECTED', sentBytes: 5e6 }).health, 'HEALTHY');
  now += 6000;
  assert.equal(h.output({ id: 'a', state: 'CONNECTED', sentBytes: 5e6 }).health, 'STALLED');
  now += 1000;
  const lag = h.output({ id: 'a', state: 'CONNECTED', sentBytes: 6e6, droppedChunks: 1 });
  assert.equal(lag.health, 'LAGGING');
  assert.equal(h.output({ id: 'a', state: 'RECONNECTING', sentBytes: 6e6, droppedChunks: 1 }).health, 'FAILED');
  const p = h.program({ encoder: 'ENCODING', uptime: 60, telemetry: { fps: 59.9, droppedFrames: 0 }, buffer: { ready: true }, preview: { running: true, audioLive: true, silentSeconds: 12 } }, 59.94);
  assert.deepEqual(p.problems, ['SILENT']);
  assert.deepEqual(p.severe, []); // silence alone is a warning, not a red PROGRAM PROBLEM
});

test('program health: no false PROGRAM PROBLEM from startup fps, a stray dropped frame, or preview off', () => {
  let now = 0; const h = new HealthTracker(() => now);
  const base = (over) => ({ encoder: 'ENCODING', uptime: 60, telemetry: { fps: 59.9, droppedFrames: 0 }, buffer: { ready: true }, preview: { enabled: true, running: true, audioLive: true, silentSeconds: 0 }, ...over });
  // just restarted: FFmpeg's average fps is still climbing
  assert.deepEqual(h.program(base({ uptime: 2, telemetry: { fps: 20, droppedFrames: 0 } }), 59.94).problems, []);
  // a capture card drops 2 frames: fine. A burst of 60 within 30 s: real problem.
  assert.deepEqual(h.program(base({ telemetry: { fps: 59.9, droppedFrames: 2 } }), 59.94).severe, []);
  now += 5000; assert.deepEqual(h.program(base({ telemetry: { fps: 59.9, droppedFrames: 62 } }), 59.94).severe, ['DROPPED_FRAMES']);
  now += 31000; assert.deepEqual(h.program(base({ telemetry: { fps: 59.9, droppedFrames: 62 } }), 59.94).severe, []); // burst aged out
  // preview turned off: audio can't be judged, so it's not reported as NO_AUDIO
  assert.deepEqual(h.program(base({ telemetry: { fps: 59.9, droppedFrames: 62 }, preview: { enabled: false, running: false, audioLive: false } }), 59.94).problems, []);
  // a real input with no audio track at all: still red
  assert.deepEqual(h.program(base({ telemetry: { fps: 59.9, droppedFrames: 62 }, preview: { enabled: true, running: true, audioLive: false } }), 59.94).severe, ['NO_AUDIO']);
});

test('variables: all_enabled_healthy ignores disabled outputs and needs a healthy program', () => {
  const v = companionVariables(fakeStatus({ programHealth: { healthy: true, problems: [] }, outputsLocked: false, outputs: [{ id: 'a', name: 'Twitch', state: 'CONNECTED', live: true, healthy: true, health: 'HEALTHY' }, { id: 'b', state: 'DISABLED', health: 'DISABLED' }] }));
  assert.equal(v.all_enabled_healthy, true);
  assert.equal(v.outputs_total, 1);
  assert.equal(v.out3_state, 'NONE');
});
