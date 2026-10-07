'use strict';
// VALORANT scoreboard (Tab) -> structured player data. Rebuilt the same way as the Overwatch
// reader (overwatch-ocr-parse.cjs): pure functions on a luminance/RGB sampler of a 1920x1080
// frame, so everything is unit-testable with real screenshots.
//
// The board is found from the picture before every read (auto-align): the header labels
// (NAME ULTIMATE KDA LOADOUT CREDS PING) give the horizontal offset and the header line; each
// row is then snapped to its own K/D/A digits. Nothing found = profile positions.
//
// Fields per player: agent (icon match), name, ultimate ("3/8" or READY), kills, deaths,
// assists, credits, ping.

const fs = require('node:fs');
const path = require('node:path');

// Measured on the ISU observer screenshot (2026-10-07), 1080p grid.
const PROFILE = {
  width: 1920, height: 1080,
  headerY: 314,
  // header label centres (NAME, ULTIMATE, KDA, LOADOUT, CREDS, PING)
  headerLabels: [658, 866, 986, 1120, 1242, 1317],
  // row centres relative to the header line
  rowOffsets: { home: [32, 66, 100, 134, 168], away: [262, 296, 331, 365, 398] },
  cellHeight: 18,
  columns: {
    agent: { x: 567, w: 32, kind: 'icon' },
    name: { x: 634, w: 190, kind: 'text', lang: 'val', allowedChars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 _.#' },
    ultimate: { x: 842, w: 56, kind: 'ult', allowedChars: '0123456789/' },
    kills: { h: 14, threshold: 150, x: 936, w: 24, kind: 'count', allowedChars: '0123456789' },
    deaths: { h: 14, threshold: 150, x: 976, w: 24, kind: 'count', allowedChars: '0123456789' },
    assists: { h: 14, threshold: 150, x: 1016, w: 24, kind: 'count', allowedChars: '0123456789' },
    credits: { h: 14, x: 1229, w: 44, kind: 'credits', allowedChars: '0123456789,', threshold: 125, scale: 3 },
    loadout: { x: 1035, w: 122, kind: 'icon' },
    shield: { x: 1150, w: 64, kind: 'icon' },
    ping: { h: 14, x: 1302, w: 30, kind: 'count', allowedChars: '0123456789', threshold: 150 }
  },
  textThreshold: 175
};
const READ_FIELDS = ['name', 'ultimate', 'kills', 'deaths', 'assists', 'credits', 'ping'];
const SIDES = ['home', 'away'];

// ---- auto-align ------------------------------------------------------------------------
const isText = (lum, x, y, thr) => lum(x, y) >= thr;

// Header line: the row band (searched around headerY) with bright text at all six label spots,
// giving dy (vertical) and dx (horizontal, from the label run centres).
function findHeader(lum, profile = PROFILE, { searchY = 60, searchX = 80 } = {}) {
  const thr = profile.textThreshold;
  const x0 = Math.max(0, profile.headerLabels[0] - searchX - 40);
  const x1 = Math.min(profile.width, profile.headerLabels.at(-1) + searchX + 40);
  let best = null;
  for (let y = profile.headerY - searchY; y <= profile.headerY + searchY; y += 1) {
    // ink profile over a 6 px band
    const ink = new Uint8Array(x1 - x0);
    for (let dy = -3; dy <= 3; dy += 1) for (let x = x0; x < x1; x += 1) if (isText(lum, x, y + dy, thr)) ink[x - x0] = 1;
    const runs = []; let s = -1; let gapAt = -1;
    for (let i = 0; i <= ink.length; i += 1) {
      const on = i < ink.length && ink[i];
      if (on) { if (s < 0) s = i; gapAt = -1; continue; }
      if (s >= 0) { if (gapAt < 0) gapAt = i; if (i - gapAt > 9 || i === ink.length) { runs.push([s + x0, gapAt - 1 + x0]); s = -1; gapAt = -1; } }
    }
    const centres = runs.filter(([a, b]) => b - a >= 12 && b - a <= 80).map(([a, b]) => (a + b) / 2);
    if (centres.length < profile.headerLabels.length) continue;
    // pick the run of 6 whose spacing matches the labels best
    for (let i = 0; i + profile.headerLabels.length <= centres.length; i += 1) {
      const run = centres.slice(i, i + profile.headerLabels.length);
      const dx = run[0] - profile.headerLabels[0];
      let err = 0; for (let k = 0; k < run.length; k += 1) err += Math.abs(run[k] - profile.headerLabels[k] - dx);
      err /= run.length;
      if (err <= 6 && (!best || err < best.err - 0.5 || (Math.abs(err - best.err) <= 0.5 && Math.abs(y - profile.headerY) < Math.abs(best.y - profile.headerY)))) best = { y, dx: Math.round(dx), err };
    }
  }
  if (!best) return null;
  // centre of the header text band at that dx
  let top = best.y; let bottom = best.y;
  const hasInk = (y) => { let n = 0; for (const c of profile.headerLabels) for (let x = c - 10; x <= c + 10; x += 1) if (isText(lum, x + best.dx, y, thr)) n += 1; return n >= 6; };
  while (top > best.y - 12 && hasInk(top - 1)) top -= 1;
  while (bottom < best.y + 12 && hasInk(bottom + 1)) bottom += 1;
  return { dx: best.dx, dy: Math.round((top + bottom) / 2 - profile.headerY) };
}

// Snap one row to its K/D/A digits (the most reliable ink on a row): the digit band
// (8-16 px tall) whose centre is nearest the expected centre. Other lines (header, the next
// row) are separate bands, so they can't stretch this one.
function snapRow(lum, profile, cy, dx, search = 9) {
  const cols = ['kills', 'deaths', 'assists'].map((f) => profile.columns[f]);
  const bands = []; let top = -1;
  for (let y = cy - search - 9; y <= cy + search + 10; y += 1) {
    let n = 0;
    for (const c of cols) for (let x = c.x + dx; x < c.x + c.w + dx; x += 1) if (isText(lum, x, y, profile.textThreshold)) n += 1;
    if (n >= 2 && top < 0) top = y;
    if (n < 2 && top >= 0) { bands.push([top, y - 1]); top = -1; }
  }
  const good = bands.filter(([a, b]) => b - a >= 6 && b - a <= 16).map(([a, b]) => Math.round((a + b) / 2 - cy)).filter((c) => Math.abs(c) <= search);
  good.sort((a, b) => Math.abs(a) - Math.abs(b));
  return good.length ? good[0] : 0;
}

function alignBoard(lum, profile = PROFILE) {
  const header = findHeader(lum, profile);
  const dx = header?.dx || 0; const dy = header?.dy || 0;
  const rows = {};
  for (const side of SIDES) profile.rowOffsets[side].forEach((off, row) => {
    const cy = profile.headerY + dy + off;
    rows[`${side}:${row}`] = { cy: cy + snapRow(lum, profile, cy, dx) };
  });
  return { found: Boolean(header), dx, dy, rows };
}

// Every cell to read: { side, row, field, roi, column }.
function cellRois(profile = PROFILE, align = null) {
  const cells = [];
  for (const side of SIDES) profile.rowOffsets[side].forEach((off, row) => {
    const cy = align?.rows?.[`${side}:${row}`]?.cy ?? profile.headerY + off;
    const dx = align?.dx || 0;
    for (const field of READ_FIELDS) {
      const column = profile.columns[field];
      const h = column.h || profile.cellHeight + (field === 'name' ? 4 : 0);
      cells.push({ side, row, field, column, roi: { x: column.x + dx, y: Math.round(cy - h / 2), w: column.w, h } });
    }
  });
  return cells;
}

// Credits: the cell starts with the small currency icon (a hollow square, shorter than the
// digits) and the number follows it, left-aligned, so the icon moves with the number's width.
// OCR read that icon as a '1' ('¤100' -> 1100, '¤400' -> 1400). Find the ink runs, drop the
// icon (leading run clearly shorter than the digits) and tighten the box to the digits only.
function creditsRoi(lum, roi, { thr = 150 } = {}) {
  const x0 = roi.x - 10; const x1 = roi.x + roi.w + 6;
  const runs = []; let s = -1; let top = Infinity; let bot = -1;
  for (let x = x0; x <= x1; x += 1) {
    let on = false;
    if (x < x1) for (let y = roi.y - 2; y < roi.y + roi.h + 2; y += 1) if (lum(x, y) >= thr) { on = true; top = Math.min(top, y); bot = Math.max(bot, y); }
    if (on && s < 0) s = x;
    if (!on && s >= 0) { runs.push({ x0: s, x1: x - 1, top, bot, h: bot - top + 1 }); s = -1; top = Infinity; bot = -1; }
  }
  const tall = runs.filter((r) => r.h >= 6);
  if (!tall.length) return null;
  const H = Math.max(...tall.map((r) => r.h));
  // the icon is the first run and noticeably shorter (7 rows vs ~10 for digits)
  let i = 0; while (i < tall.length - 1 && tall[i].h <= H - 2 && tall[i].x1 - tall[i].x0 <= 9) i += 1;
  const digits = tall.slice(i).filter((r) => r.h >= H - 2);
  if (!digits.length) return null;
  const a = digits[0].x0 - 2; const b = runs[runs.length - 1].x1 + 3;
  return { x: a, y: roi.y, w: Math.max(6, b - a), h: roi.h };
}

// ---- agents ------------------------------------------------------------------------------
// 32x32 RGBA official icons (valorant-api.com). Score = RMS colour difference under the
// icon's alpha, best over a small position search. Must beat the runner-up clearly.
class AgentMatcher {
  constructor({ dir = __dirname } = {}) {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'valorant-agent-templates.json'), 'utf8'));
    const bin = fs.readFileSync(path.join(dir, 'valorant-agent-templates.bin'));
    this.size = meta.size; this.names = meta.agents;
    const n = this.size * this.size;
    this.templates = this.names.map((name, i) => ({ name, px: bin.subarray(i * n * 4, (i + 1) * n * 4) }));
  }

  match(rgbAt, cx, cy, { search = 4, maxScore = 46, minGap = 9 } = {}) {
    const S = this.size; const half = S / 2;
    const scores = [];
    for (const t of this.templates) {
      let best = Infinity;
      for (let oy = -3; oy <= 3; oy += 1) for (let ox = -search; ox <= search; ox += 1) {
        let sum = 0; let wsum = 0;
        for (let y = 0; y < S; y += 2) for (let x = 0; x < S; x += 2) {
          const o = (y * S + x) * 4; const a = t.px[o + 3] / 255; if (a < 0.1) continue;
          const p = rgbAt(cx - half + ox + x, cy - half + oy + y);
          for (let k = 0; k < 3; k += 1) { const d = p[k] * a - t.px[o + k] * a; sum += d * d; }
          wsum += a * 3;
        }
        const s = Math.sqrt(sum / (wsum || 1)); if (s < best) best = s;
      }
      scores.push([best, t.name]);
    }
    scores.sort((a, b) => a[0] - b[0]);
    const [score, agent] = scores[0]; const runnerUp = scores[1];
    const ok = score <= maxScore && runnerUp[0] - score >= minGap;
    return { agent: ok ? agent : null, candidate: agent, score: Math.round(score * 10) / 10, runnerUp: runnerUp[1], runnerUpScore: Math.round(runnerUp[0] * 10) / 10 };
  }
}

// Digit count straight from the pixels (bright column runs), like the Overwatch reader:
// 0 = empty cell, otherwise an OCR read must have exactly that many digits. Separators
// (',' '/') are narrow and short, so they don't count.
function glyphCount(lum, roi, { thr = PROFILE.textThreshold, digitWidth = 7.5, minH = 6 } = {}) {
  let count = 0; let start = -1; let top = Infinity; let bottom = -1;
  for (let x = roi.x; x <= roi.x + roi.w; x += 1) {
    let on = false;
    if (x < roi.x + roi.w) for (let y = roi.y; y < roi.y + roi.h; y += 1) if (lum(x, y) >= thr) { on = true; top = Math.min(top, y); bottom = Math.max(bottom, y); }
    if (on && start < 0) start = x;
    if (!on && start >= 0) { if (bottom - top + 1 >= minH) count += Math.max(1, Math.round((x - start) / digitWidth)); start = -1; top = Infinity; bottom = -1; }
  }
  return count;
}
function plausibleRead(field, value, glyphs) {
  if (value === null || ['name', 'ultimate'].includes(field) || !Number.isFinite(glyphs)) return value;
  // credits: the comma is narrow and short, so it never counts as a glyph
  return String(value).length === glyphs ? value : null;
}

// ---- loadout: weapon + shield ---------------------------------------------------------
// Both are white silhouettes on the row. Weapon: the ink in the LOADOUT box is cropped to its
// bounding box, squashed to 64x16 and compared (IoU) with the official icon silhouettes.
// Shield: a ~20 px icon just left of the creds, best IoU over a small position search against
// the official Light / Heavy / Regen shapes. Low scores = nothing / not sure (null).
class GearMatcher {
  constructor({ dir = __dirname } = {}) {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'valorant-gear-templates.json'), 'utf8'));
    const bin = fs.readFileSync(path.join(dir, 'valorant-weapon-templates.bin'));
    this.w = meta.w; this.h = meta.h; const n = this.w * this.h;
    this.weapons = meta.weapons.map((name, i) => ({ name, m: bin.subarray(i * n, (i + 1) * n) }));
    const realPath = path.join(dir, 'valorant-weapon-real.bin');
    if (meta.real && fs.existsSync(realPath)) {
      const real = fs.readFileSync(realPath);
      meta.real.forEach((name, i) => this.weapons.push({ name, m: real.subarray(i * n, (i + 1) * n) }));
    }
    // Trained set (tools/valorant-gun-training): board-size renders of every official icon.
    const trainedPath = path.join(dir, 'valorant-weapon-trained.bin');
    if (meta.trained && fs.existsSync(trainedPath)) {
      const trained = fs.readFileSync(trainedPath);
      meta.trained.forEach((name, i) => this.weapons.push({ name, m: trained.subarray(i * n, (i + 1) * n), trained: true }));
    }
    this.shieldSize = meta.shieldSize;
    this.shields = [['light', 'light-armor'], ['heavy', 'heavy-armor'], ['regen', 'regen-shield']]
      .map(([name, file]) => ({ name, m: fs.readFileSync(path.join(dir, `valorant-shield-${file}.bin`)) }));
  }

  // Gun silhouette in roi -> 64x16 mask (null = no gun).
  silhouette(lum, roi, thr = 150) {
    // The gun is the widest connected run of ink columns (stray text bits are narrow and
    // separate); then its rows. Columns with fewer than 2 ink px are ignored.
    const colInk = (x) => { let n = 0; for (let y = roi.y; y < roi.y + roi.h; y += 1) if (lum(x, y) >= thr) n += 1; return n; };
    let best = null; let s = -1; let gap = 0;
    for (let x = roi.x; x <= roi.x + roi.w; x += 1) {
      const on = x < roi.x + roi.w && colInk(x) >= 2;
      if (on) { if (s < 0) s = x; gap = 0; continue; }
      if (s >= 0 && (++gap > 3 || x === roi.x + roi.w)) { const e = x - gap; if (!best || e - s > best[1] - best[0]) best = [s, e]; s = -1; gap = 0; }
    }
    let x0 = best ? best[0] : Infinity; let x1 = best ? best[1] : -1; let y0 = Infinity; let y1 = -1;
    if (best) for (let y = roi.y; y < roi.y + roi.h; y += 1) for (let x = x0; x <= x1; x += 1) if (lum(x, y) >= thr) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    if (x1 < 0 || x1 - x0 < 12) return null;
    const bw = x1 - x0 + 1; const bh = y1 - y0 + 1; const cell = new Uint8Array(this.w * this.h);
    for (let j = 0; j < this.h; j += 1) for (let i = 0; i < this.w; i += 1) cell[j * this.w + i] = lum(x0 + Math.floor((i + 0.5) * bw / this.w), y0 + Math.floor((j + 0.5) * bh / this.h)) >= thr ? 1 : 0;
    return cell;
  }

  // Best IoU per weapon over all its templates (official icon + real board crops); a weapon
  // must clearly beat the next DIFFERENT weapon.
  weapon(lum, roi, { thr = 150, minScore = 0.6, minGap = 0.05 } = {}) {
    const cell = this.silhouette(lum, roi, thr);
    if (!cell) return { weapon: null, score: 0 };
    const best = new Map();
    for (const t of this.weapons) { let inter = 0; let union = 0; for (let k = 0; k < cell.length; k += 1) { inter += cell[k] & t.m[k]; union += cell[k] | t.m[k]; } const iou = union ? inter / union : 0; if (iou > (best.get(t.name) || 0)) best.set(t.name, iou); }
    const scores = [...best.entries()].map(([n, v]) => [v, n]).sort((x, y) => y[0] - x[0]);
    const ok = scores[0][0] >= minScore && scores[0][0] - scores[1][0] >= minGap;
    return { weapon: ok ? scores[0][1] : null, candidate: scores[0][1], score: Math.round(scores[0][0] * 100) / 100, runnerUp: scores[1][1] };
  }

  shield(lum, x0, x1, cy, { thr = 150, minScore = 0.55, minGap = 0.15 } = {}) {
    const S = this.shieldSize; const best = new Map();
    for (let y = cy - S / 2 - 4; y <= cy - S / 2 + 4; y += 1) for (let x = x0; x <= x1 - S; x += 1) {
      let ink = 0; for (let j = 0; j < S; j += 2) for (let i = 0; i < S; i += 2) if (lum(x + i, y + j) >= thr) ink += 1;
      if (ink < 6) continue;
      for (const t of this.shields) {
        let inter = 0; let union = 0;
        for (let j = 0; j < S; j += 1) for (let i = 0; i < S; i += 1) { const p = lum(x + i, y + j) >= thr ? 1 : 0; const m = t.m[j * S + i]; inter += p & m; union += p | m; }
        const iou = union ? inter / union : 0; if (iou > (best.get(t.name) || 0)) best.set(t.name, iou);
      }
    }
    const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return { shield: 'none', score: 0 };
    const [name, score] = ranked[0]; const gap = score - (ranked[1]?.[1] || 0);
    return { shield: score >= minScore && gap >= minGap ? name : null, candidate: name, score: Math.round(score * 100) / 100 };
  }
}

// ---- parsing ------------------------------------------------------------------------------
const digits = (t) => String(t || '').replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/[Ss]/g, '5').replace(/[^0-9]/g, '');

function parseCell(field, text) {
  const raw = String(text || '').trim();
  if (field === 'name') {
    const name = raw.replace(/\s+/g, ' ').replace(/[^A-Za-z0-9 _.#]/g, '').trim();
    return name.length >= 2 ? name : null;
  }
  if (field === 'ultimate') {
    if (/READY/i.test(raw)) return 'READY';
    const m = raw.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
    if (!m) return null;
    const cur = Number(m[1]); const req = Number(m[2]);
    if (req < 5 || req > 9 || cur > req) return null; // ult costs are 5-9 points
    return cur === req ? 'READY' : `${cur}/${req}`;
  }
  const d = digits(raw);
  if (!d) return null;
  const v = Number(d);
  if (field === 'credits') return v <= 9000 && v % 50 === 0 ? v : null;
  if (field === 'ping') return v <= 999 ? v : null;
  return v <= 99 ? v : null; // K / D / A
}

// One cell -> value. Tries a short ladder of cleanups (threshold/scale) until the OCR is sure;
// numbers must also match the digit count seen in the pixels, so a doubt stays blank instead
// of becoming a wrong number. makeImage(roi, scale, threshold) builds the OCR input.
const NUMBER_LADDER = [[150, 4], [175, 4], [125, 4], [175, 6], [110, 5], [150, 6]];
// names: white on dark; tagged names (LCU | name) are dimmer, so 130 comes last
const TEXT_LADDER = [[175, 4], [150, 4], [130, 4]];
async function readCell(ocr, lum, cell, makeImage, fieldId = 'valorant-board') {
  const isText = cell.field === 'name';
  if (cell.field === 'credits') {
    const tight = creditsRoi(lum, cell.roi);
    if (!tight) return null; // nothing there (not even the 0): don't guess
    cell = { ...cell, roi: tight };
  }
  const g = isText || cell.field === 'ultimate' ? NaN : glyphCount(lum, cell.roi, { thr: 150 });
  if (g === 0) return 0;
  for (const [thr, scale] of isText ? TEXT_LADDER : NUMBER_LADDER) {
    const r = await ocr.recognize(makeImage(cell.roi, scale, thr), { allowedChars: cell.column.allowedChars, kind: isText ? 'text' : 'score', fieldId, pageMode: g === 1 ? 'char' : 'line', ...(cell.column.lang ? { lang: cell.column.lang } : {}) });
    if (r.confidence < (isText ? 0.6 : 0.7)) continue;
    const v = plausibleRead(cell.field, parseCell(cell.field, r.text), g);
    if (v !== null) return v;
  }
  return null;
}

// ---- consensus (same rules as Overwatch) --------------------------------------------------
class BoardConsensus {
  constructor({ first = 2, change = 2, correction = 4, nameReads = 3 } = {}) { Object.assign(this, { first, change, correction, nameReads }); this.cells = new Map(); }
  suspicious(field, current, next) {
    if (typeof current !== 'number' || typeof next !== 'number') return false;
    if (['kills', 'deaths', 'assists'].includes(field)) return next < current || next - current > 5;
    return false;
  }
  observe(key, field, current, next) {
    if (next === null || next === undefined) return { accept: false, value: current };
    let cell = this.cells.get(key);
    if (!cell || cell.candidate !== next) { cell = { candidate: next, streak: 0 }; this.cells.set(key, cell); }
    cell.streak += 1;
    if (current === next) return { accept: true, value: current };
    const needed = field === 'name' ? this.nameReads : current === null || current === undefined ? this.first : this.suspicious(field, current, next) ? this.correction : this.change;
    return cell.streak >= needed ? { accept: true, value: next } : { accept: false, value: current };
  }
}

function emptyPlayer(side, row) { return { side, row, agent: null, weapon: null, shield: null, name: '', ultimate: null, kills: null, deaths: null, assists: null, credits: null, ping: null, updatedAt: 0 }; }
function emptyBoard() { return { updatedAt: 0, teams: Object.fromEntries(SIDES.map((s) => [s, { players: Array.from({ length: 5 }, (_v, i) => emptyPlayer(s, i)) }])) }; }

function applySweep(board, consensus, reads, now = Date.now()) {
  let changed = false;
  for (const r of reads) {
    const player = board.teams[r.side]?.players?.[r.row]; if (!player) continue;
    if (r.field === 'name' && player.nameManual) continue;
    const key = `${r.side}:${r.row}:${r.field}`;
    const res = consensus.observe(key, r.field, player[r.field], r.value);
    if (res.accept && player[r.field] !== res.value) { player[r.field] = res.value; player.updatedAt = now; changed = true; }
  }
  if (changed) board.updatedAt = now;
  return changed;
}

module.exports = { creditsRoi, GearMatcher, PROFILE, READ_FIELDS, SIDES, glyphCount, plausibleRead, readCell, findHeader, alignBoard, cellRois, AgentMatcher, parseCell, BoardConsensus, emptyBoard, applySweep };
