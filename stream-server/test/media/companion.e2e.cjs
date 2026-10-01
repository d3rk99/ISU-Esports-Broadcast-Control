'use strict';
// Real engine + real API over HTTP (the exact calls the Companion module makes):
//  - preview: JPEG frames decoded from the program, audio meters from the 1 kHz test tone
//  - start while buffering -> 409 locked, nothing reaches the receiver
//  - after the delay: start via API -> out1 LIVE + HEALTHY, all_enabled_healthy true
//  - record toggle via API, kill the receiver -> out1 leaves HEALTHY, stop via API cancels retry
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConfigStore, defaults } = require('../../core/config.cjs');
const { StreamService } = require('../../core/service.cjs');
const { ApiServer } = require('../../core/api.cjs');
const { startReceiver } = require('./receiver.cjs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isu-cmp-'));
  const rx = await startReceiver(path.join(dir, 'rx.ts'));
  const store = new ConfigStore(dir, { seal: (s) => `sealed:${s}`, open: (c) => c.replace(/^sealed:/, '') });
  const cfg = defaults();
  cfg.encoder = { ...cfg.encoder, resolution: '1280x720', videoBitrate: 3000, audioBitrate: 128 };
  cfg.delaySeconds = 8;
  cfg.recording = { directory: path.join(dir, 'rec'), segmentMinutes: 30 };
  cfg.destinations = [{ id: 'o1', name: 'Local test', enabled: true, protocol: 'RTMP', serverUrl: rx.url, credential: 'sealed:test-key' }, { id: 'o2', name: 'Off', enabled: false, protocol: 'RTMP', serverUrl: '', credential: '' }];
  store.save(cfg);
  const service = new StreamService(store, { write() {} }, { dataDir: dir });
  await service.initialize();
  let frames = 0; let jpegOk = false; const meters = [];
  service.on('preview', (jpeg) => { frames += 1; jpegOk = jpeg[0] === 0xff && jpeg[1] === 0xd8; });
  service.on('meter', (m) => meters.push(m));
  let queue = Promise.resolve();
  const enqueue = (fn) => { const r = queue.then(fn); queue = r.catch(() => {}); return r; };
  const KEY = 'test-api-key-0123456789abcdef';
  const api = new ApiServer({ run: (a, p) => enqueue(() => service.command(a, p)), getStatus: () => service.fullStatus(), getKey: () => KEY, logger: { write() {} } });
  await api.start({ port: 0, lan: false });
  const base = `http://127.0.0.1:${api.server.address().port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'X-ISU-Stream-Key': KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; };
  const vars = async () => (await call('GET', '/api/variables')).json;

  await wait(2500);
  const early = await call('POST', '/api/stream/start');
  const earlyVars = await vars();
  while (!(await vars()).delay_ready) await wait(250);
  const start = await call('POST', '/api/stream/start');
  let live = null;
  for (let i = 0; i < 60 && !(live = await vars()).all_enabled_healthy; i++) await wait(250);
  const rec = await call('POST', '/api/recording/toggle');
  await wait(3000);
  const recVars = await vars();
  const sseRes = await fetch(`${base}/api/events`, { headers: { 'X-ISU-Stream-Key': KEY } });
  const sseReader = sseRes.body.getReader();
  const sse = new TextDecoder().decode((await sseReader.read()).value);
  await sseReader.cancel();
  rx.child.kill('SIGKILL');
  let failed = null;
  for (let i = 0; i < 60; i++) { failed = await vars(); if (!failed.out1_healthy && failed.out1_health !== 'HEALTHY') break; await wait(250); }
  const stop = await call('POST', '/api/outputs/1/stop');
  await wait(2500);
  const stopped = await vars();
  await call('POST', '/api/recording/stop');
  await api.stop(); await service.close(); await rx.stop();
  const peaks = meters.slice(-20).map((m) => Math.max(...m.peak));
  const report = {
    previewFrames: frames, jpegOk, meterUpdates: meters.length, tonePeakDb: Math.max(...peaks).toFixed(1),
    earlyStart: { status: early.status, error: early.json.error }, earlyLocked: earlyVars.outputs_locked, earlyDelayPercent: earlyVars.delay_percent,
    start: start.status,
    live: { out1_live: live.out1_live, out1_health: live.out1_health, program_healthy: live.program_healthy, problems: live.program_problems, all_enabled_healthy: live.all_enabled_healthy, outputs_total: live.outputs_total, fps: live.fps },
    recording: { status: rec.status, recording: recVars.recording, recording_seconds: recVars.recording_seconds },
    sseHasVars: /"out1_name":"Local test"/.test(sse),
    afterKill: { out1_state: failed.out1_state, out1_health: failed.out1_health, any_live: failed.any_live },
    afterStop: { status: stop.status, out1_state: stopped.out1_state, out1_health: stopped.out1_health }
  };
  console.log(JSON.stringify(report, null, 1));
  const pass = frames >= 5 && jpegOk && meters.length >= 20 && Math.max(...peaks) > -30
    && early.status === 409 && earlyVars.outputs_locked
    && start.status === 200 && live.out1_live && live.out1_health === 'HEALTHY' && live.all_enabled_healthy && live.outputs_total === 1
    && rec.status === 200 && recVars.recording && report.sseHasVars
    && failed.out1_health !== 'HEALTHY' && stop.status === 200 && stopped.out1_state === 'STOPPED';
  console.log(pass ? 'COMPANION PASS' : 'COMPANION FAIL');
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
