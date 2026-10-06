const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { DisplayManager } = require('../electron/displays/display-manager.cjs');
const { NdiReceiver, matches } = require('../electron/displays/ndi-receiver.cjs');

function station(port, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/display`);
    const messages = [];
    ws.on('message', (raw) => messages.push(JSON.parse(String(raw))));
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', ...hello })); setTimeout(() => resolve({ ws, messages }), 120); });
    ws.on('close', (code, reason) => { ws.closeInfo = { code, reason: String(reason) }; });
    ws.on('error', reject);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('display manager: stations get their mode on connect and on change; status tracks them', async () => {
  const dm = new DisplayManager({ port: 0, host: '127.0.0.1' });
  await dm.start();
  try {
    const s3 = await station(dm.port, { station: 3, hostname: 'PC3', version: '1.0' });
    assert.deepEqual(s3.messages.slice(0, 2), [{ type: 'welcome', station: 3 }, { type: 'mode', mode: 'ndi', source: 'ISU Stage 03' }]);
    assert.equal(dm.status().onlineCount, 1);
    dm.setMode(3, 'mirror'); await wait(80);
    assert.deepEqual(s3.messages.at(-1), { type: 'mode', mode: 'mirror', source: 'ISU Stage 03' });
    dm.setMode('all', 'ndi', 'OBS (Custom)'); await wait(80);
    assert.deepEqual(s3.messages.at(-1), { type: 'mode', mode: 'ndi', source: 'OBS (Custom)' });
    s3.ws.send(JSON.stringify({ type: 'status', state: 'receiving', fps: 30 })); await wait(80);
    const row = dm.status().stations.find((s) => s.station === 3);
    assert.equal(row.state, 'receiving'); assert.equal(row.fps, 30); assert.equal(row.hostname, 'PC3');
    assert.equal(dm.setMode(11, 'ndi').ok, false);
    assert.equal(dm.setMode(1, 'wall').ok, false);
    s3.ws.close(); await wait(100);
    assert.equal(dm.status().onlineCount, 0);
  } finally { await dm.stop(); }
});

test('display manager: key required, and a second PC cannot take a station in use', async () => {
  const dm = new DisplayManager({ port: 0, host: '127.0.0.1', key: 'secret' });
  await dm.start();
  try {
    const bad = await station(dm.port, { station: 2, hostname: 'A', key: 'nope' }); await wait(80);
    assert.equal(bad.ws.closeInfo?.code, 4003);
    const a = await station(dm.port, { station: 2, hostname: 'A', key: 'secret' });
    const b = await station(dm.port, { station: 2, hostname: 'B', key: 'secret' }); await wait(80);
    assert.equal(b.ws.closeInfo?.code, 4009);
    assert.equal(a.ws.readyState, WebSocket.OPEN);
    a.ws.close();
  } finally { await dm.stop(); }
});

test('NDI receiver: source name match, missing runtime reported (not thrown)', async () => {
  assert.equal(matches('OBS-PC (ISU Stage 03)', 'ISU Stage 03'), true);
  assert.equal(matches('OBS-PC (ISU Stage 13)', 'ISU Stage 03'), false);
  const statuses = [];
  const r = new NdiReceiver({ onFrame() {}, onStatus: (s) => statuses.push(s), loadNdiImpl: () => ({ ndi: null, error: 'NDI runtime missing' }) });
  await r.start({ source: 'ISU Stage 01' });
  assert.equal(statuses[0].state, 'error');
});
