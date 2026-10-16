// JS baseline: one full Overwatch service sweep (align + all OCR cells + ult rings, heroes every
// 900 ms) on Derk's real spectator board (test/fixtures/ow-board-table.png), real tesseract.js.
//   node rust/bench/js-ow-sweep.cjs [runs=5] [workers=4]
const path = require('node:path'); const fs = require('node:fs'); const repo = path.join(__dirname, '..', '..');
const { OverwatchOcrService } = require(path.join(repo, 'electron/overwatch-ocr-service.cjs'));
const { TesseractOcrEngine } = require(path.join(repo, 'electron/valorant-ocr-engine.cjs'));
const { readGray } = require(path.join(repo, 'test/png.cjs'));
const img = readGray(path.join(repo, 'test/fixtures/ow-board-table.png'));
const lum = (x, y) => { const lx = x - 640; const ly = y - 190; return lx < 0 || ly < 0 || lx >= img.width || ly >= img.height ? 0 : img.data[ly * img.width + lx]; };
function cellImage(roi, scale = 4, threshold = 120, pad = 20, shear = 0) {
  const w = roi.w * scale + pad * 2; const h = roi.h * scale + pad * 2; const px = Buffer.alloc(w * h, 255);
  const W = roi.w * scale; const H = roi.h * scale; const inner = Buffer.alloc(W * H, 255);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const fx = roi.x + (x + 0.5) / scale - 0.5; const fy = roi.y + (y + 0.5) / scale - 0.5; const x0 = Math.floor(fx); const y0 = Math.floor(fy); const tx = fx - x0; const ty = fy - y0;
    const l = lum(x0, y0) * (1 - tx) * (1 - ty) + lum(x0 + 1, y0) * tx * (1 - ty) + lum(x0, y0 + 1) * (1 - tx) * ty + lum(x0 + 1, y0 + 1) * tx * ty;
    inner[y * W + x] = 255 - l < threshold ? 0 : 255;
  }
  for (let y = 0; y < H; y += 1) { const shift = shear ? Math.round(shear * (y - H / 2)) : 0; for (let x = 0; x < W; x += 1) { const sx = x - shift; if (sx >= 0 && sx < W) px[(y + pad) * w + x + pad] = inner[y * W + sx]; } }
  return Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), px]);
}
(async () => {
  const runs = Number(process.argv[2]) || 5; const workers = Number(process.argv[3]) || 4;
  const capture = { capture: async () => ({ width: 1920, height: 1080 }), crop: (_f, roi, pre = {}) => ({ image: cellImage(roi, pre.scale || 4, pre.threshold && pre.threshold !== 120 ? 255 - pre.threshold : 120, 20, pre.shear || 0) }), luminance: (_f, x, y) => lum(x, y), rgb: (_f, x, y) => { const l = lum(x, y); return [l, l, l]; } };
  const ocr = new TesseractOcrEngine();
  const svc = new OverwatchOcrService({ capture, ocr });
  svc.configure({ enabled: false, workers });
  const times = [];
  for (let i = 0; i <= runs; i += 1) { svc.lastHeroAt = 0; // heroes every sweep in both (Rust sleeps 950 ms between sweeps)
    const t0 = process.hrtime.bigint(); await svc.sweep(); const ms = Number(process.hrtime.bigint() - t0) / 1e6; if (i) times.push(ms); }
  await ocr.close();
  times.sort((a, b) => a - b);
  console.log(`JS Overwatch sweep (${workers} workers): median ${times[Math.floor(times.length / 2)].toFixed(0)} ms (min ${times[0].toFixed(0)})`);
})();
