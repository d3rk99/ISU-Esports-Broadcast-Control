// Roster Manager (Derk 2026-10-15): a team library per game = the source of truth for players.
// game.rosterLibrary = { teams: [{ id, name, shortName, isISU, color, logoImage, logoImageName, players: [LibPlayer] }] }
// LibPlayer = { id, handle, name, playerImage, playerImageName, status, program, role, stageStation }
//   status: 'starter' | 'sixth' | 'sub' | 'coach'      program: 'varsity' | 'jv'
// game.rosterAssign = { home: teamId, away: teamId } = which library team is loaded into each match side.
// loadTeamIntoMatch() writes the match rosters (game.rosters / game.awayRosters, varsity + jv) from the library:
// starters first, then 6th man, then subs (the match roster marks the first <rosterSize> slots STARTER). Coaches are
// kept in game.coaches[side] (not player slots: they never play, so the scoreboard reader never links them).
// Live fields the reader / controller filled in the match roster (agent, role, station...) are kept by gamertag.
export const STATUSES = ['starter', 'sixth', 'sub', 'coach'];
export const STATUS_LABEL = { starter: 'STARTER', sixth: '6TH MAN', sub: 'SUB', coach: 'COACH' };
export const PROGRAMS = ['varsity', 'jv'];
const ORDER = { starter: 0, sixth: 1, sub: 2, coach: 3 };

const uid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const clean = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function ensureLibrary(game) {
  if (!game.rosterLibrary || !Array.isArray(game.rosterLibrary.teams)) game.rosterLibrary = { teams: [] };
  if (!game.rosterAssign) game.rosterAssign = { home: '', away: '' };
  for (const t of game.rosterLibrary.teams) { t.players = Array.isArray(t.players) ? t.players : []; t.players.forEach(normalizePlayer); }
  return game.rosterLibrary;
}

function normalizePlayer(p) {
  p.id ||= uid('p');
  p.handle = clean(p.handle, 24); p.name = clean(p.name, 40);
  if (!STATUSES.includes(p.status)) p.status = 'sub';
  if (!PROGRAMS.includes(p.program)) p.program = 'varsity';
  p.playerImage ||= ''; p.playerImageName ||= ''; p.role ||= ''; p.stageStation ??= '';
  return p;
}

export function createTeam(game, { name = 'NEW TEAM', shortName = '', isISU = false, color = '' } = {}) {
  const lib = ensureLibrary(game);
  const team = { id: uid('t'), name: clean(name, 40) || 'NEW TEAM', shortName: clean(shortName, 6).toUpperCase(), isISU: Boolean(isISU), color: color || (isISU ? '#f47920' : '#5e6673'), logoImage: '', logoImageName: '', players: [] };
  lib.teams.push(team);
  return team;
}

export function findTeam(game, id) { return ensureLibrary(game).teams.find((t) => t.id === id) || null; }

export function addPlayer(team, fields = {}) {
  const p = normalizePlayer({ status: 'sub', program: 'varsity', ...fields, id: '' });
  team.players.push(p);
  return p;
}

// Bulk add: one player per line: "gamertag, name, status, program" (only the gamertag is needed). Tab works too
// (paste from a spreadsheet). Status words: starter / 6th / sixth / sub / coach; program: varsity / v / jv.
export function parseBulk(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.split(/\t|,|;/).map((c) => c.trim());
    const p = { handle: cells[0] || '', name: cells[1] || '' };
    for (const c of cells.slice(2)) {
      const w = c.toLowerCase();
      if (/^(starter|start|s)$/.test(w)) p.status = 'starter';
      else if (/^(6th|sixth|6|6th man|sixth man)$/.test(w)) p.status = 'sixth';
      else if (/^(sub|substitute|reserve|bench)$/.test(w)) p.status = 'sub';
      else if (/^(coach|c|head coach|assistant coach)$/.test(w)) p.status = 'coach';
      else if (/^(jv|junior varsity)$/.test(w)) p.program = 'jv';
      else if (/^(v|varsity)$/.test(w)) p.program = 'varsity';
    }
    if (p.handle || p.name) out.push(p);
  }
  return out;
}

export function bulkAdd(team, text) { return parseBulk(text).map((p) => addPlayer(team, p)); }

export function setForPlayers(team, ids, field, value) {
  const set = new Set(ids); let n = 0;
  for (const p of team.players) if (set.has(p.id) && p[field] !== value) { p[field] = value; n += 1; }
  return n;
}

export function removePlayers(team, ids) { const set = new Set(ids); const before = team.players.length; team.players = team.players.filter((p) => !set.has(p.id)); return before - team.players.length; }

export function sortedPlayers(team, program) {
  return team.players.map((p, i) => ({ p, i })).filter(({ p }) => !program || p.program === program)
    .sort((a, b) => ORDER[a.p.status] - ORDER[b.p.status] || a.i - b.i).map(({ p }) => p);
}

// Match roster slots for one program, from the library team. emptyPlayer() = createPlayer(config, i) of the app.
export function buildMatchRoster(team, program, previous = [], emptyPlayer, minSlots = 0) {
  const keep = new Map((previous || []).filter((p) => p?.handle).map((p) => [p.handle.toLowerCase(), p]));
  const players = sortedPlayers(team, program).filter((p) => p.status !== 'coach').map((lp, i) => {
    const old = keep.get(lp.handle.toLowerCase()) || {};
    return { ...emptyPlayer(i), ...old, handle: lp.handle, name: lp.name, playerImage: lp.playerImage || old.playerImage || '', playerImageName: lp.playerImageName || old.playerImageName || '',
      role: lp.role || old.role || emptyPlayer(i).role, stageStation: lp.stageStation !== '' ? lp.stageStation : old.stageStation ?? '', libraryId: lp.id, libraryStatus: lp.status, autoAdded: false };
  });
  while (players.length < minSlots) players.push(emptyPlayer(players.length));
  return players;
}

// Loads a library team into match side 'home' | 'away': both programs, the team identity, the coaches.
export function loadTeamIntoMatch(game, side, teamId, { emptyPlayer, rosterSize = 5 } = {}) {
  const team = findTeam(game, teamId); if (!team) return false;
  const key = side === 'away' ? 'awayRosters' : 'rosters';
  game[key] ||= { varsity: [], jv: [] };
  for (const program of PROGRAMS) game[key][program] = buildMatchRoster(team, program, game[key][program], emptyPlayer, rosterSize);
  const t = game.teams[side === 'away' ? 1 : 0];
  t.name = team.name; if (team.shortName) t.shortName = team.shortName;
  if (team.color) t.color = team.color;
  if (team.logoImage) { t.logoImage = team.logoImage; t.logoImageName = team.logoImageName; }
  game.coaches ||= { home: [], away: [] };
  game.coaches[side] = team.players.filter((p) => p.status === 'coach').map((p) => ({ handle: p.handle, name: p.name, playerImage: p.playerImage, program: p.program }));
  game.rosterAssign[side] = team.id;
  if (side === 'away' && team.players.length) game.showAwayRoster = true;
  return true;
}

// Which match side is Idaho State: the side whose loaded library team is marked ISU; else the team name says so.
export function isuSide(game) {
  for (const side of ['home', 'away']) if (findTeam(game, game.rosterAssign?.[side])?.isISU) return side;
  const i = (game.teams || []).findIndex((t) => /(^|\s)ISU($|\s)/i.test(t?.shortName || '') || /IDAHO STATE/i.test(t?.name || ''));
  return i === 1 ? 'away' : i === 0 ? 'home' : '';
}

// Library edits made in the match roster (portrait, station) flow back so the library stays the truth.
export function writeBackFromMatch(game, side) {
  const team = findTeam(game, game.rosterAssign?.[side]); if (!team) return 0;
  const key = side === 'away' ? 'awayRosters' : 'rosters'; let n = 0;
  for (const program of PROGRAMS) for (const mp of game[key]?.[program] || []) {
    const lp = team.players.find((p) => p.id === mp.libraryId); if (!lp) continue;
    for (const f of ['playerImage', 'playerImageName', 'stageStation', 'name']) if (mp[f] !== undefined && mp[f] !== lp[f] && mp[f] !== '') { lp[f] = mp[f]; n += 1; }
  }
  return n;
}

// Live link of a match roster to the scoreboard reader rows: best board name per player with % confidence.
// board = game.valorantBoard.live (already mapped by TEAM). similarity = tagSimilarity.
export function liveLinks(roster, boardPlayers, similarity, threshold = 0.9) {
  const rows = (boardPlayers || []).filter((r) => r?.name);
  const pairs = [];
  roster.forEach((p, pi) => { if (p?.handle) rows.forEach((r, ri) => pairs.push({ pi, ri, score: similarity(p.handle, r.name) })); });
  pairs.sort((a, b) => b.score - a.score);
  const usedP = new Set(); const usedR = new Set(); const out = new Map();
  for (const x of pairs) {
    if (usedP.has(x.pi) || usedR.has(x.ri) || x.score < 0.5) continue;
    usedP.add(x.pi); usedR.add(x.ri);
    out.set(x.pi, { name: rows[x.ri].name, row: rows[x.ri].row, block: rows[x.ri].block || '', agent: rows[x.ri].agent || '', score: x.score, linked: x.score >= threshold });
  }
  return out;
}
