'use strict';
// Preview latency, glass-to-glass style: raw frames go into the SAME encoder settings the program
// uses (NVENC/x264, CBR, 2 s GOP), the encoded TS goes through Preview exactly like the engine feeds
// it, and we time from writing the first WHITE frame to the first bright preview JPEG.
// Measured 2026-10-01 (RTX 5090): ~0.27 s (old preview: ~0.75 s). Pass if < 0.5 s.
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { findFfmpeg } = require('../../core/media/ffmpeg.cjs');
const { Preview } = require('../../core/media/preview.cjs');
const { TsReader, PACKET } = require('../../core/media/ts.cjs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ff = await findFfmpeg();
  const W = 640; const H = 360; const FPS = 60;
  const frame = (y) => Buffer.alloc((W * H * 3) / 2, 0).fill(y, 0, W * H).fill(128, W * H);
  const video = ff.nvencUsable ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'll', '-rc', 'cbr'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency'];
  const enc = spawn(ff.path, ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${W}x${H}`, '-r', String(FPS), '-i', 'pipe:0', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-map', '0:v', '-map', '1:a', ...video, '-b:v', '6000k', '-maxrate', '6000k', '-bufsize', '12000k', '-g', '120', '-bf', '0', '-forced-idr', '1', '-c:a', 'aac', '-f', 'mpegts', '-mpegts_flags', '+resend_headers', '-muxdelay', '0', '-pat_period', '0.2', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const preview = new Preview({ ffmpegPath: ff.path });
  const reader = new TsReader(); let carry = Buffer.alloc(0);
  enc.stdout.on('data', (d) => {
    const c = carry.length ? Buffer.concat([carry, d]) : d; const whole = c.length - (c.length % PACKET);
    carry = c.subarray(whole); const packets = c.subarray(0, whole);
    for (let i = 0; i < packets.length; i += PACKET) reader.inspect(packets.subarray(i, i + PACKET));
    preview.feed({ instance: 1, packets, reader });
  });
  const tmp = path.join(os.tmpdir(), `isu-lat-${process.pid}.jpg`);
  let whiteAt = 0; let latency = null;
  preview.on('frame', (jpeg) => {
    if (!whiteAt || latency !== null) return;
    fs.writeFileSync(tmp, jpeg);
    const y = execFileSync(ff.path, ['-v', 'error', '-i', tmp, '-vf', 'scale=1:1,format=gray', '-f', 'rawvideo', '-']).readUInt8(0);
    if (y > 200) latency = Date.now() - whiteAt;
  });
  let n = 0;
  const tick = setInterval(() => { n += 1; const white = n >= FPS * 6; if (white && !whiteAt) whiteAt = Date.now(); enc.stdin.write(frame(white ? 235 : 16)); }, 1000 / FPS);
  await wait(9000);
  clearInterval(tick); enc.kill(); preview.close(); fs.rmSync(tmp, { force: true });
  console.log(JSON.stringify({ flashToPreviewMs: latency }));
  const pass = latency !== null && latency < 500;
  console.log(pass ? 'LATENCY PASS' : 'LATENCY FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
