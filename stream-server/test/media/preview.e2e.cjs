'use strict';
// Preview smoothness: real 1080p59.94 6 Mbps program -> Preview. Counts JPEG frames per second
// and resyncs (skips). Every JPEG must decode cleanly. Pass: >= 20 fps, <= 1 resync in 20 s.
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { findFfmpeg } = require('../../core/media/ffmpeg.cjs');
const { RealEngine } = require('../../core/media/engine.cjs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isu-prev-'));
  const engine = new RealEngine({ ffmpeg: await findFfmpeg(), storageDir: path.join(dir, 'd'), credentials: { open: (c) => c }, logger: { write() {} } });
  await engine.init();
  const frames = []; let resyncs = 0; let last = false;
  engine.on('preview', (jpeg) => frames.push({ at: Date.now(), jpeg }));
  await engine.startProgram({ input: { type: 'test' }, encoder: { mode: 'hardware', resolution: '1920x1080', fps: 59.94, videoBitrate: 6000, audioBitrate: 160 }, delaySeconds: 30 });
  const t = setInterval(() => { const c = engine.preview.waitingKeyframe && engine.preview.child; if (c && !last) resyncs++; last = Boolean(c); }, 20);
  await wait(4000); const from = Date.now(); const n0 = frames.length; resyncs = 0;
  await wait(20000);
  clearInterval(t);
  const got = frames.filter((f) => f.at >= from);
  const fps = got.length / 20;
  let bad = 0;
  for (const f of got.filter((_, i) => i % 15 === 0)) { const p = path.join(dir, 'f.jpg'); fs.writeFileSync(p, f.jpeg); try { execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', p, '-f', 'null', '-']); } catch { bad++; } }
  if (got.length) fs.writeFileSync(process.env.FRAME_OUT || path.join(dir, 'last.jpg'), got[got.length - 1].jpeg);
  const gaps = got.slice(1).map((f, i) => f.at - got[i].at); const maxGap = Math.max(0, ...gaps);
  await engine.close();
  console.log(JSON.stringify({ previewFps: fps.toFixed(1), maxGapMs: maxGap, resyncs, badJpegs: bad, programFps: engine.encoder.stats.fps }));
  const pass = fps >= 20 && resyncs <= 1 && bad === 0 && maxGap < 1000;
  console.log(pass ? 'PREVIEW PASS' : 'PREVIEW FAIL');
  fs.rmSync(dir, { recursive: true, force: true }); process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
