'use strict';
// A/V sync through the real pipeline (encode once -> delay -> RTMP receiver). The source flashes
// WHITE and BEEPS at exactly the same instants (every 1 s, 100 ms long). At the receiver we find each
// flash (video luma) and each beep (audio level) and measure beep - flash. Also checks the manual
// sync offset moves audio the right way. Usage: node test/media/avsync.e2e.cjs
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { findFfmpeg } = require('../../core/media/ffmpeg.cjs');
const { RealEngine } = require('../../core/media/engine.cjs');
const { startReceiver } = require('./receiver.cjs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Source: a file whose picture flashes WHITE and whose audio BEEPS at exactly the same instants
// (every 1 s, 100 ms long). Played through the normal 'file' input (looped, real time).
function makeSyncClip(dir) {
  const file = path.join(dir, 'sync.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', "color=c=black:s=1280x720:r=60000/1001:d=30,geq=lum='if(lt(mod(T\\,1)\\,0.1)\\,235\\,16)':cb=128:cr=128",
    '-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t\\,1)\\,0.1)\\,0.5*sin(2*PI*1000*t)\\,0)':s=48000:c=stereo:d=30",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-c:a', 'pcm_s16le', '-y', file]);
  return file;
}

function onsets(times, values, threshold) {
  const out = []; let on = false;
  for (let i = 0; i < times.length; i++) { const hit = values[i] > threshold; if (hit && !on) out.push(times[i]); on = hit; }
  return out;
}

function measure(file) {
  const v = execFileSync('ffprobe', ['-v', 'error', '-f', 'lavfi', '-i', `movie=${file},signalstats`, '-show_entries', 'frame=pts_time:frame_tags=lavfi.signalstats.YAVG', '-of', 'csv=p=0']).toString().trim().split('\n').map((l) => l.split(',').map(Number));
  const a = execFileSync('ffprobe', ['-v', 'error', '-f', 'lavfi', '-i', `amovie=${file},asetnsamples=48,astats=metadata=1:reset=1`, '-show_entries', 'frame=pts_time:frame_tags=lavfi.astats.Overall.Peak_level', '-of', 'csv=p=0']).toString().trim().split('\n').map((l) => l.split(',').map(Number));
  const flashes = onsets(v.map((r) => r[0]), v.map((r) => r[1]), 120);
  const beeps = onsets(a.map((r) => r[0]), a.map((r) => (Number.isFinite(r[1]) ? r[1] : -200)), -20);
  const diffs = [];
  for (const f of flashes) { const b = beeps.reduce((best, x) => (Math.abs(x - f) < Math.abs(best - f) ? x : best), Infinity); if (Math.abs(b - f) < 0.5) diffs.push((b - f) * 1000); }
  const avg = diffs.reduce((s, d) => s + d, 0) / (diffs.length || 1);
  return { flashes: flashes.length, matched: diffs.length, avgMs: Math.round(avg), spreadMs: Math.round(Math.max(...diffs) - Math.min(...diffs)) };
}

async function run(offsetMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isu-sync-'));
  const ff = await findFfmpeg();
  const clip = makeSyncClip(dir);
  const engine = new RealEngine({ ffmpeg: ff, storageDir: path.join(dir, 'd'), credentials: { open: (c) => c }, logger: { write() {} } });
  await engine.init();
  const rx = await startReceiver(path.join(dir, 'rx.ts'));
  engine.configureDestinations([{ id: 'o', name: 'o', enabled: true, protocol: 'RTMP', serverUrl: rx.url, credential: 'test-key' }]);
  await engine.startProgram({ input: { type: 'file', file: clip, audioOffsetMs: offsetMs }, encoder: { mode: ff.nvencUsable ? 'hardware' : 'software', resolution: '1280x720', fps: 59.94, videoBitrate: 3000, audioBitrate: 128 }, delaySeconds: 3 });
  while (!engine.ready()) await wait(100);
  await engine.startAll(); await wait(12000);
  await engine.close(); await rx.stop();
  const r = measure(rx.file);
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

(async () => {
  const zero = await run(0);
  const shifted = await run(200);
  console.log(JSON.stringify({ offset0: zero, offsetPlus200: shifted }));
  // In sync: within one video frame (~17 ms). The +200 ms offset must move audio ~200 ms later.
  const pass = zero.matched >= 8 && Math.abs(zero.avgMs) <= 25 && zero.spreadMs <= 40 && Math.abs(shifted.avgMs - zero.avgMs - 200) <= 30;
  console.log(pass ? 'AVSYNC PASS' : 'AVSYNC FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
