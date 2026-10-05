'use strict';
// Controller -> OBS link for the stage displays. OBS draws the 10 station pages (Browser
// Sources on the GPU) and sends each one out as NDI "ISU Stage NN" through a DistroAV filter.
// This module talks obs-websocket 5 (rpcVersion 1): connect + auth, then builds/repairs:
//   scene "ISU Stage NN"   -> browser source "ISU Stage NN Page" (controller URL ?station=NN)
//                          -> filter "ISU Stage NN NDI" (kind ndi_filter, ndi_filter_ndiname)
//   scene "ISU Stage All"  -> the 10 station scenes nested, so they are always "showing"
//                             (DistroAV only sends while the parent is showing somewhere).
// Setup is idempotent: run it again and it only fills in what is missing.
const crypto = require('node:crypto');
const WebSocket = require('ws');

const STATION_COUNT = 10;
const pad = (n) => String(n).padStart(2, '0');
const names = (n) => ({ scene: `ISU Stage ${pad(n)}`, input: `ISU Stage ${pad(n)} Page`, filter: `ISU Stage ${pad(n)} NDI`, ndi: `ISU Stage ${pad(n)}` });
const ALL_SCENE = 'ISU Stage All';

function authString(password, salt, challenge) {
  const secret = crypto.createHash('sha256').update(password + salt).digest('base64');
  return crypto.createHash('sha256').update(secret + challenge).digest('base64');
}

function stationUrl(controllerUrl, station) {
  const url = new URL('/overlays/stage.html', controllerUrl);
  url.searchParams.set('station', String(station));
  return url.toString();
}

class ObsClient {
  constructor({ WebSocketImpl = WebSocket, timeoutMs = 8000 } = {}) {
    this.WebSocketImpl = WebSocketImpl;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.pending = new Map();
    this.nextId = 1;
    this.info = null;
  }

  connect({ host = '127.0.0.1', port = 4455, password = '' } = {}) {
    this.close();
    return new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(`ws://${host}:${port}`, 'obswebsocket.json', { handshakeTimeout: this.timeoutMs });
      this.socket = socket;
      const timer = setTimeout(() => { fail(new Error(`OBS did not answer at ${host}:${port} (is OBS open with WebSocket Server enabled?)`)); }, this.timeoutMs);
      let settled = false;
      const fail = (error) => { if (settled) return; settled = true; clearTimeout(timer); try { socket.terminate?.(); } catch {} reject(error); };
      const ok = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
      socket.on('error', (error) => fail(new Error(`Can't reach OBS at ${host}:${port}: ${error.code || error.message}`)));
      socket.on('close', (code) => {
        if (code === 4009) fail(new Error('OBS refused the password (Tools -> WebSocket Server Settings -> Show Connect Info)'));
        else fail(new Error(`OBS closed the connection (${code})`));
        for (const { reject: r } of this.pending.values()) r(new Error('OBS connection closed'));
        this.pending.clear();
      });
      socket.on('message', (raw) => {
        let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.op === 0) {
          this.info = { obsVersion: msg.d.obsStudioVersion, wsVersion: msg.d.obsWebSocketVersion };
          const auth = msg.d.authentication;
          if (auth && !password) return fail(new Error('OBS needs a WebSocket password; enter it in the controller'));
          socket.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 0, ...(auth ? { authentication: authString(password, auth.salt, auth.challenge) } : {}) } }));
        } else if (msg.op === 2) ok(this.info);
        else if (msg.op === 7) {
          const entry = this.pending.get(msg.d.requestId);
          if (!entry) return;
          this.pending.delete(msg.d.requestId);
          if (msg.d.requestStatus?.result) entry.resolve(msg.d.responseData || {});
          else entry.reject(Object.assign(new Error(`${msg.d.requestType}: ${msg.d.requestStatus?.comment || `code ${msg.d.requestStatus?.code}`}`), { code: msg.d.requestStatus?.code }));
        }
      });
    });
  }

  request(requestType, requestData = {}) {
    if (!this.socket || this.socket.readyState !== 1) return Promise.reject(new Error('Not connected to OBS'));
    const requestId = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`${requestType}: OBS did not answer`)); }, this.timeoutMs);
      this.pending.set(requestId, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  }

  close() { const s = this.socket; this.socket = null; try { s?.close(); } catch {} }
}

// RequestStatus 601 = ResourceAlreadyExists: fine for an idempotent setup.
async function ensure(promise) { try { return await promise; } catch (error) { if (error.code === 601) return null; throw error; } }

async function setupStageScenes(client, { controllerUrl, width = 1280, height = 720, fps = 30, stations = STATION_COUNT, setVideo = true } = {}) {
  const log = [];
  const version = await client.request('GetVersion');
  const filterKinds = (await client.request('GetSourceFilterKindList')).sourceFilterKinds || [];
  if (!filterKinds.includes('ndi_filter')) throw new Error('DistroAV is not installed in this OBS (no "ndi_filter" filter). Install DistroAV + the NDI runtime, then restart OBS.');
  if (setVideo) {
    await client.request('SetVideoSettings', { baseWidth: width, baseHeight: height, outputWidth: width, outputHeight: height, fpsNumerator: fps, fpsDenominator: 1 });
    log.push(`video ${width}x${height} @ ${fps}`);
  }
  const existingScenes = new Set(((await client.request('GetSceneList')).scenes || []).map((s) => s.sceneName));
  const existingInputs = new Set(((await client.request('GetInputList')).inputs || []).map((i) => i.inputName));
  const browserSettings = (n) => ({ url: stationUrl(controllerUrl, n), width, height, fps_custom: true, fps, reroute_audio: false, shutdown: false, restart_when_active: false, css: '' });
  for (let n = 1; n <= stations; n += 1) {
    const nm = names(n);
    if (!existingScenes.has(nm.scene)) { await ensure(client.request('CreateScene', { sceneName: nm.scene })); log.push(`scene ${nm.scene}`); }
    if (!existingInputs.has(nm.input)) {
      await ensure(client.request('CreateInput', { sceneName: nm.scene, inputName: nm.input, inputKind: 'browser_source', inputSettings: browserSettings(n), sceneItemEnabled: true }));
      log.push(`browser ${nm.input}`);
    } else {
      await client.request('SetInputSettings', { inputName: nm.input, inputSettings: browserSettings(n), overlay: true });
    }
    const filters = ((await client.request('GetSourceFilterList', { sourceName: nm.scene })).filters || []).map((f) => f.filterName);
    const filterSettings = { ndi_filter_ndiname: nm.ndi, ndi_filter_ndigroups: '' };
    if (!filters.includes(nm.filter)) { await ensure(client.request('CreateSourceFilter', { sourceName: nm.scene, filterName: nm.filter, filterKind: 'ndi_filter', filterSettings })); log.push(`ndi ${nm.ndi}`); }
    else await client.request('SetSourceFilterSettings', { sourceName: nm.scene, filterName: nm.filter, filterSettings, overlay: true });
    await client.request('SetSourceFilterEnabled', { sourceName: nm.scene, filterName: nm.filter, filterEnabled: true });
  }
  // Keep every station scene "showing": nest them all in one scene and put that on Program.
  if (!existingScenes.has(ALL_SCENE)) { await ensure(client.request('CreateScene', { sceneName: ALL_SCENE })); log.push(`scene ${ALL_SCENE}`); }
  const items = new Set(((await client.request('GetSceneItemList', { sceneName: ALL_SCENE })).sceneItems || []).map((i) => i.sourceName));
  for (let n = 1; n <= stations; n += 1) {
    if (!items.has(names(n).scene)) await ensure(client.request('CreateSceneItem', { sceneName: ALL_SCENE, sourceName: names(n).scene, sceneItemEnabled: true }));
  }
  await client.request('SetCurrentProgramScene', { sceneName: ALL_SCENE });
  return { obsVersion: version.obsVersion, wsVersion: version.obsWebSocketVersion, log, ndiNames: Array.from({ length: stations }, (_v, i) => names(i + 1).ndi) };
}

// Live check: which station pages OBS is actually rendering + how OBS is keeping up.
async function stageStatus(client, stations = STATION_COUNT) {
  const stats = await client.request('GetStats');
  const video = await client.request('GetVideoSettings');
  const rows = [];
  for (let n = 1; n <= stations; n += 1) {
    const nm = names(n);
    let active = false; let ndiOn = false;
    try { active = Boolean((await client.request('GetSourceActive', { sourceName: nm.scene })).videoActive); } catch {}
    try { ndiOn = Boolean((await client.request('GetSourceFilter', { sourceName: nm.scene, filterName: nm.filter })).filterEnabled); } catch {}
    rows.push({ station: n, ndi: nm.ndi, active, ndiOn });
  }
  return {
    fps: Math.round((Number(stats.activeFps) || 0) * 10) / 10,
    targetFps: Math.round((video.fpsNumerator / video.fpsDenominator) * 100) / 100,
    resolution: `${video.outputWidth}x${video.outputHeight}`,
    cpu: Math.round(Number(stats.cpuUsage) || 0),
    renderMs: Math.round((Number(stats.averageFrameRenderTime) || 0) * 10) / 10,
    skippedRender: Number(stats.renderSkippedFrames) || 0,
    skippedOutput: Number(stats.outputSkippedFrames) || 0,
    stations: rows
  };
}

module.exports = { ObsClient, setupStageScenes, stageStatus, stationUrl, authString, names, ALL_SCENE, STATION_COUNT };
