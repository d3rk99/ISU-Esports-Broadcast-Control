'use strict';
// One destination's receiver is killed mid-stream. The other must keep receiving without a gap,
// the failed one must go ERROR -> RECONNECTING with a retry, and stop must cancel the retry.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findFfmpeg } = require('../../core/media/ffmpeg.cjs');
const { RealEngine } = require('../../core/media/engine.cjs');
const { startReceiver } = require('./receiver.cjs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isu-iso-'));
  const engine = new RealEngine({ ffmpeg: await findFfmpeg(), storageDir: path.join(dir, 'delay'), credentials: { open: (c) => c }, logger: { write() {} } });
  await engine.init();
  const good = await startReceiver(path.join(dir, 'good.ts'));
  const bad = await startReceiver(path.join(dir, 'bad.ts'));
  engine.configureDestinations([
    { id: 'good', name: 'good', enabled: true, protocol: 'RTMP', serverUrl: good.url, credential: 'test-key' },
    { id: 'bad', name: 'bad', enabled: true, protocol: 'RTMP', serverUrl: bad.url, credential: 'test-key' }
  ]);
  await engine.startProgram({ input: { type: 'test' }, encoder: { mode: 'hardware', resolution: '1280x720', fps: 59.94, videoBitrate: 3000, audioBitrate: 128 }, delaySeconds: 3 });
  while (!engine.ready()) await wait(100);
  await engine.startAll();
  // The receiver only creates its file after probing the incoming stream; wait for real bytes.
  for (let i = 0; i < 200 && !(fs.existsSync(good.file) && fs.statSync(good.file).size > 500000 && fs.existsSync(bad.file)); i++) await wait(100);
  await wait(2000);
  const before = engine.snapshot().outputs;
  bad.child.kill('SIGKILL'); // the "platform" drops us
  const goodBytesAtKill = fs.statSync(good.file).size;
  const states = [];
  const bd = engine.destinations.get('bad');
  bd.on('state', (s) => states.push(s));
  await wait(8000);
  const goodBytesAfter = fs.statSync(good.file).size;
  const mid = engine.snapshot().outputs;
  await engine.stopOutput('bad');
  const retryCancelled = bd.retryTimer === null && bd.state === 'STOPPED';
  await wait(3000);
  const stillStopped = bd.state === 'STOPPED';
  await engine.close();
  await good.stop();
  const report = {
    beforeKill: before.map((o) => `${o.id}:${o.state}`),
    badStates: states,
    afterKill: mid.map((o) => `${o.id}:${o.state} reconnects=${o.reconnectCount}`),
    goodKeptReceivingBytes: goodBytesAfter - goodBytesAtKill,
    retryCancelled, stillStopped
  };
  console.log(JSON.stringify(report, null, 1));
  const pass = before.every((o) => o.state === 'CONNECTED') && report.goodKeptReceivingBytes > 1_000_000 && states.includes('ERROR') && mid.find((o) => o.id === 'good').state === 'CONNECTED' && mid.find((o) => o.id === 'bad').reconnectCount >= 1 && retryCancelled && stillStopped;
  console.log(pass ? 'ISOLATION PASS' : 'ISOLATION FAIL');
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
