import { GAME_CONFIGS } from './game-config.js';

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

export function advanceGameMatch(game) {
  const nextIndex = (game.activeMap + 1) % game.mapRows.length;
  game.activeMap = nextIndex;
  game.teams.forEach((team) => { team.detailScore = 0; });
  game.mapRows.forEach((row, rowIndex) => {
    row.status = row.winner !== null ? 'complete' : (rowIndex === nextIndex ? 'ready' : 'upcoming');
  });
  return nextIndex;
}

export function applyCompanionAction(state, request = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw actionError('Action request must be a JSON object');
  const action = String(request.action || '');
  if (!action) throw actionError('action is required');
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
      game.teams[index].score = Math.min(config.maxScore, (Number(game.teams[index].score) || 0) + amount);
    },
    'score.decrement': () => {
      const index = teamIndex(request.team);
      const amount = wholeNumber(request.amount, 'amount', { min: 1, fallback: 1 });
      game.teams[index].score = Math.max(0, (Number(game.teams[index].score) || 0) - amount);
    },
    'score.set': () => {
      const index = teamIndex(request.team);
      game.teams[index].score = wholeNumber(request.value, 'value', { max: config.maxScore });
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
    'match.next': () => advanceGameMatch(game),
    'scores.reset': () => game.teams.forEach((team) => { team.score = 0; team.detailScore = 0; }),
    'match.live.toggle': () => { game.match.live = !game.match.live; },
    'match.live.set': () => {
      if (typeof request.value !== 'boolean') throw actionError('value must be true or false');
      game.match.live = request.value;
    },
    'teams.swap': () => swapGameTeams(game),
    'map.activate': () => {
      const index = wholeNumber(request.number, 'number', { min: 1, max: game.mapRows.length }) - 1;
      game.activeMap = index;
      game.mapRows.forEach((row, rowIndex) => { if (row.winner === null) row.status = rowIndex === index ? 'ready' : 'upcoming'; });
    },
    'map.winner.set': () => {
      const index = wholeNumber(request.number, 'number', { min: 1, max: game.mapRows.length }) - 1;
      const winner = request.team === null || request.team === '' || request.team === 'clear' ? null : teamIndex(request.team);
      game.mapRows[index].winner = winner;
      game.mapRows[index].status = winner === null ? (index === game.activeMap ? 'ready' : 'upcoming') : 'complete';
      game.teams.forEach((team, currentTeamIndex) => { team.score = game.mapRows.filter((row) => row.winner === currentTeamIndex).length; });
    },
    'maps.reset': () => {
      game.mapRows.forEach((row, index) => { row.winner = null; row.score = ['', '']; row.status = index === 0 ? 'ready' : 'upcoming'; });
      game.teams.forEach((team) => { team.score = 0; });
      game.activeMap = 0;
    },
    'veto.reset': () => {
      if (gameKey !== 'valorant') throw actionError('veto.reset is only available for VALORANT');
      game.veto.bans = game.veto.bans.map(() => '');
      game.veto.picks = game.veto.picks.map((pick) => ({ ...pick, map: '', score: ['', ''], winner: null }));
    }
  };
  if (!mutators[action]) throw actionError(`Unknown action: ${action}`, 404);
  mutators[action]();
  return { message: `${action} applied to ${config.name}`, selectedGameChanged: false };
}
