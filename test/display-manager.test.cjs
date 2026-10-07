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
    assert.deepEqual(s3.messages.slice(0, 3), [{ type: 'welcome', station: 3 }, { type: 'mode', mode: 'ndi', source: 'ISU Stage 03' }, { type: 'noise', on: false, volume: 30 }]);
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

test('display manager: groups 1-5 and 6-10 switch separately', async () => {
  const dm = new DisplayManager({ port: 0, host: '127.0.0.1' });
  await dm.start();
  try {
    const s2 = await station(dm.port, { station: 2, hostname: 'V2' });
    const s7 = await station(dm.port, { station: 7, hostname: 'JV7' });
    assert.equal(dm.setMode('6-10', 'mirror').ok, true);
    assert.equal(dm.setMode('1-5', 'ndi').ok, true); await wait(80);
    assert.equal(s7.messages.at(-1).mode, 'mirror', '6-10 stays on game mirror');
    assert.equal(s2.messages.at(-1).mode, 'ndi', '1-5 on NDI');
    const modes = dm.status().stations.map((s) => s.mode);
    assert.deepEqual(modes, ['ndi', 'ndi', 'ndi', 'ndi', 'ndi', 'mirror', 'mirror', 'mirror', 'mirror', 'mirror']);
    assert.deepEqual(dm.setMode('6-10', 'mirror').stations, [6, 7, 8, 9, 10]);
    assert.equal(dm.setMode('11-15', 'ndi').ok, false);
    s2.ws.close(); s7.ws.close();
  } finally { await dm.stop(); }
});

test('display manager: pink noise per station, per group, toggle, volume-only, and re-sent on reconnect', async () => {
  const dm = new DisplayManager({ port: 0, host: '127.0.0.1' });
  await dm.start();
  try {
    const s2 = await station(dm.port, { station: 2, hostname: 'PC2' });
    const s7 = await station(dm.port, { station: 7, hostname: 'PC7' });
    const last = (s) => s.messages.filter((m) => m.type === 'noise').at(-1);
    assert.equal(dm.setNoise('1-5', true, 40).ok, true); await wait(80);
    assert.deepEqual(last(s2), { type: 'noise', on: true, volume: 40 });
    assert.deepEqual(last(s7), { type: 'noise', on: false, volume: 30 }, '6-10 untouched');
    dm.setNoise('all', 'keep', 55); await wait(80);
    assert.deepEqual(last(s2), { type: 'noise', on: true, volume: 55 }, 'volume only keeps on');
    assert.deepEqual(last(s7), { type: 'noise', on: false, volume: 55 }, 'volume only keeps off');
    assert.equal(dm.setNoise('all', 'toggle').on, true, 'mixed group toggles ON, never half and half');
    assert.equal(dm.setNoise('all', 'toggle').on, false);
    dm.setNoise(7, true, 250); await wait(80);
    assert.deepEqual(last(s7), { type: 'noise', on: true, volume: 100 }, 'volume capped at 100');
    s7.ws.send(JSON.stringify({ type: 'status', state: 'receiving', noise: { state: 'playing', device: 'Headset (USB)', error: '' } })); await wait(80);
    const row = dm.status().stations.find((s) => s.station === 7);
    assert.equal(row.noiseState, 'playing'); assert.equal(row.noiseDevice, 'Headset (USB)');
    s7.ws.close(); await wait(100);
    const back = await station(dm.port, { station: 7, hostname: 'PC7' });
    assert.deepEqual(last(back), { type: 'noise', on: true, volume: 100 }, 'reconnect gets the noise back');
    assert.equal(dm.setNoise(11, true).ok, false);
    s2.ws.close(); back.ws.close();
  } finally { await dm.stop(); }
});
