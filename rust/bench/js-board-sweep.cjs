// Baseline for the Rust comparison: the JS VALORANT board reader on Derk's real frames
// (test/fixtures/val-board-1/2.png). One "sweep" = alignBoard + OCR of every cell, exactly the
// live reader's path (readCell + TesseractOcrEngine, 4-worker grid pool, Promise.all like the
// service lanes). Writes rust/bench/out/js-board.json (values + timings) for the parity check.
//   node rust/bench/js-board-sweep.cjs [runs=5] [workers=4]
const path = require('node:path'); const fs = require('node:fs');
const repo = path.join(__dirname, '..', '..');
const P = require(path.join(repo, 'electron/valorant-board-parse.cjs'));
const { TesseractOcrEngine } = require(path.join(repo, 'electron/valorant-ocr-engine.cjs'));
const { board, cellImage } = require(path.join(repo, 'test/valorant-board-fixtures.cjs'));
(async () => {
  const runs = Number(process.argv[2]) || 5;
  const workers = Number(process.argv[3]) || 4; const ocr = new TesseractOcrEngine(); ocr.observerConcurrency = workers;
  const out = { runs, frames: {} };
  for (const f of ['val-board-1.png', 'val-board-2.png']) {
    const b = board(f); const times = []; let values = null;
    for (let run = 0; run <= runs; run += 1) {
      const t0 = process.hrtime.bigint();
      const a = P.alignBoard(b.lum);
      const cells = P.cellRois(P.PROFILE, a);
      const res = await Promise.all(cells.map((c) => P.readCell(ocr, b.lum, c, (roi, s, t) => cellImage(b.lum, roi, s, t), `observer3-${c.side}-${c.row}-${c.field}`)));
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (run > 0) times.push(ms); // run 0 = worker start-up, not counted
      values = Object.fromEntries(cells.map((c, i) => [`${c.side}:${c.row}:${c.field}`, res[i]]));
    }
    times.sort((x, y) => x - y);
    out.frames[f] = { medianMs: times[Math.floor(times.length / 2)], minMs: times[0], cells: Object.keys(values).length, values };
    console.log(`${f}: ${Object.keys(values).length} cells, median sweep ${out.frames[f].medianMs.toFixed(0)} ms (min ${times[0].toFixed(0)})`);
  }
  await ocr.close();
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', 'js-board.json'), JSON.stringify(out, null, 1));
})();
