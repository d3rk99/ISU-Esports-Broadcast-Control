import { GAME_CONFIGS, rocketLeagueArenaName } from './game-config.js';

function actionError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function teamIndex(value) {
  if (value === 'home' || value === 0 || value === '0') return 0;
  if (value === 'away' || value === 1 || value === '1') return 1;
  throw actionError('team must be home or away');
}

function wholeNumber(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  const number = value === undefined && fallback !== undefined ? fallback : Number(value);
  if (!Number.isFinite(number)) throw actionError(`${label} must be a number`);
  return Math.max(min, Math.min(max, Math.round(number)));
}

export function swapGameTeams(game) {
  game.teams.reverse();
  [game.rosters, game.awayRosters] = [game.awayRosters, game.rosters];
  game.mapRows.forEach((row) => {
    row.score.reverse();
    if (row.winner !== null) row.winner = row.winner === 0 ? 1 : 0;
  });
  game.veto?.picks?.forEach((pick) => { pick.attackers = Number(pick.attackers) === 0 ? 1 : 0; });
}

function resetDetailScores(game, gameKey) {
  const resetValue = gameKey === 'smash' ? 12 : 0;
  game.teams.forEach((team) => { team.detailScore = resetValue; });
}

function resetAllScores(game, gameKey) {
  resetDetailScores(game, gameKey);
  game.teams.forEach((team) => { team.score = 0; });
  if (gameKey === 'valorant') resetMapResults(game, gameKey);
}

function seriesLength(game) {
  return Math.max(1, Number(game.seriesLength) || game.mapRows.length);
}

function seriesTarget(game) {
  return Math.ceil(seriesLength(game) / 2);
}

function visibleMapRows(game) {
  return game.mapRows.slice(0, Math.min(game.mapRows.length, seriesLength(game)));
}

function resetValorantPickResults(game) {
  game.veto?.picks?.forEach((pick) => {
    pick.score = ['', ''];
    pick.winner = null;
  });
}

function resetMapResults(game, gameKey) {
  game.mapRows.forEach((row, index) => {
    row.winner = null;
    row.score = ['', ''];
    row.overtime = false;
    row.overtimeSeconds = 0;
    if (gameKey === 'overwatch') {
      row.map = '';
      row.mode = '';
    }
    row.status = index === 0 ? 'ready' : 'upcoming';
  });
  if (gameKey === 'valorant') resetValorantPickResults(game);
  game.teams.forEach((team) => { team.score = 0; });
  game.activeMap = 0;
}

function saveActiveMapResult(game, gameKey) {
  const row = game.mapRows[game.activeMap];
  if (!row) return;
  const scores = game.teams.map((team) => Number(team.detailScore) || 0);
  if (gameKey === 'rocketleague') {
    const arena = rocketLeagueArenaName(game.rocketLeague?.live?.arena);
    if (arena) row.map = arena;
    const live = game.rocketLeague?.live || {};
    const overtimeSeconds = Math.max(0, Math.floor(Number(live.overtimeSeconds || 0)));
    const wentToOvertime = Boolean(live.overtime) || overtimeSeconds > 0;
    row.overtime = wentToOvertime;
    row.overtimeSeconds = wentToOvertime ? overtimeSeconds || Math.max(0, Math.floor(Number(live.timeSeconds || 0))) : 0;
  }
  row.score = scores.map((score) => String(score));
  row.winner = scores[0] === scores[1] ? null : Number(scores[1] > scores[0]);
  row.status = row.winner === null ? 'ready' : 'complete';
  game.teams.forEach((team, index) => { team.score = visibleMapRows(game).filter((mapRow) => mapRow.winner === index).length; });
}

export function advanceGameMatch(game, gameKey) {
  const length = visibleMapRows(game).length;
  const nextIndex = (game.activeMap + 1) % length;
  saveActiveMapResult(game, gameKey);
  game.activeMap = nextIndex;
  resetDetailScores(game, gameKey);
  game.mapRows.forEach((row, rowIndex) => {
    row.status = row.winner !== null ? 'complete' : (rowIndex === nextIndex ? 'ready' : 'upcoming');
  });
  return nextIndex;
}

export function applyCompanionAction(state, request = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw actionError('Action request must be a JSON object');
  const action = String(request.action || '');
  if (!action) throw actionError('action is required');
  if (action === 'output.select') {
    const output = String(request.output || request.name || '').trim();
    if (!['scoreboard', 'roster', 'map-pool', 'clean'].includes(output)) throw actionError('output must be scoreboard, roster, map-pool, or clean');
    state.activeOutputOverlay = output;
    return { message: `Program output selected: ${output}`, outputChanged: true };
  }
  if (action === 'game.select') {
    if (!GAME_CONFIGS[request.game]) throw actionError(`Unknown game: ${request.game || '(empty)'}`);
    state.selectedGame = request.game;
    return { message: `Selected ${GAME_CONFIGS[request.game].name}`, selectedGameChanged: true };
  }

  const gameKey = request.game || state.selectedGame;
  const game = state.games[gameKey];
  const config = GAME_CONFIGS[gameKey];
  if (!game || !config) throw actionError(`Unknown game: ${gameKey}`);
  const mutators = {
    'score.increment': () => {
      const index = teamIndex(request.team);
      const amount = wholeNumber(request.amount, 'amount', { min: 1, fallback: 1 });
      game.teams[index].score = Math.min(seriesTarget(game), (Number(game.teams[index].score) || 0) + amount);
    },
    'score.decrement': () => {
      const index = teamIndex(request.team);
      const amount = wholeNumber(request.amount, 'amount', { min: 1, fallback: 1 });
      game.teams[index].score = Math.max(0, (Number(game.teams[index].score) || 0) - amount);
    },
    'score.set': () => {
      const index = teamIndex(request.team);
      game.teams[index].score = wholeNumber(request.value, 'value', { max: seriesTarget(game) });
    },
    'detail_score.increment': () => {
      const index = teamIndex(request.team);
      game.teams[index].detailScore = (Number(game.teams[index].detailScore) || 0) + wholeNumber(request.amount, 'amount', { min: 1, fallback: 1 });
    },
    'detail_score.decrement': () => {
      const index = teamIndex(request.team);
      game.teams[index].detailScore = Math.max(0, (Number(game.teams[index].detailScore) || 0) - wholeNumber(request.amount, 'amount', { min: 1, fallback: 1 }));
    },
    'detail_score.set': () => {
      const index = teamIndex(request.team);
      game.teams[index].detailScore = wholeNumber(request.value, 'value');
    },
    'match.next': () => advanceGameMatch(game, gameKey),
    'scores.reset': () => resetAllScores(game, gameKey),
    'match.live.toggle': () => { game.match.live = !game.match.live; },
    'match.live.set': () => {
      if (typeof request.value !== 'boolean') throw actionError('value must be true or false');
      game.match.live = request.value;
    },
    'teams.swap': () => swapGameTeams(game),
    'map.activate': () => {
      const index = wholeNumber(request.number, 'number', { min: 1, max: visibleMapRows(game).length }) - 1;
      game.activeMap = index;
      game.mapRows.forEach((row, rowIndex) => { if (row.winner === null) row.status = rowIndex === index ? 'ready' : 'upcoming'; });
    },
    'map.winner.set': () => {
      const index = wholeNumber(request.number, 'number', { min: 1, max: visibleMapRows(game).length }) - 1;
      const winner = request.team === null || request.team === '' || request.team === 'clear' ? null : teamIndex(request.team);
      game.mapRows[index].winner = winner;
      game.mapRows[index].status = winner === null ? (index === game.activeMap ? 'ready' : 'upcoming') : 'complete';
      game.teams.forEach((team, currentTeamIndex) => { team.score = visibleMapRows(game).filter((row) => row.winner === currentTeamIndex).length; });
    },
    'maps.reset': () => {
      resetMapResults(game, gameKey);
    },
    'veto.reset': () => {
      if (gameKey !== 'valorant') throw actionError('veto.reset is only available for VALORANT');
      game.veto.bans = game.veto.bans.map(() => '');
      game.veto.picks = game.veto.picks.map((pick) => ({ ...pick, map: '', score: ['', ''], winner: null }));
      game.mapRows.forEach((row, index) => {
        row.map = '';
        row.score = ['', ''];
        row.overtime = false;
        row.overtimeSeconds = 0;
        row.winner = null;
        row.status = index === 0 ? 'ready' : 'upcoming';
      });
      game.teams.forEach((team) => { team.score = 0; });
      game.activeMap = 0;
    }
  };
  if (!mutators[action]) throw actionError(`Unknown action: ${action}`, 404);
  mutators[action]();
  return { message: `${action} applied to ${config.name}`, selectedGameChanged: false };
}
