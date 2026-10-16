// Overwatch parity: the REAL JS overwatch-ocr-parse.cjs + overwatch-hero-match.cjs on Derk's real
// boards (normal, perks, player view), the 20 hero portraits, the READY / charging rings, plus the
// cell images the live preprocessing builds (hashed) and scripted consensus sweeps.
// Writes rust/crates/isu-ocr/tests/parity-overwatch.json.   node rust/scripts/parity-overwatch.cjs
const path = require('node:path'); const fs = require('node:fs'); const crypto = require('node:crypto');
const repo = path.join(__dirname, '..', '..');
const P = require(path.join(repo, 'electron/overwatch-ocr-parse.cjs'));
const { HeroMatcher } = require(path.join(repo, 'electron/overwatch-hero-match.cjs'));
const { readGray, readRgb } = require(path.join(repo, 'test/png.cjs'));
const out = { boards: [], heroes: [], rings: [], parse: [], consensus: [] };
const sampler = (rel, ox, oy) => { const img = readGray(path.join(repo, rel)); return (x, y) => { const lx = x - ox; const ly = y - oy; return lx < 0 || ly < 0 || lx >= img.width || ly >= img.height ? 0 : img.data[ly * img.width + lx]; }; };
// test/overwatch-ocr.test.cjs cellImageFrom, minus the PGM header
function cellImageFrom(sample, roi, scale = 4, threshold = 120, pad = 20, shear = 0) {
  const w = roi.w * scale + pad * 2; const h = roi.h * scale + pad * 2; const px = Buffer.alloc(w * h, 255);
  if (shear) {
    const inner = cellImageFrom(sample, roi, scale, threshold, 0); const W = roi.w * scale; const H = roi.h * scale;
    for (let y = 0; y < H; y += 1) { const shift = Math.round(shear * (y - H / 2)); for (let x = 0; x < W; x += 1) { const sx = x - shift; if (sx >= 0 && sx < W) px[(y + pad) * w + x + pad] = inner[y * W + sx]; } }
    return px;
  }
  for (let y = 0; y < roi.h * scale; y += 1) for (let x = 0; x < roi.w * scale; x += 1) {
    const fx = roi.x + (x + 0.5) / scale - 0.5; const fy = roi.y + (y + 0.5) / scale - 0.5; const x0 = Math.floor(fx); const y0 = Math.floor(fy); const tx = fx - x0; const ty = fy - y0;
    const lum = sample(x0, y0) * (1 - tx) * (1 - ty) + sample(x0 + 1, y0) * tx * (1 - ty) + sample(x0, y0 + 1) * (1 - tx) * ty + sample(x0 + 1, y0 + 1) * tx * ty;
    px[(y + pad) * w + x + pad] = 255 - lum < threshold ? 0 : 255;
  }
  return px;
}
const profile = P.getProfile();
for (const [rel, ox, oy] of [['test/fixtures/ow-board-table.png', 640, 190], ['test/fixtures/ow-board-perks.png', 480, 140], ['test/fixtures/ow-board-player-view.png', 200, 140]]) {
  const lum = sampler(rel, ox, oy);
  const header = P.headerColumns(lum, profile);
  const align = P.alignBoard(lum, profile);
  const cells = P.cellRois(profile, { ...align, boxScale: 1.08 });
  const ring = profile.ultimateRing;
  const ult = profile.teams.flatMap((t) => t.rowCenters.map((cy0, row) => { const dy = align.rows[`${t.id}:${row}`].statDy; const cy = cy0 + (Math.abs(dy) >= 3 ? dy : 0); const rcx = ring.cx + (align.leftDx || 0); return { ready: P.isReadyDisc(lum, rcx, cy + ring.dy, ring.readyRadius || 12), fill: P.ringFill(lum, rcx, cy + ring.dy, ring.radius) }; }));
  out.boards.push({ file: rel, ox, oy, header, align, cells: cells.map((c) => {
    const kind = c.field === 'name' ? 'text' : 'score';
    const pre = { ...profile.preprocess, ...(c.column.shear ? { shear: c.column.shear } : {}), ...(c.column.threshold ? { threshold: c.column.threshold } : {}) };
    const thr = pre.threshold && pre.threshold !== 120 ? 255 - pre.threshold : 120;
    const img = cellImageFrom(lum, c.roi, pre.scale || 4, thr, 20, pre.shear || 0);
    return { side: c.side, row: c.row, field: c.field, roi: c.roi, glyphs: kind === 'score' ? P.glyphCount(lum, c.roi) : null, img: crypto.createHash('sha256').update(img).digest('hex'), scale: pre.scale || 4, thr, shear: pre.shear || 0 };
  }), ult });
}
const strip = readRgb(path.join(repo, 'test/fixtures/ow-hero-portraits.png'));
const hm = new HeroMatcher();
for (let i = 0; i < 20; i += 1) {
  const rgbAt = (x, y) => { const sx = x - 580; const sy = y - 500 + i * 60 + 30; const o = (sy * strip.width + sx) * 3; return [strip.data[o], strip.data[o + 1], strip.data[o + 2]]; };
  out.heroes.push(hm.match(rgbAt, 500));
}
out.heroBlank = hm.match(() => [40, 40, 40], 500);
for (const f of ['ow-ult-ready.png', 'ow-ult-charging.png']) { const at = sampler(`test/fixtures/${f}`, 0, 0); out.rings.push({ file: f, disc: P.discFill(at, 30, 30), ready: P.isReadyDisc(at, 30, 30), ring: P.ringFill(at, 30, 30, 16) }); }
for (const [field, text] of [['name', '  DAMAGE   1 '], ['name', 'X'], ['name', 'A'.repeat(25)], ['ultimate', '1O0'], ['ultimate', '101'], ['elims', 'l2'], ['elims', '200'], ['damage', '1,535'], ['damage', '99999'], ['damage', '100000'], ['healing', 'S8B'], ['mitigation', ''], ['deaths', 'abc']])
  out.parse.push({ field, text, value: P.parseCell(field, text) });
const bd = P.emptyBoard(); const c = new P.OverwatchConsensus(); let t = 0;
const seq = [[['home', 0, 'damage', 500]], [['home', 0, 'damage', 500]], [['home', 0, 'damage', 4000]], [['home', 0, 'damage', 4000]], [['home', 0, 'damage', 4000]], [['home', 0, 'damage', 4000]], [['home', 0, 'damage', 300]], [['home', 0, 'ultimate', 40]], [['home', 0, 'ultimate', 40]], [['home', 0, 'ultimate', 5]], [['home', 0, 'ultimate', 5]], [['home', 0, 'hero', 'Ana']], [['home', 0, 'hero', 'Ana']], [['home', 0, 'name', 'TANK 1']], [['home', 0, 'name', 'TANK 1']], [['home', 0, 'name', 'TANK 1']], [['away', 4, 'bogus', 1]], [['away', 4, 'elims', 3]], [['away', 4, 'elims', 3]], [['away', 4, 'elims', 9]], [['away', 4, 'elims', 9]]];
for (const s of seq) { t += 500; const changed = P.applySweep(bd, c, s.map(([side, row, field, value]) => ({ side, row, field, value })), t); out.consensus.push({ sweep: s, now: t, changed, board: JSON.parse(JSON.stringify(bd)) }); }
fs.writeFileSync(path.join(__dirname, '..', 'crates', 'isu-ocr', 'tests', 'parity-overwatch.json'), JSON.stringify(out));
console.log('boards', out.boards.length, 'cells', out.boards.reduce((n, b) => n + b.cells.length, 0), 'heroes', out.heroes.filter((h) => h.hero).length, '/ 20');
