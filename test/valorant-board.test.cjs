const test = require('node:test');
const assert = require('node:assert/strict');
const { PROFILE, alignBoard, cellRois, AgentMatcher, parseCell, readCell, BoardConsensus, emptyBoard, applySweep } = require('../electron/valorant-board-parse.cjs');
const { TesseractOcrEngine } = require('../electron/valorant-ocr-engine.cjs');
const { board, cellImage, AGENTS, B1, B2, FIELDS } = require('./valorant-board-fixtures.cjs');

test('VALORANT board: auto-align finds the board on both screenshots (one shifted 14 px left)', () => {
  const a1 = alignBoard(board('val-board-1.png').lum); const a2 = alignBoard(board('val-board-2.png').lum);
  assert.equal(a1.found, true); assert.equal(a2.found, true);
  assert.ok(Math.abs(a1.dx) <= 2 && Math.abs(a1.dy) <= 2, `board 1 on the grid (dx ${a1.dx} dy ${a1.dy})`);
  assert.ok(Math.abs(a2.dx + 14) <= 2, `board 2 found ~14 px left (dx ${a2.dx})`);
});

test('VALORANT board: all 10 agents recognised on both screenshots', () => {
  const m = new AgentMatcher();
  for (const f of ['val-board-1.png', 'val-board-2.png']) {
    const b = board(f); const a = alignBoard(b.lum);
    const got = Object.values(a.rows).map((r) => m.match(b.rgb, PROFILE.columns.agent.x + 16 + a.dx, r.cy).agent);
    assert.deepEqual(got, AGENTS, f);
  }
});

test('VALORANT board: parsing rules', () => {
  assert.equal(parseCell('ultimate', '3 / 9'), '3/9'); assert.equal(parseCell('ultimate', '8 / 8'), 'READY'); assert.equal(parseCell('ultimate', '9 / 3'), null);
  assert.equal(parseCell('credits', '2,600'), 2600); assert.equal(parseCell('credits', '2,610'), null);
  assert.equal(parseCell('kills', 'O'), 0); assert.equal(parseCell('ping', '44'), 44);
  const board = emptyBoard(); const c = new BoardConsensus();
  applySweep(board, c, [{ side: 'home', row: 0, field: 'kills', value: 3 }]); assert.equal(board.teams.home.players[0].kills, null, 'one read is not enough');
  applySweep(board, c, [{ side: 'home', row: 0, field: 'kills', value: 3 }]); assert.equal(board.teams.home.players[0].kills, 3);
});

for (const f of ['val-board-1.png', 'val-board-2.png']) {
  test(`VALORANT board: real OCR of every cell on ${f} - numbers right or blank, never wrong`, { timeout: 240000 }, async () => {
    const b = board(f); const a = alignBoard(b.lum); const ocr = new TesseractOcrEngine();
    const key = f === 'val-board-1.png' ? B1 : B2;
    const wrong = []; let right = 0; let checked = 0;
    try {
      for (const cell of cellRois(PROFILE, a)) {
        const want = key[cell.side][cell.row][FIELDS.indexOf(cell.field)];
        if (want === undefined) continue;
        checked += 1;
        const value = await readCell(ocr, b.lum, cell, (roi, scale, thr) => cellImage(b.lum, roi, scale, thr));
        const norm = (v) => String(v).replace(/[^A-Za-z0-9/]/g, '').toUpperCase();
        if (value === null) continue;
        if (norm(value) === norm(want)) right += 1; else wrong.push(`${cell.side}${cell.row + 1} ${cell.field}: ${value} (board ${want})`);
      }
    } finally { await ocr.close(); }
    console.log(`${f}: ${right}/${checked} cells read right; wrong: ${wrong.join(', ') || 'none'}`);
    assert.ok(right >= checked * 0.85, `most cells read (${right}/${checked})`);
    assert.deepEqual(wrong.filter((w) => !w.includes(' name:')), [], 'a number may stay blank, never be wrong');
  });
}

// Loadout read by eye from the screenshots (Derk 2026-09-18). null = something covers it
// (a "+credits" popup over the row), where "not sure" is the right answer.
const WEAPONS = {
  'val-board-1.png': ['classic', 'classic', 'ghost', 'classic', 'classic', null, 'classic', 'classic', 'classic', 'classic'],
  'val-board-2.png': ['classic', 'classic', 'ghost', 'bucky', 'classic', 'classic', 'guardian', 'outlaw', 'guardian', 'guardian']
};
const SHIELDS = {
  'val-board-1.png': ['none', 'none', 'none', 'none', 'none', 'none', 'none', 'none', 'none', 'none'],
  'val-board-2.png': [null, 'none', 'light', null, 'light', 'none', 'regen', 'light', 'light', 'regen']
};
test('VALORANT board: weapons (incl. Operator class guns) and shields (light / heavy / regen)', () => {
  const { GearMatcher } = require('../electron/valorant-board-parse.cjs');
  const g = new GearMatcher();
  for (const f of Object.keys(WEAPONS)) {
    const b = board(f); const a = alignBoard(b.lum); const L = PROFILE.columns.loadout; const S = PROFILE.columns.shield;
    const rows = Object.values(a.rows);
    const weapons = rows.map((r) => g.weapon(b.lum, { x: L.x + a.dx, y: r.cy - 11, w: L.w, h: 22 }).weapon);
    const shields = rows.map((r) => g.shield(b.lum, S.x + a.dx, S.x + S.w + a.dx, r.cy).shield);
    const right = WEAPONS[f].filter((w, i) => w && weapons[i] === w).length;
    WEAPONS[f].forEach((w, i) => { if (weapons[i] !== null) assert.equal(weapons[i], w || weapons[i], `${f} row ${i + 1}: a gun may stay blank, never be wrong`); });
    assert.ok(right >= 8, `${f}: ${right}/10 guns recognised (${weapons.join(', ')})`);
    SHIELDS[f].forEach((s, i) => { if (s) assert.equal(shields[i], s, `${f} row ${i + 1} shield`); else assert.ok(shields[i] === null || shields[i] === 'heavy' || shields[i] === 'light', `${f} row ${i + 1}`); });
  }
});

test('VALORANT board: the Operator icon is recognised as an Operator, not a Marshal / Outlaw', () => {
  const { GearMatcher } = require('../electron/valorant-board-parse.cjs');
  const fs = require('node:fs'); const path = require('node:path'); const zlib = require('node:zlib');
  const g = new GearMatcher();
  // Draw the official Operator silhouette onto a blank board row (as white ink) and read it back.
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'electron', 'valorant-gear-templates.json'), 'utf8'));
  const idx = meta.weapons.indexOf('operator'); const n = meta.w * meta.h;
  const bin = fs.readFileSync(path.join(__dirname, '..', 'electron', 'valorant-weapon-templates.bin')).subarray(idx * n, (idx + 1) * n);
  const W = 100; const H = 20; const roi = { x: 1035, y: 400, w: 122, h: 24 };
  const lum = (x, y) => { const i = x - 1052; const j = y - 402; if (i < 0 || j < 0 || i >= W || j >= H) return 60; return bin[Math.floor(j * meta.h / H) * meta.w + Math.floor(i * meta.w / W)] ? 230 : 60; };
  assert.equal(g.weapon(lum, roi).weapon, 'operator'); void zlib;
});

test('VALORANT board service: real board through full sweeps (consensus) -> agents, guns, shields, K/D/A', { timeout: 240000 }, async () => {
  const { ValorantBoardService } = require('../electron/valorant-board-service.cjs');
  const b = board('val-board-2.png');
  const capture = {
    capture: async () => ({ width: 1920, height: 1080 }),
    crop: (_f, roi, pre = {}) => ({ image: cellImage(b.lum, roi, pre.scale || 4, pre.threshold || 150) }),
    luminance: (_f, x, y) => b.lum(x, y), rgb: (_f, x, y) => b.rgb(x, y)
  };
  const ocr = new TesseractOcrEngine(); const states = [];
  const svc = new ValorantBoardService({ capture, ocr, onState: (s) => states.push(s) });
  try {
    await svc.sweep();
    assert.equal(svc.board.teams.home.players[0].kills, null, 'one sweep is not enough to show a value');
    await svc.sweep(); await svc.sweep();
  } finally { await ocr.close(); }
  const p = (side, i) => svc.board.teams[side].players[i];
  assert.deepEqual(['home', 'away'].flatMap((s) => [0, 1, 2, 3, 4].map((i) => p(s, i).agent)), AGENTS);
  assert.deepEqual([p('home', 0).kills, p('home', 0).deaths, p('home', 0).assists], [3, 0, 0]);
  assert.equal(p('away', 1).weapon, 'guardian'); assert.equal(p('away', 1).shield, 'regen');
  assert.equal(p('home', 2).shield, 'light'); assert.equal(p('home', 3).weapon, 'bucky');
  assert.equal(svc.status.state, 'reading'); assert.ok(svc.lastAlign.dx <= -12, 'found the shifted board');
  assert.ok(states.length >= 1);
});

test('VALORANT guns: trained set alone recognises every real board crop (no crop of its own in the set)', () => {
  // tools/valorant-gun-training/make_templates.py --renders-only would drop the crops entirely;
  // here we keep the trained renders and remove any template identical to the crop being read.
  const fs = require('node:fs'); const path = require('node:path'); const zlib = require('node:zlib');
  const { GearMatcher } = require('../electron/valorant-board-parse.cjs');
  const g = new GearMatcher(); const trained = g.weapons.filter((t) => t.trained);
  const root = path.join(__dirname, '..', 'public', 'assets', 'valorant', 'weapons', 'trained');
  const readGray = (file) => {
    const buf = fs.readFileSync(file); let at = 8; let w = 0; let h = 0; let ct = 0; const idat = [];
    while (at < buf.length) { const len = buf.readUInt32BE(at); const type = buf.toString('ascii', at + 4, at + 8); const d = buf.subarray(at + 8, at + 8 + len); if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; } if (type === 'IDAT') idat.push(d); at += 12 + len; }
    const ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 4 ? 2 : 1; const stride = w * ch; const raw = zlib.inflateSync(Buffer.concat(idat)); const out = Buffer.alloc(w * h); let prev = Buffer.alloc(stride);
    for (let y = 0; y < h; y += 1) { const f = raw[y * (stride + 1)]; const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)); const cur = Buffer.alloc(stride);
      for (let i = 0; i < stride; i += 1) { const a = i >= ch ? cur[i - ch] : 0; const b = prev[i]; const c = i >= ch ? prev[i - ch] : 0; let v = row[i]; if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; } cur[i] = v & 255; }
      for (let x = 0; x < w; x += 1) out[y * w + x] = ch >= 3 ? Math.round(cur[x * ch] * 0.299 + cur[x * ch + 1] * 0.587 + cur[x * ch + 2] * 0.114) : cur[x * ch];
      prev = cur; }
    return { w, h, lum: (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : out[y * w + x]) };
  };
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  let right = 0; let total = 0; const wrong = [];
  for (const gun of fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory())) for (const f of fs.readdirSync(path.join(root, gun)).filter((n) => n.endsWith('.png'))) {
    const c = readGray(path.join(root, gun, f)); const own = [150, 175].map((t) => g.silhouette(c.lum, { x: 0, y: 0, w: c.w, h: c.h }, t)).filter(Boolean);
    g.weapons = trained.filter((t) => !own.some((o) => same(Array.from(o), Array.from(t.m))));
    const r = g.weapon(c.lum, { x: 0, y: 0, w: c.w, h: c.h }); total += 1;
    if (r.weapon === gun) right += 1; else if (r.weapon) wrong.push(`${gun}/${f} -> ${r.weapon}`);
  }
  console.log(`real gun crops: ${right}/${total} right, wrong: ${wrong.join(', ') || 'none'}`);
  assert.ok(right >= total * 0.75, `${right}/${total}`);
});

test('VALORANT names: trained model (electron/ocr-models/val.traineddata) reads the real names', { timeout: 240000 }, async () => {
  const ocr = new TesseractOcrEngine(); let right = 0; let total = 0; const got = [];
  try {
    for (const f of ['val-board-1.png', 'val-board-2.png']) {
      const b = board(f); const a = alignBoard(b.lum);
      for (const cell of cellRois(PROFILE, a).filter((c) => c.field === 'name')) {
        const v = await readCell(ocr, b.lum, cell, (roi, scale, thr) => cellImage(b.lum, roi, scale, thr));
        const want = B1[cell.side][cell.row][0]; total += 1;
        // Roster matching ignores case, so does this score.
        if (v && v.toLowerCase() === want.toLowerCase()) right += 1;
        got.push(v);
      }
    }
  } finally { await ocr.close(); }
  console.log(`VALORANT names: ${right}/${total} (case-insensitive): ${got.join(' | ')}`);
  assert.ok(right >= 14, `${right}/${total}`);
});
