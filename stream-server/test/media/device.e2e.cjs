'use strict';
// Real capture device through the whole pipeline: listDevices -> pick one -> ONE encode ->
// delay -> local RTMP receiver. Pass a device id (or the first video device is used).
// Usage: node test/media/device.e2e.cjs [device] [WxH] [format]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { findFfmpeg } = require('../../core/media/ffmpeg.cjs');
const { listDevices } = require('../../core/media/devices.cjs');
const { RealEngine } = require('../../core/media/engine.cjs');
const { startReceiver } = require('./receiver.cjs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ffmpeg = await findFfmpeg();
  const found = await listDevices(ffmpeg.path);
  const device = process.argv[2] || found.video[0]?.id;
  if (!device) { console.log('SKIP: no capture device on this machine'); process.exit(0); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isu-dev-'));
  const engine = new RealEngine({ ffmpeg, storageDir: path.join(dir, 'delay'), credentials: { open: (c) => c }, logger: { write() {} } });
  await engine.init();
  const rx = await startReceiver(path.join(dir, 'rx.ts'));
  engine.configureDestinations([{ id: 'o', name: 'o', enabled: true, protocol: 'RTMP', serverUrl: rx.url, credential: 'test-key' }]);
  const input = { type: 'device', videoDevice: device, audioDevice: '', videoSize: process.argv[3] || '', deviceFormat: process.argv[4] || '', framerate: '' };
  const config = { input, encoder: { mode: ffmpeg.nvencUsable ? 'hardware' : 'software', resolution: '1280x720', fps: 30, videoBitrate: 3000, audioBitrate: 128 }, delaySeconds: 4 };
  await engine.startProgram(config);
  const t0 = Date.now();
  while (!engine.ready() && Date.now() - t0 < 30000) await wait(100);
  const readyAfter = (Date.now() - t0) / 1000;
  await engine.startAll();
  await wait(7000);
  const snap = engine.snapshot();
  await engine.close(); await rx.stop();
  let streams = []; let frame = '';
  try {
    streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', rx.file]).toString()).streams.map((s) => `${s.codec_type}:${s.codec_name}${s.width ? ` ${s.width}x${s.height}` : ''}`);
    frame = process.env.FRAME_OUT || path.join(dir, 'frame.png');
    execFileSync('ffmpeg', ['-v', 'error', '-sseof', '-1', '-i', rx.file, '-frames:v', '1', '-y', frame]);
  } catch {}
  const report = { device, mode: input.videoSize || 'default', readyAfterS: readyAfter.toFixed(1), fps: snap.encoder.fps, dropped: snap.encoder.dropped, out: snap.outputs[0]?.state, sentMB: ((snap.outputs[0]?.sentBytes || 0) / 1e6).toFixed(1), streams, error: snap.error };
  console.log(JSON.stringify(report, null, 1));
  const pass = snap.encoder.frames > 0 && streams.some((s) => s.startsWith('video:h264')) && streams.includes('audio:aac') && report.out === 'CONNECTED';
  console.log(pass ? 'DEVICE PASS' : 'DEVICE FAIL');
  if (!process.env.FRAME_OUT) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
