'use strict';

const norm = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const { matchCandidates } = require('./spectate-tracker.cjs');

function spectateCandidatesFrom(state = {}) {
  const game = state.games?.[state.selectedGame] || {};
  const live = state.selectedGame === 'valorant' ? game.valorantBoard?.live?.teams
    : state.selectedGame === 'overwatch' ? game.overwatchOcr?.live?.teams : null;
  const out = [];
  const claimedRows = new Map();
  // Names identify players even during a side change; roster metadata takes priority
  // over a cached board row. Do not add a second candidate on the old side.
  const players = ['home', 'away'].flatMap((side) => (live?.[side]?.players || []).filter((p) => p?.name).map((p) => ({ ...p, side })));
  const boardPlayer = (name) => {
    const exact = players.filter((p) => norm(p.name) === norm(name));
    if (exact.length === 1) return exact[0];
    const { best, runnerUp } = matchCandidates(name, players);
    return best?.score >= 0.8 && best.score - (runnerUp?.score || 0) >= 0.15 ? best : null;
  };
  for (const [side, rosters, team] of [['home', game.rosters, game.teams?.[0]], ['away', game.awayRosters, game.teams?.[1]]]) {
    for (const key of ['varsity', 'jv']) for (const p of rosters?.[key] || []) {
      const name = String(p?.handle || p?.name || '').trim();
      if (!name) continue;
      const row = boardPlayer(name);
      const currentSide = row?.side || side;
      const candidate = { name, station: Math.round(Number(p.stageStation) || 0) || null, side: currentSide,
        team: game.teams?.[currentSide === 'home' ? 0 : 1]?.name || team?.name || '', agent: row?.agent || '' };
      const rowKey = row ? `${row.side}:${norm(row.name)}` : '';
      const existing = claimedRows.get(rowKey) || out.find((c) => norm(c.name) === norm(candidate.name));
      if (!existing) { out.push(candidate); if (rowKey) claimedRows.set(rowKey, candidate); }
      else if (!existing.station && candidate.station) existing.station = candidate.station;
    }
  }
  for (const side of ['home', 'away']) for (const p of live?.[side]?.players || []) {
    if (p?.name && !claimedRows.has(`${side}:${norm(p.name)}`) && !out.some((c) => norm(c.name) === norm(p.name))) out.push({ name: p.name, station: null, side, team: game.teams?.[side === 'home' ? 0 : 1]?.name || '', agent: p.agent || '' });
  }
  return out;
}

function spectateSidesFrom(state = {}) {
  const game = state.games?.valorant;
  if (state.selectedGame !== 'valorant' || !game) return null;
  const h = Number(game.teams?.[0]?.detailScore) || 0;
  const a = Number(game.teams?.[1]?.detailScore) || 0;
  const override = Number(game.valorantRoundOverride?.[game.activeMap || 0]);
  const match = game.valorantBoard?.live?.match;
  const scoreRound = Number.isFinite(match?.homeScore) && Number.isFinite(match?.awayScore) ? match.homeScore + match.awayScore + 1 : h + a + 1;
  const round = Number.isInteger(override) && override >= 1 && override <= 100 ? override : scoreRound;
  // Board colours refer to physical top/bottom blocks; blocks maps those to teams.
  const board = game.valorantBoard?.live;
  for (const [block, rawSide] of [['top', 'home'], ['bottom', 'away']]) {
    const team = board?.blocks?.[block];
    const color = board?.colors?.[rawSide];
    if (['home', 'away'].includes(team) && ['red', 'teal'].includes(color)) {
      const other = team === 'home' ? 'away' : 'home';
      return { round, red: color === 'red' ? team : other, teal: color === 'teal' ? team : other };
    }
  }
  const swapped = round <= 12 ? false : round <= 24 ? true : (round - 25) % 2 === 1;
  const attackers = game.veto?.picks?.[game.activeMap || 0]?.attackers;
  const firstRed = [0, 1, '0', '1'].includes(attackers) ? (Number(attackers) === 0 ? 'home' : 'away') : 'away';
  const red = swapped ? (firstRed === 'home' ? 'away' : 'home') : firstRed;
  return { round, red, teal: red === 'home' ? 'away' : 'home' };
}

function resolveSpectated(state, spectated) {
  if (!spectated?.name || (spectated.game && spectated.game !== state.selectedGame)) return { ...spectated, name: '' };
  const candidate = spectateCandidatesFrom(state).find((c) => norm(c.name) === norm(spectated.name));
  return candidate ? { ...spectated, side: candidate.side, team: candidate.team, station: candidate.station } : spectated;
}

module.exports = { spectateCandidatesFrom, spectateSidesFrom, resolveSpectated };
