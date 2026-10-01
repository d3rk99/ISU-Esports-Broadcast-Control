'use strict';
// Live recording while streaming with a delay. The recording must start within a couple of
// seconds (LIVE), while the RTMP receiver still gets nothing until the delay elapses. The file
// must be decodable H.264+AAC from the same single encoder. Then an encoder restart (settings
// change) must roll to a new file instead of breaking the recording.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { findFfmpeg } = require('../../core/media/ffmpeg.cjs');
const { RealEngine } = require('../../core/media/engine.cjs');
const { startReceiver } = require('./receiver.cjs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration', '-of', 'json', f]).toString());

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isu-rec-'));
  const recDir = path.join(dir, 'recordings');
  const engine = new RealEngine({ ffmpeg: await findFfmpeg(), storageDir: path.join(dir, 'delay'), credentials: { open: (c) => c }, logger: { write() {} } });
  await engine.init();
  const rx = await startReceiver(path.join(dir, 'rx.ts'));
  engine.configureDestinations([{ id: 'o', name: 'o', enabled: true, protocol: 'RTMP', serverUrl: rx.url, credential: 'test-key' }]);
  const config = { input: { type: 'test' }, encoder: { mode: 'hardware', resolution: '1280x720', fps: 59.94, videoBitrate: 3000, audioBitrate: 128 }, delaySeconds: 12 };
  await engine.startProgram(config);
  const t0 = performance.now();
  await engine.startRecording({ directory: recDir, segmentMinutes: 30 });
  let recStartedAfter = null;
  while (performance.now() - t0 < 10000) {
    if (engine.recorder.state === 'RECORDING' && engine.recorder.bytes > 0) { recStartedAfter = (performance.now() - t0) / 1000; break; }
    await wait(50);
  }
  while (!engine.ready()) await wait(100);
  await engine.startAll();
  await wait(9000);
  const streamFirstAfter = rx.firstMediaAt ? (rx.firstMediaAt - t0) / 1000 : null;
  // Settings change -> encoder restart -> recorder must roll to a new file and keep going.
  await engine.startProgram({ ...config, encoder: { ...config.encoder, videoBitrate: 2500 } });
  await wait(6000);
  const snap = engine.snapshot().recording;
  await engine.stopRecording();
  await engine.close();
  await rx.stop();
  const files = fs.existsSync(recDir) ? fs.readdirSync(recDir).filter((f) => f.endsWith('.mkv')).sort() : [];
  const info = files.map((f) => { const p = probe(path.join(recDir, f)); return { file: f, streams: p.streams.map((s) => `${s.codec_type}:${s.codec_name}`), duration: Number(p.format.duration).toFixed(1) }; });
  const report = { recordingStartedAfterS: recStartedAfter?.toFixed(2), streamFirstMediaAfterS: streamFirstAfter?.toFixed(2), delaySeconds: config.delaySeconds, recorderState: snap.state, files: info };
  console.log(JSON.stringify(report, null, 1));
  const pass = recStartedAfter !== null && recStartedAfter < 4 && streamFirstAfter !== null && streamFirstAfter >= config.delaySeconds && files.length >= 2 && info.every((f) => f.streams.includes('video:h264') && f.streams.includes('audio:aac') && Number(f.duration) > 3);
  console.log(pass ? 'RECORDING PASS' : 'RECORDING FAIL');
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
