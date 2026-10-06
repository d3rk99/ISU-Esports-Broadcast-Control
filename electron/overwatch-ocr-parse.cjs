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
function inkBands(lum, x0, x1, y0, y1, thr = 165, minPx = 2) {
  const bands = []; let start = -1;
  for (let y = y0; y <= y1; y += 1) {
    let on = false;
    if (y < y1) { let n = 0; for (let x = x0; x < x1; x += 1) if (lum(x, y) >= thr && ++n >= minPx) { on = true; break; } }
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

// Per row: statDy (digits line), nameDy (the name's own text line, ignoring the small drive line
// under it), and nameX (where the name text starts). Plus dx for the whole stat block.
function alignBoard(lum, profile = getProfile()) {
  const { columns } = profile; const search = profile.align?.dy ?? 14;
  const statCols = STAT_FIELDS.map((f) => columns[f]).filter(Boolean);
  const sx0 = Math.min(...statCols.map((c) => c.x)); const sx1 = Math.max(...statCols.map((c) => c.x + c.w));
  const rows = {};
  for (const team of profile.teams) team.rowCenters.forEach((cy, row) => {
    const key = `${team.id}:${row}`;
    // Digits are ~11 px tall: the band nearest the expected centre.
    const sb = inkBands(lum, sx0, sx1, cy - search, cy + search + 1).filter((b) => b.h >= 6 && b.h <= 20);
    const statBand = sb.sort((a, b) => Math.abs(a.c - cy) - Math.abs(b.c - cy))[0];
    rows[key] = { statDy: statBand ? Math.round(statBand.c - cy) : 0, nameDy: 0, nameX: null };
  });
  const dx = statOffset(lum, profile, Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.statDy])));
  if (columns.name) {
    const n = columns.name;
    for (const team of profile.teams) team.rowCenters.forEach((cy, row) => {
      const r = rows[`${team.id}:${row}`];
      // The name is the TALLEST text line near the row (caps ~16-24 px); a drive line is ~6-9 px.
      const nb = inkBands(lum, n.x, n.x + n.w, cy - search - 8, cy + search + 18).filter((b) => b.h >= 10 && b.h <= 34);
      const nameBand = nb.sort((a, b) => b.h - a.h || Math.abs(a.c - cy) - Math.abs(b.c - cy))[0];
      if (!nameBand) return;
      r.nameDy = Math.round(nameBand.c - cy);
      // First text column of that line (names are left-aligned).
      for (let x = n.x - 12; x < n.x + 80; x += 1) {
        let hits = 0; for (let y = nameBand.y0; y < nameBand.y1; y += 1) if (lum(x, y) >= 165) hits += 1;
        if (hits >= 2) { r.nameX = x; break; }
      }
    });
  }
  return { dx, rows };
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
        if (field === 'name') {
          c = cy + (a.nameDy || 0);
          if (a.nameX != null) x = Math.max(column.x - 12, Math.min(column.x + 60, a.nameX - 4));
        } else if (STAT_FIELDS.includes(field)) { c = cy + (a.statDy || 0); x = column.x + (align?.dx || 0); }
        else c = cy + (a.statDy || 0);
        // A name that starts later keeps its right edge (don't run into the elims column).
        const w = field === 'name' ? Math.max(80, column.x + column.w - x) : column.w;
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

module.exports = { PROFILES, STAT_FIELDS, ALL_FIELDS, getProfile, cellRois, alignBoard, inkBands, statOffset, parseCell, cleanDigits, glyphCount, plausibleRead, ringFill, discFill, isReadyDisc, READY_DISC_FILL, resolveUltimate, OverwatchConsensus, emptyBoard, applySweep };
