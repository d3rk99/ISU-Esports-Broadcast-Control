'use strict';
// Overwatch 2 spectator scoreboard (Tab) -> structured player stats.
// Pure functions + a consensus gate, no Electron, so they are unit-testable with real
// screenshots. The capture/OCR loop (overwatch-ocr-service.cjs) feeds cell reads in here.
//
// Fields per player: name, ultimate (0-100 %, or 'READY'), elims, assists, deaths,
// damage, healing, mitigation. The board shows E / A / D (eliminations, assists, deaths).

const PROFILES = require('./overwatch-ocr-profiles.json');
const STAT_FIELDS = ['elims', 'assists', 'deaths', 'damage', 'healing', 'mitigation'];
const ALL_FIELDS = ['name', 'hero', 'ultimate', ...STAT_FIELDS];

function getProfile(id = 'default-1080p') {
  return PROFILES[id] || PROFILES['default-1080p'];
}

// Every cell to read: { side, row, field, roi:{x,y,w,h}, column }.
// ---- auto-align ------------------------------------------------------------------------
// The board doesn't always sit on the profile grid: a player's competitive Drive adds a small
// line under the name and pushes the name up, and other icons (perks) can nudge things. Before
// each read we find where the text really is (lum = luminance on the 1080p grid) and move the
// boxes to it. Nothing found = the profile positions, so a clean board reads exactly as before.

// Runs of rows in [y0, y1) that contain bright (text) pixels between x0 and x1.
function inkBands(lum, x0, x1, y0, y1, thr = 165, minPx = 2, isInk = null) {
  const bands = []; let start = -1;
  for (let y = y0; y <= y1; y += 1) {
    let on = false;
    if (y < y1) { let n = 0; for (let x = x0; x < x1; x += 1) if ((isInk ? isInk(x, y) : lum(x, y) >= thr) && ++n >= minPx) { on = true; break; } }
    if (on && start < 0) start = y;
    if (!on && start >= 0) { bands.push({ y0: start, y1: y, h: y - start, c: (start + y - 1) / 2 }); start = -1; }
  }
  return bands;
}

// Horizontal shift of the stat block: slide the expected column boxes over the ink profile of
// the stat rows and keep the shift that puts the most ink inside boxes and the least in the gaps.
function statOffset(lum, profile, statDy = {}) {
  const cols = STAT_FIELDS.map((f) => profile.columns[f]).filter(Boolean).sort((a, b) => a.x - b.x);
  if (cols.length < 2) return 0;
  const range = profile.align?.dx ?? 24;
  const x0 = cols[0].x - range - 2; const x1 = cols.at(-1).x + cols.at(-1).w + range + 2;
  const ink = new Float64Array(x1 - x0);
  for (const team of profile.teams) team.rowCenters.forEach((cy, row) => {
    const c = cy + (statDy[`${team.id}:${row}`] || 0);
    for (let y = c - 7; y <= c + 7; y += 1) for (let x = x0; x < x1; x += 1) if (lum(x, y) >= 165) ink[x - x0] += 1;
  });
  let total = 0; for (const v of ink) total += v;
  if (total < 40) return 0; // empty / no board: don't guess
  // Numbers are centred in their columns (and the boxes are much wider than the digits), so
  // match the centre of each column's ink to the centre of its box. Ink is gathered from a
  // window around each box that is wider than the search range.
  const shifts = [];
  for (const col of cols) {
    const mid = col.x + col.w / 2; let sum = 0; let n = 0;
    for (let x = Math.round(mid - col.w / 2 - range); x <= Math.round(mid + col.w / 2 + range); x += 1) {
      const v = ink[x - x0] || 0; sum += v * x; n += v;
    }
    if (n >= 8) shifts.push(sum / n - mid);
  }
  if (shifts.length < 3) return 0;
  shifts.sort((a, b) => a - b);
  const median = shifts[Math.floor(shifts.length / 2)];
  // Only move when the columns agree (a real shift moves them all together).
  const agree = shifts.filter((d) => Math.abs(d - median) <= 4).length;
  const best = agree >= Math.ceil(shifts.length * 0.6) && Math.abs(median) >= 3 ? Math.round(median) : 0;
  return best;
}

// Stat columns from the header bar. Above each team the board has a light bar with dark
// labels E A D DMG H MIT, centred over their columns. Perks add a column between the name and
// E, which pushes every stat column ~50 px right; the labels move with them, so the labels are
// the most reliable anchor. Returns { elims: centreX, ... } or null if the bar isn't readable.
function headerColumns(lum, profile = getProfile()) {
  const cols = STAT_FIELDS.filter((f) => profile.columns[f]);
  const firstRow = Math.min(...profile.teams.flatMap((t) => t.rowCenters));
  const x0 = Math.min(...cols.map((f) => profile.columns[f].x)) - 90; const x1 = Math.max(...cols.map((f) => profile.columns[f].x + profile.columns[f].w)) + 110;
  // The bar: rows above the first player row whose middle is light.
  const barRows = [];
  for (let y = firstRow - 75; y < firstRow - 25; y += 1) {
    let light = 0; let n = 0;
    for (let x = x0; x < x1; x += 4) { n += 1; if (lum(x, y) >= 180) light += 1; }
    if (light / n >= 0.7) barRows.push(y);
  }
  if (barRows.length < 8) return null;
  // Left end of the bar (the board's left edge moves with the layout too: with perks the
  // whole left block - portrait, ult ring, name - sits ~50 px further left).
  const midY = barRows[Math.floor(barRows.length / 2)];
  let barLeft = null;
  for (let x = Math.max(0, x0 - 520); x < x0; x += 1) {
    let light = 0; for (let k = 0; k < 120; k += 4) if (lum(x + k, midY) >= 180) light += 1;
    if (light >= 28) { barLeft = x; break; }
  }
  const dark = new Int32Array(x1 - x0);
  for (const y of barRows) for (let x = x0; x < x1; x += 1) if (lum(x, y) < 110) dark[x - x0] += 1;
  const blobs = []; let start = -1;
  for (let i = 0; i <= dark.length; i += 1) {
    const on = i < dark.length && dark[i] > 1;
    if (on && start < 0) start = i;
    if (!on && start >= 0) { blobs.push([start + x0, i + x0]); start = -1; }
  }
  const merged = [];
  for (const b of blobs) { const last = merged.at(-1); if (last && b[0] - last[1] <= 6) last[1] = b[1]; else merged.push([...b]); }
  // Letters (3-40 px wide); the bar's end / other panels show up as wide dark blocks.
  const labels = merged.filter(([a, b]) => b - a >= 3 && b - a <= 40).map(([a, b]) => (a + b) / 2);
  if (labels.length < cols.length) return null;
  // Pick the run of labels whose spacing best matches the profile's column spacing
  // (each gap within 35%); the profile only needs to be right about spacing, not position.
  const expected = cols.map((f) => profile.columns[f].x + profile.columns[f].w / 2);
  let best = null;
  for (let start = 0; start + cols.length <= labels.length; start += 1) {
    const run = labels.slice(start, start + cols.length); let err = 0; let ok = true;
    for (let i = 1; i < cols.length; i += 1) {
      const want = expected[i] - expected[i - 1]; const got = run[i] - run[i - 1];
      if (Math.abs(got - want) > want * 0.35) { ok = false; break; }
      err += Math.abs(got - want);
    }
    if (ok && (!best || err < best.err)) best = { run, err };
  }
  if (!best) return null;
  const out = Object.fromEntries(cols.map((f, i) => [f, Math.round(best.run[i])]));
  // leftDx: how far the left block moved vs the profile (profile.barLeft = bar's left end there).
  out.leftDx = barLeft != null && profile.barLeft ? barLeft - profile.barLeft : 0;
  if (Math.abs(out.leftDx) > 120) out.leftDx = 0;
  return out;
}

// Per row: statDy (digits line), nameDy (the name's own text line, ignoring the small drive line
// under it), and nameX (where the name text starts). Plus dx for the whole stat block.
function alignBoard(lum, profile = getProfile(), rgb = null) {
  const { columns } = profile; const search = profile.align?.dy ?? 14;
  // Layout first: the header bar tells where the stat columns are and how far the left block
  // (portrait, ult ring, name) moved. Perks: stats +50 px, left block -50 px.
  const header = headerColumns(lum, profile);
  const leftDx = header?.leftDx || 0;
  const statX = (f) => (header?.[f] != null ? header[f] - columns[f].w / 2 : columns[f].x);
  const statCols = STAT_FIELDS.filter((f) => columns[f]);
  const sx0 = Math.min(...statCols.map(statX)); const sx1 = Math.max(...statCols.map((f) => statX(f) + columns[f].w));
  const rows = {};
  for (const team of profile.teams) team.rowCenters.forEach((cy, row) => {
    const key = `${team.id}:${row}`;
    // Digits are ~11 px tall: the band nearest the expected centre.
    const sb = inkBands(lum, sx0, sx1, cy - search, cy + search + 1).filter((b) => b.h >= 6 && b.h <= 20);
    const statBand = sb.sort((a, b) => Math.abs(a.c - cy) - Math.abs(b.c - cy))[0];
    rows[key] = { statDy: statBand ? Math.round(statBand.c - cy) : 0, nameDy: 0, nameX: null };
  });
  const dx = header ? 0 : statOffset(lum, profile, Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.statDy])));
  // Perks add a column of white icons between the name and E: then the name must stop well
  // before E or the icons get read as letters. Perks are on when E moved right of the profile.
  const elimsMid = header?.elims ?? (columns.elims ? columns.elims.x + columns.elims.w / 2 + dx : null);
  const perks = header && columns.elims ? header.elims - (columns.elims.x + columns.elims.w / 2) >= 30 : false;
  const nameRight = elimsMid != null ? elimsMid - (perks ? (profile.align?.perkGap ?? 140) : (profile.align?.nameGap ?? 23)) : null;
  // White text = bright and not coloured (rank emblems / Drives in front of the name are coloured).
  const isText = (x, y) => { if (lum(x, y) < 165) return false; if (!rgb) return true; const [r, g, b] = rgb(x, y); return Math.max(r, g, b) - Math.min(r, g, b) < 70; };
  if (columns.name) {
    const n = columns.name; const nx = n.x + leftDx;
    const right = nameRight != null ? Math.min(nx + n.w + 40, Math.round(nameRight)) : nx + n.w;
    for (const team of profile.teams) team.rowCenters.forEach((cy0, row) => {
      const r = rows[`${team.id}:${row}`];
      r.nameRight = right;
      const cy = cy0 + r.statDy;
      // 1) Across: the name is the widest run of white text in the row (a rank emblem left of
      //    it leaves a shorter white chunk; drives/perks are coloured or outside the window).
      //    Window stops above the title line under the name.
      const yA = cy - 22; const yB = cy + 9;
      const runs = []; let start = -1;
      for (let x = nx - 40; x <= right; x += 1) {
        let on = false;
        if (x < right) { let hits = 0; for (let y = yA; y < yB; y += 1) if (isText(x, y) && ++hits >= 2) { on = true; break; } }
        if (on && start < 0) start = x;
        if (!on && start >= 0) { runs.push([start, x]); start = -1; }
      }
      const merged = [];
      for (const run of runs) { const last = merged.at(-1); if (last && run[0] - last[1] <= 6) last[1] = run[1]; else merged.push([...run]); }
      if (!merged.length) return;
      let best = merged.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
      for (const run of merged) if (run[0] > best[1] && run[0] - best[1] <= 12) best = [best[0], run[1]]; // word spaces
      if (best[1] - best[0] < 12) return; // too small to be a name
      r.nameX = best[0];
      // 2) Up/down: rows with white text inside that span only.
      const nb = inkBands(lum, best[0], best[1], yA, yB + 1, 165, 2, isText).filter((b) => b.h >= 8);
      const nameBand = nb.sort((a, b) => b.h - a.h)[0];
      if (nameBand) r.nameDy = Math.round(nameBand.c - cy0);
    });
  }
  return { dx, rows, cols: header, leftDx, perks };
}

function cellRois(profile = getProfile(), align = null) {
  const cells = [];
  for (const team of profile.teams) {
    team.rowCenters.forEach((cy, row) => {
      const a = align?.rows?.[`${team.id}:${row}`] || {};
      for (const [field, column] of Object.entries(profile.columns)) {
        // Names are taller (caps + slant) than the stat digits.
        const h = field === 'name' && profile.nameCellHeight ? profile.nameCellHeight : profile.cellHeight;
        let x = column.x; let c = cy;
        const lx = column.x + (align?.leftDx || 0); // left block (ult, name) position for this layout
        if (field === 'name') {
          c = cy + (a.nameDy || 0); x = lx;
          // Drives/emblems can push a name ~70 px right of where it starts on a plain row.
          if (a.nameX != null) x = Math.max(lx - 40, Math.min(lx + 110, a.nameX - 4));
        } else if (STAT_FIELDS.includes(field)) {
          c = cy + (Math.abs(a.statDy || 0) >= 3 ? a.statDy : 0); // ignore 1-2 px wiggle
          x = align?.cols?.[field] != null ? Math.round(align.cols[field] - column.w / 2) : column.x + (align?.dx || 0);
        }
        else { c = cy + (Math.abs(a.statDy || 0) >= 3 ? a.statDy : 0); x = lx; }
        // A name that starts later keeps its right edge (don't run into the elims column).
        const right = field === 'name' && a.nameRight != null ? Math.min(lx + column.w, a.nameRight) : lx + column.w;
        const w = field === 'name' ? Math.max(60, right - x) : column.w;
        cells.push({ side: team.id, row, field, column, roi: { x, y: c - Math.round(h / 2), w, h } });
      }
    });
  }
  return cells;
}

function cleanDigits(text) {
  return String(text || '')
    .replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/[Ss]/g, '5').replace(/[B]/g, '8')
    .replace(/[^0-9]/g, '');
}

// Returns a number, or null when the read is not plausible for that field.
function parseCell(field, text) {
  if (field === 'name') {
    const name = String(text || '').replace(/\s+/g, ' ').trim();
    return name.length >= 2 && name.length <= 24 ? name : null;
  }
  const digits = cleanDigits(text);
  if (!digits) return null;
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  if (field === 'ultimate') return value <= 100 ? value : null;
  if (['elims', 'assists', 'deaths'].includes(field)) return value <= 199 ? value : null;
  return value <= 99999 ? value : null; // damage / healing / mitigation
}

// Fraction (0..1) of the ult ring lit, walking clockwise from 12 o'clock until the first gap.
// `sample(x, y)` returns luminance 0..255 on the 1080p grid. Used as a cross-check for the
// printed percent and as the value when the number is hidden (READY shows an icon).
function ringFill(sample, cx, cy, radius, { lit = 150, steps = 180 } = {}) {
  let run = 0;
  for (let i = 0; i < steps; i += 1) {
    const t = (i / steps) * Math.PI * 2;
    let best = 0;
    for (const dr of [-1.5, -0.75, 0, 0.75, 1.5]) {
      best = Math.max(best, sample(Math.round(cx + (radius + dr) * Math.sin(t)), Math.round(cy - (radius + dr) * Math.cos(t))));
    }
    if (best < lit) break;
    run += 1;
  }
  return run / steps;
}

// How many digit glyphs are really printed in a cell, measured straight from the pixels:
// runs of bright columns inside the ROI that reach the upper part of the text band (so the
// low comma in "1,535" and the ult ring's edges don't count). Used to reject OCR reads whose
// digit count doesn't match the picture, e.g. "139" read from a lone "0", or a number read
// from an empty cell. `sample(x, y)` returns luminance 0..255 on the 1080p grid.
function glyphCount(sample, roi, { bright = 120, digitWidth = 8.3 } = {}) {
  // Digits in this font are ~8 px wide with ~1 px gaps and often touch (100, 220), so count
  // by the width of each tall run rather than by gaps alone.
  const cy = roi.y + Math.round(roi.h / 2);
  let count = 0; let start = -1; let tall = false;
  for (let x = roi.x; x <= roi.x + roi.w + 1; x += 1) {
    let any = false; let top = false;
    if (x <= roi.x + roi.w) {
      for (let y = cy - 6; y <= cy + 5; y += 1) {
        if (sample(x, y) > bright) { any = true; if (y <= cy - 2) top = true; }
      }
    }
    if (any) { if (start < 0) start = x; tall = tall || top; }
    else if (start >= 0) {
      if (tall) count += Math.max(1, Math.round((x - start) / digitWidth));
      start = -1; tall = false;
    }
  }
  return count;
}

// A numeric read is only believable when its digit count matches the glyphs in the picture.
function plausibleRead(field, value, glyphs) {
  if (field === 'name' || value === null || value === 'READY') return value;
  if (!Number.isFinite(glyphs)) return value;
  return String(value).length === glyphs ? value : null;
}

// READY: when the ult is charged the ring becomes a solid bright disc with a dark check mark
// cut out of it (no number). Fraction of bright pixels inside `radius` of the ring centre:
// READY ~0.8 on the ISU capture, a charging ring with its number ~0.1-0.25.
const READY_DISC_FILL = 0.6;
function discFill(sample, cx, cy, radius = 12, { bright = 150 } = {}) {
  let total = 0; let lit = 0;
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y += 1) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius) continue;
      total += 1;
      if (sample(x, y) > bright) lit += 1;
    }
  }
  return total ? lit / total : 0;
}
function isReadyDisc(sample, cx, cy, radius = 12) { return discFill(sample, cx, cy, radius) >= READY_DISC_FILL; }

// Combine the printed % with the ring. A full ring with no readable number = READY.
function resolveUltimate(printed, ring) {
  if (Number.isFinite(printed)) return printed;
  if (Number.isFinite(ring) && ring >= 0.97) return 'READY';
  return null;
}

// Per-cell agreement, same idea as VALORANT's observer consensus: one read never changes
// what is shown. First value needs 2 matching reads, a change 2, a suspicious change 4.
// Suspicious = a stat going DOWN (elims/assists/deaths/damage/healing/mitigation only grow
// during a map) or jumping implausibly (> 5 E/A/D, > 3000 dmg/heal/mit between sweeps).
class OverwatchConsensus {
  constructor({ first = 2, change = 2, correction = 4, nameReads = 3 } = {}) {
    Object.assign(this, { first, change, correction, nameReads });
    this.cells = new Map();
  }

  suspicious(field, current, next) {
    if (current === null || current === undefined || typeof current !== 'number' || typeof next !== 'number') return false;
    if (field === 'ultimate' || field === 'hero') return false; // ult resets; hero swaps are normal
    if (next < current) return true;
    const step = ['elims', 'assists', 'deaths'].includes(field) ? 5 : 3000;
    return next - current > step;
  }

  observe(key, field, current, next) {
    if (next === null || next === undefined) return { accept: false, value: current };
    let cell = this.cells.get(key);
    if (!cell || cell.candidate !== next) { cell = { candidate: next, streak: 0 }; this.cells.set(key, cell); }
    cell.streak += 1;
    if (current === next) return { accept: true, value: current };
    // Names are the noisiest field: always need nameReads matching reads.
    const needed = field === 'name' ? this.nameReads
      : current === null || current === undefined ? this.first : this.suspicious(field, current, next) ? this.correction : this.change;
    return cell.streak >= needed ? { accept: true, value: next } : { accept: false, value: current };
  }

  reset() { this.cells.clear(); }
}

function emptyPlayer(side, row) {
  return { side, slot: row + 1, name: '', nameManual: false, hero: null, ultimate: null, elims: null, assists: null, deaths: null, damage: null, healing: null, mitigation: null, updatedAt: 0 };
}

function emptyBoard() {
  return {
    teams: {
      home: { players: Array.from({ length: 5 }, (_v, i) => emptyPlayer('home', i)) },
      away: { players: Array.from({ length: 5 }, (_v, i) => emptyPlayer('away', i)) }
    },
    updatedAt: 0
  };
}

// Apply one sweep of raw cell reads ({side,row,field,value}) through the consensus gate.
function applySweep(board, consensus, reads, now = Date.now()) {
  let changed = false;
  for (const read of reads) {
    const player = board.teams[read.side]?.players[read.row];
    if (!player || !ALL_FIELDS.includes(read.field)) continue;
    const key = `${read.side}:${read.row}:${read.field}`;
    const current = player[read.field] === '' ? null : player[read.field];
    const result = consensus.observe(key, read.field, current, read.value);
    if (result.accept && result.value !== current) {
      player[read.field] = result.value;
      player.updatedAt = now;
      changed = true;
    }
  }
  if (changed) board.updatedAt = now;
  return changed;
}

module.exports = { PROFILES, STAT_FIELDS, ALL_FIELDS, getProfile, cellRois, alignBoard, headerColumns, inkBands, statOffset, parseCell, cleanDigits, glyphCount, plausibleRead, ringFill, discFill, isReadyDisc, READY_DISC_FILL, resolveUltimate, OverwatchConsensus, emptyBoard, applySweep };
