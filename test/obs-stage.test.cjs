const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const { ObsClient, setupStageScenes, stageStatus, authString, stationUrl, ALL_SCENE } = require('../electron/obs-stage.cjs');

// Minimal obs-websocket 5 server: Hello/Identify with auth, and the requests the setup uses.
function fakeObs({ password = 'pw', ndiInstalled = true } = {}) {
  const obs = { scenes: new Map(), inputs: new Map(), video: null, program: '', requests: [] };
  const salt = 'c2FsdA=='; const challenge = 'Y2hhbGxlbmdl';
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ op: 0, d: { obsStudioVersion: '31.1.2', obsWebSocketVersion: '5.6.2', rpcVersion: 1, authentication: { salt, challenge } } }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.op === 1) {
        if (msg.d.authentication !== authString(password, salt, challenge)) return ws.close(4009);
        return ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      }
      const { requestType: t, requestId, requestData: q = {} } = msg.d;
      obs.requests.push(t);
      const reply = (data, ok = true, code = 100, comment = '') => ws.send(JSON.stringify({ op: 7, d: { requestType: t, requestId, requestStatus: { result: ok, code, comment }, responseData: data } }));
      const scene = (name) => obs.scenes.get(name);
      switch (t) {
        case 'GetVersion': return reply({ obsVersion: '31.1.2', obsWebSocketVersion: '5.6.2' });
        case 'GetSourceFilterKindList': return reply({ sourceFilterKinds: ndiInstalled ? ['color_filter', 'ndi_filter'] : ['color_filter'] });
        case 'SetVideoSettings': obs.video = q; return reply({});
        case 'GetVideoSettings': return reply({ fpsNumerator: 30, fpsDenominator: 1, outputWidth: 1280, outputHeight: 720 });
        case 'GetSceneList': return reply({ scenes: [...obs.scenes.keys()].map((sceneName) => ({ sceneName })) });
        case 'GetInputList': return reply({ inputs: [...obs.inputs.keys()].map((inputName) => ({ inputName })) });
        case 'CreateScene': if (obs.scenes.has(q.sceneName)) return reply({}, false, 601); obs.scenes.set(q.sceneName, { items: [], filters: new Map() }); return reply({});
        case 'CreateInput': if (obs.inputs.has(q.inputName)) return reply({}, false, 601); obs.inputs.set(q.inputName, { kind: q.inputKind, settings: q.inputSettings }); scene(q.sceneName).items.push(q.inputName); return reply({});
        case 'SetInputSettings': Object.assign(obs.inputs.get(q.inputName).settings, q.inputSettings); return reply({});
        case 'GetSourceFilterList': return reply({ filters: [...scene(q.sourceName).filters.keys()].map((filterName) => ({ filterName })) });
        case 'CreateSourceFilter': scene(q.sourceName).filters.set(q.filterName, { kind: q.filterKind, settings: q.filterSettings, enabled: true }); return reply({});
        case 'SetSourceFilterSettings': Object.assign(scene(q.sourceName).filters.get(q.filterName).settings, q.filterSettings); return reply({});
        case 'SetSourceFilterEnabled': scene(q.sourceName).filters.get(q.filterName).enabled = q.filterEnabled; return reply({});
        case 'GetSourceFilter': return reply({ filterEnabled: scene(q.sourceName).filters.get(q.filterName).enabled });
        case 'GetSceneItemList': return reply({ sceneItems: scene(q.sceneName).items.map((sourceName) => ({ sourceName })) });
        case 'CreateSceneItem': scene(q.sceneName).items.push(q.sourceName); return reply({});
        case 'SetCurrentProgramScene': obs.program = q.sceneName; return reply({});
        case 'GetSourceActive': return reply({ videoActive: obs.program === ALL_SCENE && scene(ALL_SCENE).items.includes(q.sourceName) });
        case 'GetStats': return reply({ activeFps: 30, cpuUsage: 12.4, averageFrameRenderTime: 3.2, renderSkippedFrames: 0, outputSkippedFrames: 0 });
        default: return reply({}, false, 204, 'unknown');
      }
    });
  });
  return new Promise((resolve) => wss.on('listening', () => resolve({ obs, port: wss.address().port, close: () => new Promise((r) => wss.close(r)) })));
}

test('OBS stage: auth, builds 10 station scenes + browser pages + DistroAV NDI filters, idempotent', async () => {
  const { obs, port, close } = await fakeObs();
  const client = new ObsClient();
  try {
    await client.connect({ port, password: 'pw' });
    const first = await setupStageScenes(client, { controllerUrl: 'http://10.0.0.5:3174' });
    assert.equal(first.ndiNames.length, 10);
    assert.deepEqual(obs.video, { baseWidth: 1280, baseHeight: 720, outputWidth: 1280, outputHeight: 720, fpsNumerator: 30, fpsDenominator: 1 });
    const page = obs.inputs.get('ISU Stage 03 Page');
    assert.equal(page.kind, 'browser_source');
    assert.equal(page.settings.url, 'http://10.0.0.5:3174/overlays/stage.html?station=3');
    assert.equal(page.settings.width, 1280);
    const filter = obs.scenes.get('ISU Stage 03').filters.get('ISU Stage 03 NDI');
    assert.equal(filter.kind, 'ndi_filter');
    assert.equal(filter.settings.ndi_filter_ndiname, 'ISU Stage 03');
    assert.equal(obs.program, ALL_SCENE);
    assert.equal(obs.scenes.get(ALL_SCENE).items.length, 10);
    // Second run (e.g. controller IP changed): nothing duplicated, URL updated.
    await setupStageScenes(client, { controllerUrl: 'http://10.0.0.9:3174' });
    assert.equal(obs.scenes.size, 11);
    assert.equal(obs.scenes.get(ALL_SCENE).items.length, 10);
    assert.equal(obs.inputs.get('ISU Stage 03 Page').settings.url, 'http://10.0.0.9:3174/overlays/stage.html?station=3');
    const status = await stageStatus(client);
    assert.equal(status.stations.filter((s) => s.active && s.ndiOn).length, 10);
    assert.equal(status.resolution, '1280x720');
  } finally { client.close(); await close(); }
});

test('OBS stage: wrong password and missing DistroAV give clear errors', async () => {
  const a = await fakeObs();
  const client = new ObsClient();
  await assert.rejects(client.connect({ port: a.port, password: 'nope' }), /refused the password/);
  await a.close();
  const b = await fakeObs({ ndiInstalled: false });
  try {
    await client.connect({ port: b.port, password: 'pw' });
    await assert.rejects(setupStageScenes(client, { controllerUrl: 'http://x:3174' }), /DistroAV is not installed/);
  } finally { client.close(); await b.close(); }
});

test('OBS stage: station URL', () => {
  assert.equal(stationUrl('http://192.168.1.20:3174', 10), 'http://192.168.1.20:3174/overlays/stage.html?station=10');
});
