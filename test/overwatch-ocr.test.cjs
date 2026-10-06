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
function cellImage(roi, scale = 4, threshold = 120, pad = 20, shear = 0) { return cellImageFrom(sample, roi, scale, threshold, pad, shear); }
function cellImageFrom(sample, roi, scale = 4, threshold = 120, pad = 20, shear = 0) {
  const w = roi.w * scale + pad * 2; const h = roi.h * scale + pad * 2;
  const px = Buffer.alloc(w * h, 255);
  if (shear) {
    // Same as preprocessNativeImage: binarize at scale, then shift each row to undo the slant.
    const inner = cellImageFrom(sample, roi, scale, threshold, 0).subarray(-(roi.w * scale * roi.h * scale));
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
    crop: (_frame, roi, pre = {}) => ({ image: cellImage(roi, pre.scale || 4, pre.threshold && pre.threshold !== 120 ? 255 - pre.threshold : 120, 20, pre.shear || 0) }),
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

test('Overwatch: NEXT MATCH saves each stationed player\'s OCR stats as "last map" for the player cards', async () => {
  const { saveOverwatchLastMapStats } = await import('../src/companion-actions.js');
  const game = {
    activeMap: 0, mapRows: [{ map: 'Busan' }],
    rosters: { varsity: [{ handle: 'Bengal', stageStation: 3 }, { handle: 'NoStation' }] },
    awayRosters: { varsity: [{ handle: 'BRONCO1', stageStation: 7 }] },
    overwatchOcr: { live: { teams: { home: { players: [{ name: 'BENGAL', hero: 'Hanzo', elims: 21, assists: 6, deaths: 4, damage: 11240, healing: 0, mitigation: 1830 }] }, away: { players: [{ name: 'BRONCO1', elims: 3, assists: 1, deaths: 9, damage: 2100, healing: 0, mitigation: 0 }] } } } }
  };
  assert.equal(saveOverwatchLastMapStats(game), 2);
  assert.deepEqual(game.overwatchLastMapStats[3], { handle: 'Bengal', map: 'Busan', hero: 'Hanzo', stats: { elims: 21, assists: 6, deaths: 4, damage: 11240, healing: 0, mitigation: 1830 }, savedAt: game.overwatchLastMapStats[3].savedAt });
  assert.equal(game.overwatchLastMapStats[7].stats.deaths, 9);
});

// 20 real scoreboard rows (two boards, Derk 2026-10-05): a 70x60 strip per row, columns
// 580-649 of the 1080p grid, row centre at 30. RGB PNG read with the same tiny decoder.
function readRgbPng(file) {
  const buf = fs.readFileSync(file);
  let at = 8; let width = 0; let height = 0; const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at); const type = buf.toString('ascii', at + 4, at + 8); const data = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); assert.equal(data[9], 2, 'RGB png'); }
    if (type === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)); const bpp = 3; const row = width * bpp; const out = Buffer.alloc(row * height);
  for (let y = 0; y < height; y += 1) {
    const f = raw[y * (row + 1)];
    for (let x = 0; x < row; x += 1) {
      const a = x >= bpp ? out[y * row + x - bpp] : 0; const b = y ? out[(y - 1) * row + x] : 0; const c = x >= bpp && y ? out[(y - 1) * row + x - bpp] : 0;
      let v = raw[y * (row + 1) + 1 + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * row + x] = v & 255;
    }
  }
  return { width, height, data: out };
}

test('Overwatch hero recognition: 20/20 real scoreboard portraits match the right hero', () => {
  const { HeroMatcher } = require('../electron/overwatch-hero-match.cjs');
  const strip = readRgbPng(path.join(__dirname, 'fixtures', 'ow-hero-portraits.png'));
  const truth = ['Torbjörn', 'Genji', 'Mercy', 'Baptiste', 'Zarya', 'Tracer', 'Reaper', 'Lúcio', 'Brigitte', 'Roadhog',
    'Reaper', 'Junkrat', 'Sombra', 'Ramattra', 'Tracer', 'Hanzo', 'Mauga', 'Sombra', 'Moira', 'Lúcio'];
  const matcher = new HeroMatcher();
  const wrong = [];
  truth.forEach((hero, i) => {
    // map the 1080p grid (x 580.., row centre) onto strip row i
    const rgbAt = (x, y) => { const sx = x - 580; const sy = y - 500 + i * 60 + 30; const o = (sy * strip.width + sx) * 3; return [strip.data[o], strip.data[o + 1], strip.data[o + 2]]; };
    const r = matcher.match(rgbAt, 500);
    if (r.hero !== hero) wrong.push(`row ${i + 1}: ${r.candidate} ${r.score} (gap ${r.gap}), want ${hero}`);
  });
  assert.deepEqual(wrong, []);
});

test('Overwatch hero recognition: a blank / non-portrait window is "unknown", not a guess', () => {
  const { HeroMatcher } = require('../electron/overwatch-hero-match.cjs');
  const matcher = new HeroMatcher();
  let seed = 7; const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed & 255; };
  assert.equal(matcher.match(() => [20, 30, 45], 500).hero, null);
  assert.equal(matcher.match(() => [noise(), noise(), noise()], 500).hero, null);
});

test('Overwatch OCR service: heroes come through the sweep + consensus, and fill the roster by gamertag', async () => {
  const strip = readRgbPng(path.join(__dirname, 'fixtures', 'ow-hero-portraits.png'));
  const profile = getProfile();
  // Board 1 rows of the strip mapped back onto their real row centres.
  const rows = profile.teams.flatMap((t) => t.rowCenters);
  const rgb = (_f, x, y) => {
    const r = rows.findIndex((cy) => Math.abs(y - cy) <= 30);
    if (r < 0 || x < 580 || x >= 650) return [0, 0, 0];
    const o = ((r * 60 + 30 + y - rows[r]) * strip.width + x - 580) * 3; return [strip.data[o], strip.data[o + 1], strip.data[o + 2]];
  };
  const ocr = { recognize: async () => ({ text: '', confidence: 0 }) };
  let clock = 1000;
  const service = new OverwatchOcrService({ capture: { capture: async () => ({ width: 1920, height: 1080 }), crop: () => ({ image: Buffer.alloc(0) }), rgb }, ocr, now: () => (clock += 1000) });
  await service.sweep();
  assert.equal(service.board.teams.home.players[0].hero, null, 'one read is not enough');
  await service.sweep();
  const heroes = ['home', 'away'].flatMap((s) => service.board.teams[s].players.map((p) => p.hero));
  assert.deepEqual(heroes, ['Torbjörn', 'Genji', 'Mercy', 'Baptiste', 'Zarya', 'Tracer', 'Reaper', 'Lúcio', 'Brigitte', 'Roadhog']);

  const { syncRosterHeroes } = await import('../src/overwatch-ocr-panel.js');
  const game = {
    rosters: { varsity: [{ handle: 'Bengal', character: 'Ana' }, { handle: 'Other', character: 'Mei' }] },
    awayRosters: { varsity: [{ handle: 'bronco1', character: '' }] },
    overwatchOcr: { live: { teams: { home: { players: [{ name: 'BENGAL', hero: 'Torbjörn' }] }, away: { players: [{ name: 'BRONCO1', hero: 'Tracer' }, { name: 'NOBODY', hero: 'Genji' }] } } } }
  };
  const changes = syncRosterHeroes(game);
  assert.deepEqual(changes.map((c) => `${c.handle}:${c.to}`), ['Bengal:Torbjörn', 'bronco1:Tracer']);
  assert.equal(game.rosters.varsity[1].character, 'Mei', 'players the OCR does not see keep their hero');
  assert.deepEqual(syncRosterHeroes(game), [], 'no changes the second time');
});

test('Roster sync: gamertags match at >= 90% similarity (OCR slips), not below', async () => {
  const { tagSimilarity, foldTag, NAME_MATCH } = await import('../src/overwatch-ocr-panel.js');
  assert.equal(NAME_MATCH, 0.9);
  assert.equal(foldTag('Bengal_One'), foldTag('BENGAL ONE'));
  assert.equal(tagSimilarity('ROARANGE', 'R0ARANGE'), 1, 'O/0 is the same to the matcher');
  assert.equal(tagSimilarity('Lucky7', 'LUCKY7'), 1, 'case does not matter');
  assert.ok(tagSimilarity('BENGALWARRIOR', 'BENGALWARRI0R') >= 0.9);
  assert.ok(tagSimilarity('THUNDERSTRIKE', 'THUNDERSTRIKF') >= 0.9, 'one wrong letter in 13');
  assert.ok(tagSimilarity('ACE', 'ICE') < 0.9, 'short tags need to be exact-ish');
  assert.ok(tagSimilarity('BRONCO1', 'BRONCO2') < 0.9, 'teammates with numbered tags stay apart');
});

test('Roster sync: matched players follow hero + role, unmatched board players fill empty slots, others untouched', async () => {
  const { syncRosterFromOcr } = await import('../src/overwatch-ocr-panel.js');
  const empty = () => ({ handle: '', name: '', role: 'Tank', character: '' });
  const game = {
    rosters: { varsity: [
      { handle: 'ThunderStrike', name: 'Sam', role: 'Tank', character: 'Reinhardt' },
      { handle: 'Benchwarmer', name: 'Pat', role: 'Support', character: 'Ana' },
      empty(), empty(), empty()
    ] },
    awayRosters: { varsity: [empty(), empty(), empty(), empty(), empty()] },
    overwatchOcr: { live: { teams: {
      home: { players: [{ name: 'THUNDERSTRIKF', hero: 'Tracer' }, { name: 'NEWGUY', hero: 'Mercy' }, { name: 'ROOKIE', hero: 'Zarya' }, { name: '', hero: 'Genji' }] },
      away: { players: [{ name: 'BRONCO1', hero: 'Reaper' }, { name: 'BRONCO2', hero: 'Lúcio' }] }
    } } }
  };
  const changes = syncRosterFromOcr(game);
  const home = game.rosters.varsity; const away = game.awayRosters.varsity;
  assert.deepEqual([home[0].handle, home[0].character, home[0].role], ['ThunderStrike', 'Tracer', 'Damage'], 'fuzzy match keeps the preset tag, takes hero + role');
  assert.deepEqual([home[1].handle, home[1].character], ['Benchwarmer', 'Ana'], 'a roster player the board does not show is untouched');
  assert.deepEqual(home.slice(2).map((p) => [p.handle, p.character, p.role]), [['NEWGUY', 'Mercy', 'Support'], ['ROOKIE', 'Zarya', 'Tank'], ['', '', 'Tank']]);
  assert.deepEqual(away.slice(0, 2).map((p) => [p.handle, p.character, p.role, p.autoAdded]), [['BRONCO1', 'Reaper', 'Damage', true], ['BRONCO2', 'Lúcio', 'Support', true]]);
  assert.ok(changes.length > 0);
  // Second pass: everything already matches -> nothing to change, no duplicate rows.
  assert.deepEqual(syncRosterFromOcr(game), []);
  // A hero swap mid-map: only that player's hero + role change.
  game.overwatchOcr.live.teams.home.players[0].hero = 'Ana';
  assert.deepEqual(syncRosterFromOcr(game).map((c) => `${c.handle}:${c.field}:${c.to}`), ['ThunderStrike:character:Ana', 'ThunderStrike:role:Support']);
});

test('Overwatch hero roles cover every hero in the controller list', async () => {
  const { OVERWATCH_HERO_ROLES } = await import('../src/overwatch-hero-roles.js');
  const { GAME_CONFIGS } = await import('../src/game-config.js');
  for (const hero of GAME_CONFIGS.overwatch.characters) assert.ok(['Tank', 'Damage', 'Support'].includes(OVERWATCH_HERO_ROLES[hero]), hero);
  for (const role of ['Tank', 'Damage', 'Support']) assert.ok(GAME_CONFIGS.overwatch.roles.includes(role));
});

test('Overwatch OCR: a hand-set player name sticks over OCR until cleared', async () => {
  // OCR keeps "reading" a wrong name for row 1; numbers still flow normally.
  const ocr = { recognize: async (_img, o) => o.fieldId.endsWith('-name') ? { text: 'HANZ0X', confidence: 0.9 } : { text: '0', confidence: 0.9 } };
  const capture = { capture: async () => ({ width: 1920, height: 1080 }), crop: () => ({ image: Buffer.alloc(0) }) };
  const states = [];
  const service = new OverwatchOcrService({ capture, ocr, onState: (s) => states.push(s) });
  service.setPlayerName({ side: 'away', row: 0, name: '  Hanzo ' });
  assert.equal(service.board.teams.away.players[0].name, 'Hanzo');
  assert.equal(service.board.teams.away.players[0].nameManual, true);
  for (let i = 0; i < 4; i += 1) await service.sweep();
  assert.equal(service.board.teams.away.players[0].name, 'Hanzo', 'OCR never overwrites a hand-set name');
  assert.equal(service.board.teams.home.players[0].name, 'HANZ0X', 'other rows still read');
  assert.equal(service.board.teams.away.players[0].elims, 0, 'stats on the hand-named row still read');
  service.setPlayerName({ side: 'away', row: 0, name: '' });
  assert.equal(service.board.teams.away.players[0].nameManual, false);
  for (let i = 0; i < 3; i += 1) await service.sweep();
  assert.equal(service.board.teams.away.players[0].name, 'HANZ0X', 'cleared -> OCR takes over again');
  assert.throws(() => service.setPlayerName({ side: 'middle', row: 0, name: 'x' }), /home or away/);
  assert.ok(states.length >= 2);
});


// Live boards move: a competitive Drive puts a small line under the name and pushes the name up,
// and icons (perks) can nudge the stat columns. Build that from the real board: names of some
// rows moved up 9 px with a fake drive line under them, and the whole stat block shifted 10 px
// right. With auto-align the reads still match; the fixed boxes would miss.
// A Drive line is bright but coloured (gold/purple), never white like the name.
const DRIVE_LUM = 209;
const shiftedRgb = (lumAt) => (x, y) => { const v = lumAt(x, y); return v === DRIVE_LUM ? [250, 190, 40] : [v, v, v]; };
function shiftedBoardSampler({ nameUp = { 'home:1': 9, 'away:3': 9 }, statDx = 10, boardDy = 0 } = {}) {
  const profile = getProfile();
  if (boardDy) { const inner = shiftedBoardSampler({ nameUp, statDx, boardDy: 0 }); return (x, y) => inner(x, y - boardDy); }
  const name = profile.columns.name; const nh = profile.nameCellHeight;
  const statX0 = Math.min(...['elims', 'assists', 'deaths', 'damage', 'healing', 'mitigation'].map((f) => profile.columns[f].x)) - 4;
  const rowAt = new Map();
  for (const team of profile.teams) team.rowCenters.forEach((cy, row) => rowAt.set(`${team.id}:${row}`, cy));
  return (x, y) => {
    // stat block shifted right: read from the left
    if (x >= statX0 + statDx) return sample(x - statDx, y);
    if (x >= statX0) return 20;
    if (x >= name.x - 8 && x < name.x + name.w) {
      for (const [key, up] of Object.entries(nameUp)) {
        const cy = rowAt.get(key); if (!cy) continue;
        if (y >= cy - nh / 2 - up - 2 && y < cy - nh / 2 + nh - up + 2) return sample(x, y + up); // name moved up
        if (y >= cy + nh / 2 - up + 2 && y < cy + nh / 2 - up + 9) return x < name.x + 60 ? DRIVE_LUM : 20; // drive line (coloured, see shiftedRgb)
        if (y >= cy - nh / 2 && y < cy + nh / 2 + 4) return 20; // where the name was
      }
    }
    return sample(x, y);
  };
}

test('Overwatch OCR: auto-align finds names pushed up by Drives and a shifted stat block', () => {
  const { alignBoard } = require('../electron/overwatch-ocr-parse.cjs');
  const clean = alignBoard(sample, getProfile());
  assert.equal(clean.dx, 0, 'clean board: no column shift');
  for (const r of Object.values(clean.rows)) { assert.ok(Math.abs(r.statDy) <= 1); assert.ok(Math.abs(r.nameDy) <= 1); }
  const movedLum = shiftedBoardSampler();
  const moved = alignBoard(movedLum, getProfile(), shiftedRgb(movedLum));
  assert.ok(Math.abs(moved.dx - 10) <= 1, `stat block found ~10 px to the right (got ${moved.dx})`);
  assert.ok(Math.abs(alignBoard(shiftedBoardSampler({ nameUp: {}, statDx: -18 }), getProfile()).dx + 18) <= 1, 'and 18 px to the left');
  assert.ok(Math.abs(moved.rows['home:1'].nameDy + 9) <= 1, `home2 name found ~9 px up (got ${moved.rows['home:1'].nameDy})`);
  assert.ok(Math.abs(moved.rows['away:3'].nameDy + 9) <= 1, `away4 name found ~9 px up (got ${moved.rows['away:3'].nameDy})`);
  assert.ok(Math.abs(moved.rows['home:0'].nameDy) <= 1, 'untouched rows stay put');
  const low = alignBoard(shiftedBoardSampler({ nameUp: {}, statDx: 0, boardDy: 9 }), getProfile());
  for (const [k, r] of Object.entries(low.rows)) { assert.ok(Math.abs(r.statDy - 9) <= 1, `${k} stats found 9 px lower (got ${r.statDy})`); assert.ok(Math.abs(r.nameDy - 9) <= 1, `${k} name found 9 px lower (got ${r.nameDy})`); }
});

test('Overwatch OCR service: reads the moved board correctly with auto-align (and not without)', { timeout: 240000 }, async () => {
  // Whole board 9 px lower (like the live match), two names pushed up by drives, stats 12 px right.
  const shifted = shiftedBoardSampler({ nameUp: { 'home:1': 9, 'away:3': 9 }, statDx: 12, boardDy: 9 });
  const run = async (autoAlign) => {
    const capture = {
      capture: async () => ({ fixture: true, width: 1920, height: 1080 }),
      crop: (_f, roi, pre = {}) => ({ image: cellImageFrom(shifted, roi, pre.scale || 4, pre.threshold && pre.threshold !== 120 ? 255 - pre.threshold : 120, 20, pre.shear || 0) }),
      luminance: (_f, x, y) => shifted(x, y),
      rgb: (_f, x, y) => shiftedRgb(shifted)(x, y)
    };
    const ocr = new TesseractOcrEngine();
    const service = new OverwatchOcrService({ capture, ocr });
    service.settings.autoAlign = autoAlign;
    try { for (let i = 0; i < 3; i += 1) await service.sweep(); } finally { await ocr.close(); }
    return service.board;
  };
  const board = await run(true);
  const got = (side, row) => { const p = board.teams[side].players[row]; return [p.ultimate, p.damage, p.healing, p.mitigation]; };
  for (const side of ['home', 'away']) EXPECTED[side].forEach((row, i) => assert.deepEqual(got(side, i), row, `${side}${i + 1} with auto-align`));
  assert.equal(board.teams.home.players[1].name, 'DAMAGE 2');
  assert.equal(board.teams.away.players[3].name, 'SUPPORT 4');
  const fixed = await run(false);
  const misses = ['home', 'away'].flatMap((side) => EXPECTED[side].map((row, i) => JSON.stringify([fixed.teams[side].players[i].ultimate, fixed.teams[side].players[i].damage, fixed.teams[side].players[i].healing, fixed.teams[side].players[i].mitigation]) !== JSON.stringify(row))).filter(Boolean).length;
  assert.ok(misses >= 5, `fixed boxes should miss on the moved board (missed ${misses}/10 rows)`);
});

// Real live-match board WITH perks (Derk 2026-10-06, Neon Junction): the perk column pushes the
// stat columns 50 px right and the left block (portrait, ult, name) 50 px left. Fixture is the
// board area (x 480-1439, y 140-939) of the 1920x1080 screenshot.
const PERKS = { file: path.join(__dirname, 'fixtures', 'ow-board-perks.png'), x: 480, y: 140 };
const perksImg = readGrayPng(PERKS.file);
const perksAt = (x, y) => { const lx = x - PERKS.x; const ly = y - PERKS.y; return lx < 0 || ly < 0 || lx >= perksImg.width || ly >= perksImg.height ? 0 : perksImg.data[ly * perksImg.width + lx]; };
// What the board shows: [elims, assists, deaths, damage, healing, mitigation]
const PERKS_EXPECTED = {
  home: [[5, 2, 0, 6004, 981, 2990], [4, 0, 4, 2469, 0, 0], [3, 0, 6, 4126, 167, 0], [0, 0, 0, 0, 0, 0], [3, 6, 4, 2153, 6305, 154]],
  away: [[6, 2, 2, 5496, 1285, 2538], [10, 0, 0, 3646, 118, 0], [5, 0, 4, 4420, 50, 484], [3, 7, 1, 2652, 6371, 712], [8, 7, 1, 5067, 4112, 307]]
};

test('Overwatch OCR: perk layout found from the header bar (stats +50 px, left block -50 px)', () => {
  const { alignBoard, headerColumns } = require('../electron/overwatch-ocr-parse.cjs');
  const cols = headerColumns(perksAt, getProfile());
  assert.deepEqual([cols.elims, cols.assists, cols.deaths, cols.damage, cols.healing, cols.mitigation], [971, 1021, 1071, 1152, 1243, 1335]);
  assert.equal(cols.leftDx, -50);
  assert.equal(alignBoard(perksAt, getProfile()).perks, true);
});

test('Overwatch OCR service: real perks board - stats read right, never a wrong number', { timeout: 240000 }, async () => {
  const capture = {
    capture: async () => ({ width: 1920, height: 1080 }),
    crop: (_f, roi, pre = {}) => ({ image: cellImageFrom(perksAt, roi, pre.scale || 4, pre.threshold && pre.threshold !== 120 ? 255 - pre.threshold : 120, 20, pre.shear || 0) }),
    luminance: (_f, x, y) => perksAt(x, y)
  };
  const ocr = new TesseractOcrEngine();
  const service = new OverwatchOcrService({ capture, ocr });
  try { for (let i = 0; i < 3; i += 1) await service.sweep(); } finally { await ocr.close(); }
  const fields = ['elims', 'assists', 'deaths', 'damage', 'healing', 'mitigation'];
  let right = 0; const wrong = [];
  for (const side of ['home', 'away']) PERKS_EXPECTED[side].forEach((row, i) => fields.forEach((f, k) => {
    const got = service.board.teams[side].players[i][f];
    if (got === row[k]) right += 1; else if (got !== null) wrong.push(`${side}${i + 1} ${f}: ${got} (board ${row[k]})`);
  }));
  assert.deepEqual(wrong, [], 'a missed cell is ok (stays empty), a wrong number is not');
  console.log(`perks board: ${right}/60 stat cells read`);
  assert.ok(right >= 55, `at least 55/60 stat cells read (got ${right})`);
  // Ult READY discs for the three home players that have it.
  assert.deepEqual([0, 2, 4].map((r) => service.board.teams.home.players[r].ultimate), ['READY', 'READY', 'READY']);
});
