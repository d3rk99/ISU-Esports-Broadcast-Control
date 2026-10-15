'use strict';
// VALORANT scoreboard: follow PLAYERS, not rows (Derk 2026-10-15).
// Since Patch 13.06 (2026-09-22) the scoreboard re-sorts each team by Performance Score during the match (Riot hasn't
// published the formula), so any row of a team can swap with any other row of that team at any moment. The old reader
// kept every value per `side:row`: after a swap a row showed a mix of two players for a few seconds and the roster sync
// took half-read names from it.
//
// This module sits between the cell reads and the board:
//  1. Each block (top 5 = 'home' block, bottom 5 = 'away' block in the reader) has 5 player SLOTS that belong to a
//     player, not a row. A slot is identified by its gamertag once that is known.
//  2. Every sweep, each row's raw name read is matched to the slots of the same block by tag similarity. A row whose
//     name clearly belongs to another slot = that player moved there: his slot now listens to this row.
//  3. Reads are re-keyed from (side,row) to (side,slot) before the consensus, so a swap never mixes two players.
//  4. Board output stays the same shape (teams.<side>.players[5]) but ordered by SLOT, each player carrying `row`
//     (where he is on the board now). Downstream code keys on names anyway.
// Hints: the controller can pass the roster gamertags (setKnownNames) so slots match pre-set players from read #1.

function norm(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Similarity 0..1 between two tags: 1 - Levenshtein / longer length, on normalized text. Same rule as the Overwatch /
// spectate name matching (tagSimilarity in src/overwatch-ocr-panel.js), kept self-contained for the main process.
function tagSimilarity(a, b) {
  const x = norm(a); const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const m = x.length; const n = y.length;
  let prev = Array.from({ length: n + 1 }, (_v, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

const MATCH = 0.75;    // a row read counts as a player's name at >= 75% similarity (OCR drops/garbles a letter or two)
const MARGIN = 0.1;    // ...and beats every other known player of the block by this much

class BoardIdentity {
  constructor({ sides = ['home', 'away'] } = {}) {
    this.sides = sides;
    // slot -> { tag, rowNow }: tag = confirmed gamertag ('' = not known yet), rowNow = where it was last seen
    this.slots = Object.fromEntries(sides.map((s) => [s, Array.from({ length: 5 }, (_v, i) => ({ tag: '', rowNow: i, seen: 0 }))]));
    this.known = Object.fromEntries(sides.map((s) => [s, []]));
    this.lastMoves = [];
  }

  reset() { const s = this.sides; Object.assign(this, new BoardIdentity({ sides: s })); }

  // Gamertags the controller expects in each block (from the rosters + the block->team decision). Optional.
  setKnownNames(bySide = {}) { for (const s of this.sides) this.known[s] = (bySide[s] || []).map((t) => String(t || '').trim()).filter(Boolean); }

  // A slot's tag once the consensus confirmed a name for it.
  confirm(side, slot, name) {
    const s = this.slots[side]?.[slot]; if (!s || !name) return;
    s.tag = name;
  }

  // Best known tag for a raw name read: slot tags first (players we already follow), then roster hints.
  bestFor(side, raw) {
    const cands = [];
    this.slots[side].forEach((s, i) => { if (s.tag) cands.push({ tag: s.tag, slot: i }); });
    for (const k of this.known[side]) if (!cands.some((c) => norm(c.tag) === norm(k))) cands.push({ tag: k, slot: -1 });
    let best = null; let second = 0;
    for (const c of cands) {
      const sc = tagSimilarity(raw, c.tag);
      if (!best || sc > best.score) { second = best ? best.score : 0; best = { ...c, score: sc }; } else if (sc > second) second = sc;
    }
    if (!best || best.score < MATCH || best.score - second < MARGIN) return null;
    return best;
  }

  // reads: [{ side, row, field, value }] for one sweep. Returns the same reads re-keyed to slots (r.row = slot) and
  // updates where every slot is on the board. Rows without a confident name keep their slot (no move).
  remap(reads) {
    this.lastMoves = [];
    for (const side of this.sides) {
      const slots = this.slots[side];
      const names = new Map(reads.filter((r) => r.side === side && r.field === 'name' && r.value).map((r) => [r.row, r.value]));
      // row -> slot this sweep. Start from where every slot was last seen.
      const rowToSlot = new Map(slots.map((s, i) => [s.rowNow, i]));
      const claims = []; // { row, slot, score }
      for (const [row, raw] of names) {
        const hit = this.bestFor(side, raw);
        if (hit && hit.slot >= 0) claims.push({ row, slot: hit.slot, score: hit.score });
        else if (hit && hit.slot < 0) claims.push({ row, slot: -1, tag: hit.tag, score: hit.score });
      }
      // Apply the confident claims, best first; a slot / row is used once.
      claims.sort((a, b) => b.score - a.score);
      const usedRow = new Set(); const usedSlot = new Set(); const next = new Map();
      for (const c of claims) {
        if (usedRow.has(c.row)) continue;
        let slot = c.slot;
        if (slot < 0) {
          // A roster player we don't follow yet: give him the slot sitting on this row if it has no tag, else any free one.
          const here = rowToSlot.get(c.row);
          slot = here !== undefined && !slots[here].tag && !usedSlot.has(here) ? here : slots.findIndex((s, i) => !s.tag && !usedSlot.has(i));
          if (slot < 0) continue;
        }
        if (usedSlot.has(slot)) continue;
        usedRow.add(c.row); usedSlot.add(slot); next.set(c.row, slot);
      }
      // Rows nobody claimed: the slots nobody claimed fill them, keeping their old row when it is free.
      const freeSlots = slots.map((_s, i) => i).filter((i) => !usedSlot.has(i));
      const freeRows = [0, 1, 2, 3, 4].filter((r) => !usedRow.has(r));
      for (const i of [...freeSlots]) {
        const r = slots[i].rowNow;
        if (freeRows.includes(r)) { next.set(r, i); freeRows.splice(freeRows.indexOf(r), 1); freeSlots.splice(freeSlots.indexOf(i), 1); }
      }
      freeSlots.forEach((i, k) => next.set(freeRows[k], i));
      for (const [row, slot] of next) {
        if (slots[slot].rowNow !== row) this.lastMoves.push({ side, slot, tag: slots[slot].tag, from: slots[slot].rowNow, to: row });
        slots[slot].rowNow = row;
      }
      for (const r of reads) if (r.side === side) { const sl = next.get(r.row); if (sl !== undefined) { r.slot = sl; r.boardRow = r.row; r.row = sl; } }
    }
    return reads;
  }

  rowOf(side, slot) { return this.slots[side]?.[slot]?.rowNow ?? slot; }
}

module.exports = { BoardIdentity, tagSimilarity, MATCH, MARGIN };
