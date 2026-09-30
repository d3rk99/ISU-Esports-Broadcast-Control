// Live Rocket League players -> roster slots, and which slots need an auto car render.
//
// The Stats API gives each player's in-game Name, TeamNum and Loadout. Rosters hold a
// gamertag (handle) and a real name. This module:
//   1. pairs every API player with the closest roster entry on its side (handle or name,
//      tolerant to case, spacing, clan tags like "[ISU]" and small typos),
//   2. writes unmatched API players into empty roster slots (or new slots) on that side,
//   3. reports which slots have no car PNG (or only an older automatic one) so the
//      controller can render the player's car and assign it.
// Manually chosen car PNGs are never replaced. Pure functions (no DOM) for node tests.

export const MATCH_THRESHOLD = 0.74;

export function normalizeGamerName(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[[({<][^\])}>]{1,8}[\])}>]/g, ' ') // clan / team tags: [ISU], (ISU), <ISU>
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = next;
  }
  return prev[b.length];
}

// 0..1 similarity between an in-game name and one roster label.
export function nameSimilarity(apiName, label) {
  const a = normalizeGamerName(apiName);
  const b = normalizeGamerName(label);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = Math.min(a.length, b.length);
  // "ISUBengal" vs "Bengal": one contains the other (needs 4+ chars so "a" doesn't match everything).
  if (shorter >= 4 && (a.includes(b) || b.includes(a))) return 0.85 + 0.1 * (shorter / Math.max(a.length, b.length));
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

export function rosterEntryScore(apiName, entry = {}) {
  return Math.max(nameSimilarity(apiName, entry.handle), nameSimilarity(apiName, entry.name) * 0.97);
}

function isEmptySlot(entry = {}) {
  return !String(entry.handle || '').trim() && !String(entry.name || '').trim();
}

// Greedy best-first pairing: highest similarity pairs first, each roster slot used once.
export function pairPlayers(apiPlayers = [], roster = [], threshold = MATCH_THRESHOLD) {
  const candidates = [];
  apiPlayers.forEach((player, p) => {
    roster.forEach((entry, r) => {
      if (isEmptySlot(entry)) return;
      // A slot previously linked to this exact player id wins outright.
      const linked = entry.rlPlayerId && player.id && entry.rlPlayerId === player.id;
      const score = linked ? 2 : rosterEntryScore(player.name, entry);
      if (score >= threshold) candidates.push({ p, r, score });
    });
  });
  candidates.sort((x, y) => y.score - x.score);
  const usedPlayers = new Set();
  const usedSlots = new Set();
  const pairs = [];
  for (const c of candidates) {
    if (usedPlayers.has(c.p) || usedSlots.has(c.r)) continue;
    usedPlayers.add(c.p); usedSlots.add(c.r);
    pairs.push(c);
  }
  const unmatched = apiPlayers.map((_, p) => p).filter((p) => !usedPlayers.has(p));
  return { pairs, unmatched };
}

export function liveLoadoutKey(loadout = []) {
  return (Array.isArray(loadout) ? loadout : []).slice(0, 3).map((item) => String(item || '').toLowerCase()).join('|');
}

// Does this slot need an automatic car render for this player's current loadout?
export function needsAutoCar(entry = {}, player = {}) {
  if (!Array.isArray(player.loadout) || !String(player.loadout[0] || '').trim() || /^none$/i.test(player.loadout[0])) return false;
  if (!entry.characterImage) return true;
  if (!entry.characterImageAuto) return false; // manual PNG: never touch
  return entry.characterImageLoadout !== liveLoadoutKey(player.loadout);
}

// Mutates rosters in place. sides: [{ side: 'home'|'away', roster: [...], players: [...] }].
// makeSlot(index) builds a blank roster entry. Returns { changed, added, linked, renders }.
export function syncRosterSides(sides = [], makeSlot = () => ({}), { addMissing = true } = {}) {
  const result = { changed: false, added: [], linked: [], renders: [] };
  for (const { side, roster, players } of sides) {
    if (!Array.isArray(roster) || !players?.length) continue;
    const { pairs, unmatched } = pairPlayers(players, roster);
    for (const { p, r } of pairs) {
      const entry = roster[r];
      if (entry.rlPlayerId !== players[p].id) { entry.rlPlayerId = players[p].id; result.changed = true; }
      result.linked.push({ side, index: r, playerId: players[p].id });
    }
    if (addMissing) {
      for (const p of unmatched) {
        const player = players[p];
        let index = roster.findIndex((entry) => isEmptySlot(entry) && !entry.characterImage);
        if (index < 0) { roster.push(makeSlot(roster.length)); index = roster.length - 1; }
        Object.assign(roster[index], { handle: String(player.name || '').slice(0, 24), rlPlayerId: player.id, autoAdded: true });
        result.changed = true;
        result.added.push({ side, index, name: player.name });
      }
    }
    roster.forEach((entry, index) => {
      if (!entry.rlPlayerId) return;
      const player = players.find((item) => item.id === entry.rlPlayerId);
      if (player && needsAutoCar(entry, player)) result.renders.push({ side, index, player });
    });
  }
  return result;
}
