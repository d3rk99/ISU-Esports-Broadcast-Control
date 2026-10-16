// Every OCR attempt of one Overwatch cell in the JS service path (real tesseract.js).
//   node rust/bench/js-ow-cell-trace.cjs away 2 assists
const path = require('node:path'); const repo = path.join(__dirname, '..', '..');
const P = require(path.join(repo, 'electron/overwatch-ocr-parse.cjs'));
const { TesseractOcrEngine } = require(path.join(repo, 'electron/valorant-ocr-engine.cjs'));
const { readGray } = require(path.join(repo, 'test/png.cjs'));
const img = readGray(path.join(repo, 'test/fixtures/ow-board-table.png'));
const lum = (x, y) => { const lx = x - 640; const ly = y - 190; return lx < 0 || ly < 0 || lx >= img.width || ly >= img.height ? 0 : img.data[ly * img.width + lx]; };
function cellImage(roi, scale = 4, threshold = 120, pad = 20) {
  const w = roi.w * scale + pad * 2; const h = roi.h * scale + pad * 2; const px = Buffer.alloc(w * h, 255);
  for (let y = 0; y < roi.h * scale; y += 1) for (let x = 0; x < roi.w * scale; x += 1) {
    const fx = roi.x + (x + 0.5) / scale - 0.5; const fy = roi.y + (y + 0.5) / scale - 0.5; const x0 = Math.floor(fx); const y0 = Math.floor(fy); const tx = fx - x0; const ty = fy - y0;
    const l = lum(x0, y0) * (1 - tx) * (1 - ty) + lum(x0 + 1, y0) * tx * (1 - ty) + lum(x0, y0 + 1) * (1 - tx) * ty + lum(x0 + 1, y0 + 1) * tx * ty;
    px[(y + pad) * w + x + pad] = 255 - l < threshold ? 0 : 255;
  }
  return Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), px]);
}
(async () => {
  const [side, row, field] = process.argv.slice(2);
  const p = P.getProfile(); const a = P.alignBoard(lum, p);
  const cell = P.cellRois(p, { ...a, boxScale: 1.08 }).find((c) => c.side === side && c.row === Number(row) && c.field === field);
  console.log('roi', JSON.stringify(cell.roi), 'glyphs', P.glyphCount(lum, cell.roi));
  const ocr = new TesseractOcrEngine();
  for (const [scale, mode] of [[4, 'line'], [4, 'char'], [6, 'char']]) {
    const r = await ocr.recognize(cellImage(cell.roi, scale), { allowedChars: cell.column.allowedChars, kind: 'score', fieldId: 'x', pageMode: mode });
    console.log(`scale=${scale} ${mode}`, JSON.stringify({ text: r.text, conf: r.confidence }));
  }
  await ocr.close();
})();
