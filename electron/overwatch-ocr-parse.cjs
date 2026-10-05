'use strict';
// Overwatch 2 spectator scoreboard (Tab) -> structured player stats.
// Pure functions + a consensus gate, no Electron, so they are unit-testable with real
// screenshots. The capture/OCR loop (overwatch-ocr-service.cjs) feeds cell reads in here.
//
// Fields per player: name, ultimate (0-100 %, or 'READY'), elims, assists, deaths,
// damage, healing, mitigation. The board shows E / A / D (eliminations, assists, deaths).

const PROFILES = require('./overwatch-ocr-profiles.json');
const STAT_FIELDS = ['elims', 'assists', 'deaths', 'damage', 'healing', 'mitigation'];
const ALL_FIELDS = ['name', 'ultimate', ...STAT_FIELDS];

function getProfile(id = 'default-1080p') {
  return PROFILES[id] || PROFILES['default-1080p'];
}

// Every cell to read: { side, row, field, roi:{x,y,w,h}, column }.
function cellRois(profile = getProfile()) {
  const cells = [];
  const half = Math.round(profile.cellHeight / 2);
  for (const team of profile.teams) {
    team.rowCenters.forEach((cy, row) => {
      for (const [field, column] of Object.entries(profile.columns)) {
        cells.push({ side: team.id, row, field, column, roi: { x: column.x, y: cy - half, w: column.w, h: profile.cellHeight } });
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
  constructor({ first = 2, change = 2, correction = 4 } = {}) {
    Object.assign(this, { first, change, correction });
    this.cells = new Map();
  }

  suspicious(field, current, next) {
    if (current === null || current === undefined || typeof current !== 'number' || typeof next !== 'number') return false;
    if (field === 'ultimate') return false; // ult goes up and resets to 0 after use
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
    const needed = current === null || current === undefined ? this.first : this.suspicious(field, current, next) ? this.correction : this.change;
    return cell.streak >= needed ? { accept: true, value: next } : { accept: false, value: current };
  }

  reset() { this.cells.clear(); }
}

function emptyPlayer(side, row) {
  return { side, slot: row + 1, name: '', ultimate: null, elims: null, assists: null, deaths: null, damage: null, healing: null, mitigation: null, updatedAt: 0 };
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

module.exports = { PROFILES, STAT_FIELDS, ALL_FIELDS, getProfile, cellRois, parseCell, cleanDigits, ringFill, resolveUltimate, OverwatchConsensus, emptyBoard, applySweep };
