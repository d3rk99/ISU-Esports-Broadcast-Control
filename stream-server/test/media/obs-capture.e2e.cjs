'use strict';
// OBS-engine path end to end: a capture helper (the Linux stand-in native/capture/test/fake_capture.cpp,
// same live-Matroska output as isu-capture.exe) -> OS pipe -> ONE encoder -> delay -> RTMP receiver.
// Measures flash-vs-beep at the receiver, checks the helper is stopped with the program.
// Needs: g++ (builds the stand-in). Usage: node test/media/obs-capture.e2e.cjs
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { findFfmpeg } = require('../../core/media/ffmpeg.cjs');
const { RealEngine } = require('../../core/media/engine.cjs');
const obs = require('../../core/media/obs-capture.cjs');
const { startReceiver } = require('./receiver.cjs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function onsets(rows, threshold) {
  const out = []; let on = false;
  for (const r of rows) { const t = Number(r[0]); const x = Number(r[r.length - 1]); if (!Number.isFinite(t)) continue; const hit = Number.isFinite(x) && x > threshold; if (hit && !on) out.push(t); on = hit; }
  return out;
}
const rows = (args) => execFileSync('ffprobe', args).toString().trim().split('\n').map((l) => l.split(','));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isu-obs-'));
  const fake = path.join(dir, 'fake-isu-capture');
  execFileSync('g++', ['-std=c++17', '-O2', '-o', fake, path.join(__dirname, '../../native/capture/test/fake_capture.cpp')]);
  // The OBS engine is Windows-only; on this test machine pretend to be Windows with the stand-in exe.
  const real = obs.obsCaptureInput;
  require('../../core/media/sources.cjs');
  const sourcesPath = require.resolve('../../core/media/sources.cjs');
  // Same args the app builds for Windows, but the named pipe becomes a FIFO path on this machine.
  require.cache[require.resolve('../../core/media/obs-capture.cjs')].exports.obsCaptureInput = (input) => {
    const s = real(input, { exe: fake, platform: 'win32' });
    const fifo = path.join(dir, `isu-capture-${Date.now()}.fifo`);
    const swap = (a) => (a === s.helper.pipe ? fifo : a);
    return { ...s, args: s.args.map(swap), helper: { ...s.helper, pipe: fifo, args: s.helper.args.map(swap) } };
  };
  delete require.cache[sourcesPath]; delete require.cache[require.resolve('../../core/media/encoder.cjs')]; delete require.cache[require.resolve('../../core/media/engine.cjs')];
  const { RealEngine: Engine } = require('../../core/media/engine.cjs');

  const ff = await findFfmpeg();
  const engine = new Engine({ ffmpeg: ff, storageDir: path.join(dir, 'd'), credentials: { open: (c) => c }, logger: { write() {} } });
  await engine.init();
  const rx = await startReceiver(path.join(dir, 'rx.ts'));
  engine.configureDestinations([{ id: 'o', name: 'o', enabled: true, protocol: 'RTMP', serverUrl: rx.url, credential: 'test-key' }]);
  await engine.startProgram({ input: { type: 'obs-device', videoDevice: 'Fake Web Presenter', audioDevice: 'Fake Web Presenter Audio' }, encoder: { mode: ff.nvencUsable ? 'hardware' : 'software', resolution: '1280x720', fps: 59.94, videoBitrate: 3000, audioBitrate: 128 }, delaySeconds: 3 });
  const helperRunning = Boolean(engine.encoder.helper);
  const t0 = Date.now();
  while (!engine.ready() && Date.now() - t0 < 30000) await wait(100);
  await engine.startAll(); await wait(12000);
  const stats = engine.snapshot().encoder;
  const helper = engine.encoder.helper;
  await engine.close(); await rx.stop();
  const helperStopped = !helper || helper.exitCode !== null || helper.signalCode !== null;

  const f = rx.file;
  const flashes = onsets(rows(['-v', 'error', '-f', 'lavfi', '-i', `movie=${f},signalstats`, '-show_entries', 'frame=pts_time:frame_tags=lavfi.signalstats.YAVG', '-of', 'csv=p=0']), 120);
  const beeps = onsets(rows(['-v', 'error', '-f', 'lavfi', '-i', `amovie=${f},asetnsamples=48,astats=metadata=1:reset=1`, '-show_entries', 'frame=pts_time:frame_tags=lavfi.astats.Overall.Peak_level', '-of', 'csv=p=0']), -20);
  const diffs = flashes.map((fl) => beeps.reduce((best, b) => (Math.abs(b - fl) < Math.abs(best - fl) ? b : best), Infinity) - fl).filter((d) => Math.abs(d) < 0.5).map((d) => Math.round(d * 1000));
  const avg = diffs.reduce((a, b) => a + b, 0) / (diffs.length || 1);
  console.log(JSON.stringify({ helperRunning, helperStopped, fps: stats.fps, dropped: stats.dropped, flashes: flashes.length, matched: diffs.length, avgMs: Math.round(avg), diffsMs: diffs }));
  // A flash can only appear on a whole video frame (16.7 ms at 59.94), so a perfectly synced source
  // still reads 0..-17 ms (sawtooth). In sync = every beep within one frame (+-20 ms) of its flash.
  const pass = helperRunning && helperStopped && diffs.length >= 8 && diffs.every((d) => Math.abs(d) <= 20);
  console.log(pass ? 'OBS CAPTURE PASS' : 'OBS CAPTURE FAIL');
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
