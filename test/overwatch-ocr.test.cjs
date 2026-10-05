const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createWorker, OEM, PSM } = require('tesseract.js');
const eng = require('@tesseract.js-data/eng');
const { OverwatchOcrService } = require('../electron/overwatch-ocr-service.cjs');
const { TesseractOcrEngine } = require('../electron/valorant-ocr-engine.cjs');
const { getProfile, cellRois, parseCell, glyphCount, plausibleRead, ringFill, discFill, isReadyDisc, resolveUltimate, OverwatchConsensus, emptyBoard, applySweep } = require('../electron/overwatch-ocr-parse.cjs');

// Fixture: grayscale crop of the real ISU spectator scoreboard (2026-10-05), taken from
// (640,190) on the 1920x1080 grid. Tiny PNG decoder (8-bit gray, no interlace) so the test
// needs no extra dependency.
const FIX = { file: path.join(__dirname, 'fixtures', 'ow-board-table.png'), x: 640, y: 190 };
function readGrayPng(file) {
  const buf = fs.readFileSync(file);
  let at = 8; let width = 0; let height = 0; const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at); const type = buf.toString('ascii', at + 4, at + 8); const data = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); assert.equal(data[8], 8); assert.equal(data[9], 0); }
    if (type === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)); const out = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    const f = raw[y * (width + 1)]; const row = raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1));
    for (let x = 0; x < width; x += 1) {
      const a = x ? out[y * width + x - 1] : 0; const b = y ? out[(y - 1) * width + x] : 0; const c = x && y ? out[(y - 1) * width + x - 1] : 0;
      let v = row[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * width + x] = v & 255;
    }
  }
  return { width, height, data: out };
}

const img = readGrayPng(FIX.file);
const sample = (x, y) => { const lx = x - FIX.x; const ly = y - FIX.y; return lx < 0 || ly < 0 || lx >= img.width || ly >= img.height ? 0 : img.data[ly * img.width + lx]; };

// Same preprocessing as the live service: invert (light text on dark), 4x upscale, threshold,
// white margin. Emits a binary PGM, which tesseract.js reads directly.
function cellImage(roi, scale = 4, threshold = 120, pad = 20, shear = 0) {
  const w = roi.w * scale + pad * 2; const h = roi.h * scale + pad * 2;
  const px = Buffer.alloc(w * h, 255);
  if (shear) {
    // Same as preprocessNativeImage: binarize at scale, then shift each row to undo the slant.
    const inner = cellImage(roi, scale, threshold, 0).subarray(-(roi.w * scale * roi.h * scale));
    const W = roi.w * scale; const H = roi.h * scale;
    for (let y = 0; y < H; y += 1) { const shift = Math.round(shear * (y - H / 2)); for (let x = 0; x < W; x += 1) { const sx = x - shift; if (sx >= 0 && sx < W) px[(y + pad) * w + x + pad] = inner[y * W + sx]; } }
    return Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), px]);
  }
  for (let y = 0; y < roi.h * scale; y += 1) for (let x = 0; x < roi.w * scale; x += 1) {
    // Bilinear upscale (blocky nearest-neighbour digits made tesseract drop lone 0s and 1s).
    const fx = roi.x + (x + 0.5) / scale - 0.5; const fy = roi.y + (y + 0.5) / scale - 0.5;
    const x0 = Math.floor(fx); const y0 = Math.floor(fy); const tx = fx - x0; const ty = fy - y0;
    const lum = sample(x0, y0) * (1 - tx) * (1 - ty) + sample(x0 + 1, y0) * tx * (1 - ty) + sample(x0, y0 + 1) * (1 - tx) * ty + sample(x0 + 1, y0 + 1) * tx * ty;
    const v = 255 - lum;
    px[(y + pad) * w + x + pad] = v < threshold ? 0 : 255;
  }
  return Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), px]);
}

// What the board actually shows (read by hand from the screenshot).
const EXPECTED = {
  home: [[16, 215, 0, 38], [15, 96, 0, 0], [12, 10, 52, 0], [11, 0, 100, 0], [12, 156, 0, 85]],
  away: [[23, 125, 0, 0], [16, 147, 4, 0], [11, 98, 61, 0], [17, 220, 66, 50], [12, 170, 18, 2]]
};

test('Overwatch OCR: every number on the real spectator scoreboard reads correctly', { timeout: 180000 }, async () => {
  const worker = await createWorker(eng.code || 'eng', OEM.LSTM_ONLY, { langPath: eng.langPath, gzip: eng.gzip !== false, cacheMethod: 'none', logger: () => {} });
  await worker.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: PSM.SINGLE_LINE });
  const wrong = [];
  try {
    for (const cell of cellRois(getProfile())) {
      if (cell.field === 'name') continue;
      let { data } = await worker.recognize(cellImage(cell.roi));
      let value = parseCell(cell.field, data.text);
      if (value === null) {
        // Same fallback the live service uses: a lone digit is often dropped in line mode.
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_CHAR });
        for (const scale of [4, 6, 3]) {
          ({ data } = await worker.recognize(cellImage(cell.roi, scale)));
          value = parseCell(cell.field, data.text);
          if (value !== null) break;
        }
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
      }
      const row = EXPECTED[cell.side][cell.row];
      const want = { ultimate: row[0], damage: row[1], healing: row[2], mitigation: row[3], elims: 0, assists: 0, deaths: 0 }[cell.field];
      if (value !== want) wrong.push(`${cell.side}${cell.row + 1}.${cell.field}: read ${JSON.stringify(data.text.trim())} -> ${value}, want ${want}`);
    }
  } finally { await worker.terminate(); }
  assert.deepEqual(wrong, []);
});

test('Overwatch OCR: ring fill only reports READY for a full ring', () => {
  // The printed % is the source of truth (it reads correctly on all 10 players above). The ring
  // is only a fallback for READY, when the number is replaced by an icon.
  const full = () => 255; const empty = () => 30;
  assert.equal(resolveUltimate(null, ringFill(full, 670, 219, 16)), 'READY');
  assert.equal(resolveUltimate(null, ringFill(empty, 670, 219, 16)), null);
  const profile = getProfile();
  for (const team of profile.teams) team.rowCenters.forEach((cy) => {
    assert.ok(ringFill(sample, profile.ultimateRing.cx, cy + profile.ultimateRing.dy, profile.ultimateRing.radius) < 0.97, 'no player on this board is READY');
  });
});

test('Overwatch OCR: parsing, READY and consensus', () => {
  assert.equal(parseCell('damage', '1,2O5'), 1205);
  assert.equal(parseCell('elims', 'l2'), 12);
  assert.equal(parseCell('ultimate', '140'), null);
  assert.equal(parseCell('name', ' Bengal '), 'Bengal');
  assert.equal(resolveUltimate(null, 1), 'READY');
  assert.equal(resolveUltimate(64, 0.64), 64);
  const board = emptyBoard(); const c = new OverwatchConsensus();
  const read = (value) => applySweep(board, c, [{ side: 'home', row: 0, field: 'elims', value }]);
  read(3); assert.equal(board.teams.home.players[0].elims, null, 'one read never shows');
  read(3); assert.equal(board.teams.home.players[0].elims, 3);
  read(4); read(4); assert.equal(board.teams.home.players[0].elims, 4);
  read(1); read(1); read(1); assert.equal(board.teams.home.players[0].elims, 4, 'a drop needs 4 agreeing reads');
  read(1); assert.equal(board.teams.home.players[0].elims, 1);
});

test('Overwatch OCR service: two sweeps of the real board fill every player stat', { timeout: 240000 }, async () => {
  // Fake capture serving the fixture with the live preprocessing (invert, bilinear upscale,
  // threshold); the real tesseract.js engine and consensus gate do the rest.
  const capture = {
    capture: async () => ({ fixture: true, width: 1920, height: 1080 }),
    crop: (_frame, roi, pre = {}) => ({ image: cellImage(roi, pre.scale || 4, pre.threshold || 120, 20, pre.shear || 0) }),
    luminance: (_frame, x, y) => sample(x, y)
  };
  const ocr = new TesseractOcrEngine();
  const states = [];
  const service = new OverwatchOcrService({ capture, ocr, onState: (s) => states.push(s) });
  try {
    await service.sweep();
    assert.equal(service.board.teams.home.players[0].damage, null, 'one sweep is not enough to show a value');
    await service.sweep();
  } finally { await ocr.close(); }
  const got = (side, row) => { const p = service.board.teams[side].players[row]; return [p.ultimate, p.damage, p.healing, p.mitigation, p.elims, p.assists, p.deaths]; };
  for (const side of ['home', 'away']) EXPECTED[side].forEach((row, i) => assert.deepEqual(got(side, i), [...row, 0, 0, 0], `${side}${i + 1}`));
  // Names are italic; with the shear (deskew) every one reads exactly. Names need 3 agreeing
  // reads, so a third sweep shows them.
  await (async () => { const o2 = new TesseractOcrEngine(); service.ocr = o2; try { await service.sweep(); } finally { await o2.close(); } })();
  const names = ['home', 'away'].flatMap((side) => service.board.teams[side].players.map((p) => p.name));
  assert.deepEqual(names, ['DAMAGE 1', 'DAMAGE 2', 'SUPPORT 1', 'SUPPORT 2', 'TANK 1', 'DAMAGE 3', 'DAMAGE 4', 'SUPPORT 3', 'SUPPORT 4', 'TANK 2']);
  assert.equal(service.status.state, 'reading');
  assert.ok(states.length >= 1);
});

// An all-zero board, like the start of a map (what produced random 20 / 139 / 421 values):
// every stat cell blanked to background, then a single '0' glyph copied from a real 0 cell.
function zeroBoardSampler() {
  const profile = getProfile();
  const zeroSrc = { x: 915, y: 214 }; // home1 elims: the real "0" glyph spans x 916-923, y 216-226
  const glyph = []; for (let dy = 0; dy < 14; dy += 1) for (let dx = 0; dx < 10; dx += 1) glyph.push(sample(zeroSrc.x + dx, zeroSrc.y + dy));
  const override = new Map();
  for (const cell of cellRois(profile)) {
    if (cell.field === 'name') continue;
    const { x, y, w, h } = cell.roi;
    for (let yy = y - 2; yy < y + h + 2; yy += 1) for (let xx = x; xx < x + w; xx += 1) override.set(yy * 4000 + xx, 20);
    const gx = x + Math.round(w / 2) - 5; const gy = y + Math.round(h / 2) - 7;
    for (let dy = 0; dy < 14; dy += 1) for (let dx = 0; dx < 10; dx += 1) override.set((gy + dy) * 4000 + gx + dx, glyph[dy * 10 + dx]);
  }
  return (x, y) => (override.has(y * 4000 + x) ? override.get(y * 4000 + x) : sample(x, y));
}

test('Overwatch OCR: digit-count check rejects reads that do not match the picture', () => {
  assert.equal(plausibleRead('damage', 139, 1), null, '3 digits read from a single glyph');
  assert.equal(plausibleRead('damage', 0, 1), 0);
  assert.equal(plausibleRead('ultimate', 20, 1), null);
  assert.equal(plausibleRead('name', 'Bengal', NaN), 'Bengal');
  const zero = zeroBoardSampler();
  for (const cell of cellRois(getProfile())) if (cell.field !== 'name') assert.equal(glyphCount(zero, cell.roi), 1, `${cell.side}${cell.row + 1}.${cell.field}`);
});

test('Overwatch OCR service: an all-zero board stays all zeros (no random values), in parallel', { timeout: 240000 }, async () => {
  const zero = zeroBoardSampler();
  const zeroImage = (roi, scale = 4, threshold = 120, pad = 20) => {
    const w = roi.w * scale + pad * 2; const h = roi.h * scale + pad * 2; const px = Buffer.alloc(w * h, 255);
    for (let y = 0; y < roi.h * scale; y += 1) for (let x = 0; x < roi.w * scale; x += 1) {
      const fx = roi.x + (x + 0.5) / scale - 0.5; const fy = roi.y + (y + 0.5) / scale - 0.5; const x0 = Math.floor(fx); const y0 = Math.floor(fy); const tx = fx - x0; const ty = fy - y0;
      const lum = zero(x0, y0) * (1 - tx) * (1 - ty) + zero(x0 + 1, y0) * tx * (1 - ty) + zero(x0, y0 + 1) * (1 - tx) * ty + zero(x0 + 1, y0 + 1) * tx * ty;
      px[(y + pad) * w + x + pad] = 255 - lum < threshold ? 0 : 255;
    }
    return Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), px]);
  };
  const capture = { capture: async () => ({ width: 1920, height: 1080 }), crop: (_f, roi, pre = {}) => ({ image: zeroImage(roi, pre.scale || 4, pre.threshold || 120) }), luminance: (_f, x, y) => zero(x, y) };
  const ocr = new TesseractOcrEngine();
  const service = new OverwatchOcrService({ capture, ocr });
  service.configure({ workers: 4 });
  const seen = new Set();
  try {
    for (let i = 0; i < 3; i += 1) {
      await service.sweep();
      for (const side of ['home', 'away']) for (const p of service.board.teams[side].players) for (const k of ['ultimate', 'elims', 'assists', 'deaths', 'damage', 'healing', 'mitigation']) if (p[k] !== null) seen.add(p[k]);
    }
  } finally { service.stop(); await ocr.close(); }
  assert.deepEqual([...seen], [0], `values shown on an all-zero board: ${[...seen].join(', ')}`);
});

test('Overwatch OCR service: refuses a frame that is not on the 1080p grid', async () => {
  const service = new OverwatchOcrService({ capture: { capture: async () => ({ width: 1280, height: 1024 }), crop: () => ({}) }, ocr: { recognize: async () => ({ text: '', confidence: 0 }) } });
  await assert.rejects(service.sweep(), /1280x1024/);
});

test('Overwatch OCR: debug capture returns every cell with its crop, raw text, digit count and verdict', { timeout: 120000 }, async () => {
  const capture = {
    capture: async () => ({ width: 1920, height: 1080, sourceWidth: 2560, sourceHeight: 1440, sourceName: 'Overwatch', backend: 'fixture', image: { toDataURL: () => 'data:image/png;base64,AA==' } }),
    crop: (_f, roi, pre = {}) => ({ image: cellImage(roi, pre.scale || 4, pre.threshold || 120), rawDataUrl: 'data:raw', processedDataUrl: 'data:proc' }),
    luminance: (_f, x, y) => sample(x, y)
  };
  const ocr = new TesseractOcrEngine();
  const service = new OverwatchOcrService({ capture, ocr });
  let debug;
  try { debug = await service.debugCapture(); } finally { await ocr.close(); }
  assert.equal(debug.cells.length, 80);
  assert.equal(debug.frameDataUrl, 'data:image/png;base64,AA==');
  const dmg = debug.cells.find((c) => c.side === 'home' && c.row === 0 && c.field === 'damage');
  assert.deepEqual([dmg.glyphs, dmg.accepted, dmg.rawDataUrl, dmg.processedDataUrl], [3, 215, 'data:raw', 'data:proc']);
  const { renderOverwatchDebugCapture } = await import('../src/overwatch-ocr-panel.js');
  const html = renderOverwatchDebugCapture(debug);
  assert.equal((html.match(/class="ow-dbg-cell /g) || []).length, 80);
  assert.match(html, /2560×1440 → 1920×1080/);
});

// From Derk's 2026-10-05 capture (1440p, scaled to the 1080p grid): Hanzo's ult was READY
// (solid disc + check mark, OCR misread it as 97) and a charging ring on the same board.
// 60x60 patches centred on the ring.
test('Overwatch OCR: READY check-mark disc is recognised, a charging ring is not', () => {
  const at = (file) => { const p = readGrayPng(path.join(__dirname, 'fixtures', file)); return (x, y) => (x < 0 || y < 0 || x >= p.width || y >= p.height ? 0 : p.data[y * p.width + x]); };
  const ready = at('ow-ult-ready.png'); const charging = at('ow-ult-charging.png');
  assert.ok(discFill(ready, 30, 30) > 0.7, `ready disc fill ${discFill(ready, 30, 30).toFixed(2)}`);
  assert.ok(discFill(charging, 30, 30) < 0.35, `charging fill ${discFill(charging, 30, 30).toFixed(2)}`);
  assert.equal(isReadyDisc(ready, 30, 30), true);
  assert.equal(isReadyDisc(charging, 30, 30), false);
  // Every charging ring on the first real board stays "not ready".
  const ring = getProfile().ultimateRing;
  for (const team of getProfile().teams) for (const cy of team.rowCenters) assert.equal(isReadyDisc(sample, ring.cx, cy + ring.dy), false);
});

test('Overwatch OCR service: READY disc wins over a misread number (Hanzo read as 97)', async () => {
  const profile = getProfile(); const ring = profile.ultimateRing;
  const readyPatch = readGrayPng(path.join(__dirname, 'fixtures', 'ow-ult-ready.png'));
  const hanzoCy = profile.teams[1].rowCenters[0] + ring.dy; // bottom team, row 1
  const lum = (x, y) => {
    const dx = x - ring.cx + 30; const dy = y - hanzoCy + 30;
    if (dx >= 0 && dy >= 0 && dx < 60 && dy < 60) return readyPatch.data[dy * 60 + dx];
    return sample(x, y);
  };
  const ocr = { recognize: async (_img, o) => ({ text: o.fieldId.endsWith('-ultimate') ? '97' : '0', confidence: 0.9 }) };
  const service = new OverwatchOcrService({ capture: { capture: async () => ({ width: 1920, height: 1080 }), crop: () => ({ image: Buffer.alloc(0) }), luminance: (_f, x, y) => lum(x, y) }, ocr });
  await service.sweep(); await service.sweep();
  assert.equal(service.board.teams.away.players[0].ultimate, 'READY');
  assert.equal(service.board.teams.home.players[0].ultimate, 97, 'a normal ring keeps its number');
});
