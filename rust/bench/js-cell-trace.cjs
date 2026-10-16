// Prints every OCR attempt of one cell in the JS reader (threshold, scale, text, confidence).
//   node rust/bench/js-cell-trace.cjs val-board-1.png home 0 name
const path = require('node:path'); const repo = path.join(__dirname, '..', '..');
const P = require(path.join(repo, 'electron/valorant-board-parse.cjs'));
const { TesseractOcrEngine } = require(path.join(repo, 'electron/valorant-ocr-engine.cjs'));
const { board, cellImage } = require(path.join(repo, 'test/valorant-board-fixtures.cjs'));
(async () => {
  const [f, side, row, field] = process.argv.slice(2);
  const b = board(f); const a = P.alignBoard(b.lum);
  const cell = P.cellRois(P.PROFILE, a).find((c) => c.side === side && c.row === Number(row) && c.field === field);
  const ocr = new TesseractOcrEngine();
  const real = ocr.recognize.bind(ocr);
  ocr.recognize = async (img, o) => { const r = await real(img, o); console.log(JSON.stringify({ text: r.text, conf: r.confidence })); return r; };
  console.log('roi', JSON.stringify(cell.roi));
  console.log('result', await P.readCell(ocr, b.lum, cell, (roi, s, t) => { console.log(`try thr=${t} scale=${s}`); return cellImage(b.lum, roi, s, t); }));
  await ocr.close();
})();
