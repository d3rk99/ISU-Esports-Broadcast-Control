import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCompanionAction } from '../src/companion-actions.js';
import { createInitialState } from '../src/game-config.js';
import { SpectateTracker } from '../electron/spectate-tracker.cjs';
import { mapBoardToTeams } from '../src/valorant-board-teams.js';
import { spectateCandidatesFrom, spectateSidesFrom, resolveSpectated } from '../electron/spectate-state.cjs';

test('Valorant swap keeps reader agents and board blocks with their players immediately', () => {
  const state = createInitialState(); state.selectedGame = 'valorant';
  const game = state.games.valorant;
  game.rosters.varsity = [{ handle: 'Alpha', stageStation: 1 }];
  game.awayRosters.varsity = [{ handle: 'Bravo', stageStation: 6 }];
  game.valorantBoard = { live: { teams: {
    home: { players: [{ name: 'Alpha', agent: 'sova', block: 'bottom' }] },
    away: { players: [{ name: 'Bravo', agent: 'jett', block: 'top' }] }
  }, blocks: { top: 'away', bottom: 'home' }, colors: { home: 'red', away: 'teal' } } };
  const before = structuredClone(game.valorantBoard.live);
  const watched = { name: 'Alpha', game: 'valorant', side: 'home', team: game.teams[0].name, station: 1, receivedAt: 1000 };
  assert.equal(spectateSidesFrom(state).teal, 'home');
  applyCompanionAction(state, { action: 'teams.swap' });
  assert.equal(game.valorantBoard.live.teams.away.players[0].name, 'Alpha');
  assert.equal(game.valorantBoard.live.teams.home.players[0].agent, 'jett');
  assert.deepEqual(game.valorantBoard.live.blocks, { top: 'home', bottom: 'away' });
  assert.deepEqual(game.valorantBoard.live.colors, before.colors, 'physical block colours do not move');
  const candidates = spectateCandidatesFrom(state);
  assert.deepEqual(candidates.map((c) => [c.name, c.agent, c.side]), [['Bravo', 'jett', 'home'], ['Alpha', 'sova', 'away']]);
  assert.equal(spectateSidesFrom(state).teal, 'away');
  assert.equal(spectateSidesFrom(state).red, 'home');
  const resolved = resolveSpectated(state, watched);
  assert.equal(resolved.side, 'away', 'graphics remap the last bridge packet immediately');
  assert.equal(resolved.station, 1);
  assert.equal(resolved.team, watched.team);
  assert.equal(resolved.receivedAt, 1000, 'remapping does not extend stale reads');
  const emptyBoard = { teams: { home: { players: [] }, away: { players: [] } } };
  game.veto.picks = [];
  assert.equal(mapBoardToTeams(game, emptyBoard, { top: game.valorantBoard.live.blocks.top }).decision.top, 'home');
  applyCompanionAction(state, { action: 'teams.swap' });
  assert.deepEqual(game.valorantBoard.live, before, 'double swap restores the reader state');
});

test('portrait tracking keeps the same camera player across a swap with mirrored agents', () => {
  const state = createInitialState(); state.selectedGame = 'valorant';
  const game = state.games.valorant;
  game.rosters.varsity = [{ handle: 'Alpha' }]; game.awayRosters.varsity = [{ handle: 'Bravo' }];
  game.valorantBoard = { live: { teams: {
    home: { players: [{ name: 'Alpha', agent: 'sova' }] }, away: { players: [{ name: 'Bravo', agent: 'sova' }] }
  }, blocks: { top: 'away', bottom: 'home' }, colors: { home: 'red', away: 'teal' } } };
  const tracker = new SpectateTracker({ agents: {}, now: () => 1000 });
  tracker.portraits = { match: () => ({ agent: 'sova', color: 'teal', score: 1 }) };
  const frame = () => [0, 0, 0]; const box = { x: 0, y: 0, w: 10, h: 10 };
  for (let swap = 0; swap < 3; swap++) {
    tracker.setCandidates(spectateCandidatesFrom(state)); tracker.setSides(spectateSidesFrom(state));
    tracker.portraitStep(frame, box);
    const result = tracker.portraitStep(frame, box);
    assert.equal(result.spectated.name, 'Alpha', 'teal Sova always belongs to Alpha');
    assert.equal(result.spectated.side, swap % 2 ? 'away' : 'home');
    applyCompanionAction(state, { action: 'teams.swap' });
  }
});

test('spectate colour fallback follows map attacking side through halftime and overtime', () => {
  const state = createInitialState(); state.selectedGame = 'valorant';
  const game = state.games.valorant; game.veto.picks[0].attackers = 0;
  for (const [round, red] of [[1, 'home'], [13, 'away'], [25, 'home'], [26, 'away']]) {
    game.teams[0].detailScore = round - 1;
    assert.equal(spectateSidesFrom(state).red, red);
  }
  applyCompanionAction(state, { action: 'teams.swap' });
  assert.equal(spectateSidesFrom(state).red, 'home', 'map-side fallback follows the swapped team');
  assert.equal(resolveSpectated(state, { name: 'Alpha', game: 'overwatch' }).name, '', 'old game packet is hidden');
});

test('spectate tracker refreshes the same watched player after a roster-side swap', () => {
  const tracker = new SpectateTracker({ now: () => 1000 });
  tracker.setCandidates([{ name: 'Alpha', side: 'home', team: 'ISU', station: 1, agent: 'sova' }]);
  for (let i = 0; i < 3; i++) tracker.report({ name: 'Alpha', score: 1 });
  tracker.setCandidates([{ name: 'Alpha', side: 'away', team: 'ISU', station: 1, agent: 'sova' }]);
  const result = tracker.report({ name: 'Alpha', score: 1 });
  assert.equal(result.spectated.side, 'away');
  assert.equal(result.spectated.team, 'ISU');
  assert.equal(result.changed, true, 'metadata changes are sent without a camera switch');
});

test('Companion score and next-match actions update the selected game', () => {
  const state = createInitialState();
  applyCompanionAction(state, { action: 'score.increment', team: 'home' });
  applyCompanionAction(state, { action: 'detail_score.set', team: 'away', value: 12 });
  applyCompanionAction(state, { action: 'detail_score.set', team: 'home', value: 9 });
  assert.equal(state.games.overwatch.teams[0].score, 1);
  assert.equal(state.games.overwatch.teams[1].detailScore, 12);
  applyCompanionAction(state, { action: 'match.next' });
  assert.equal(state.games.overwatch.activeMap, 1);
  assert.deepEqual(state.games.overwatch.mapRows[0].score, ['9', '12']);
  assert.equal(state.games.overwatch.mapRows[0].winner, 1);
  assert.equal(state.games.overwatch.mapRows[0].status, 'complete');
  assert.equal(state.games.overwatch.teams[1].detailScore, 0);
});

test('Companion can target a non-selected game and select another game', () => {
  const state = createInitialState();
  applyCompanionAction(state, { action: 'score.set', team: 'away', value: 3, game: 'rocketleague' });
  assert.equal(state.selectedGame, 'overwatch');
  assert.equal(state.games.rocketleague.teams[1].score, 3);
  const result = applyCompanionAction(state, { action: 'game.select', game: 'rocketleague' });
  assert.equal(state.selectedGame, 'rocketleague');
  assert.equal(result.selectedGameChanged, true);
});

test('Companion can select the active program output', () => {
  const state = createInitialState();
  const result = applyCompanionAction(state, { action: 'output.select', output: 'roster' });
  assert.equal(state.activeOutputOverlay, 'roster');
  assert.equal(result.outputChanged, true);
  applyCompanionAction(state, { action: 'output.select', output: 'clean' });
  assert.equal(state.activeOutputOverlay, 'clean');
  assert.throws(() => applyCompanionAction(state, { action: 'output.select', output: 'lower-third' }), /scoreboard, roster, map-pool, or clean/);
});

test('team swap preserves the selected first roster team', () => {
  const state = createInitialState();
  const game = state.games.overwatch;
  game.rosters.varsity[0].handle = 'ISU PLAYER';
  game.awayRosters.varsity[0].handle = 'OPP PLAYER';
  assert.equal(game.rosterFirstSide, 'home');

  applyCompanionAction(state, { action: 'teams.swap' });

  assert.equal(game.teams[1].shortName, 'ISU');
  assert.equal(game.rosterFirstSide, 'away');
  assert.equal(game.awayRosters.varsity[0].handle, 'ISU PLAYER');
});

test('Valorant team swap preserves left and right side scores', () => {
  const state = createInitialState();
  state.selectedGame = 'valorant';
  const game = state.games.valorant;
  game.teams[0].detailScore = 8;
  game.teams[1].detailScore = 4;
  game.teams[0].score = 1;
  game.teams[1].score = 0;
  const originalHomeName = game.teams[0].name;
  const originalAwayName = game.teams[1].name;

  applyCompanionAction(state, { action: 'teams.swap' });

  assert.equal(game.teams[0].name, originalAwayName);
  assert.equal(game.teams[1].name, originalHomeName);
  assert.equal(game.teams[0].detailScore, 8);
  assert.equal(game.teams[1].detailScore, 4);
  assert.equal(game.teams[0].score, 1);
  assert.equal(game.teams[1].score, 0);
});

test('map winner and reset actions keep series score in sync', () => {
  const state = createInitialState();
  applyCompanionAction(state, { action: 'map.winner.set', number: 1, team: 'home' });
  assert.equal(state.games.overwatch.mapRows[0].winner, 0);
  assert.equal(state.games.overwatch.teams[0].score, 1);
  state.games.overwatch.mapRows[0].map = 'Busan';
  state.games.overwatch.mapRows[0].mode = 'Control';
  applyCompanionAction(state, { action: 'maps.reset' });
  assert.equal(state.games.overwatch.mapRows[0].winner, null);
  assert.equal(state.games.overwatch.mapRows[0].map, '');
  assert.equal(state.games.overwatch.mapRows[0].mode, '');
  assert.equal(state.games.overwatch.teams[0].score, 0);
});

test('format length controls target score and visible map actions', () => {
  const state = createInitialState();
  state.selectedGame = 'valorant';
  state.games.valorant.seriesLength = 7;
  state.games.valorant.match.format = 'Best of 7';
  applyCompanionAction(state, { action: 'score.set', team: 'home', value: 9 });
  assert.equal(state.games.valorant.teams[0].score, 4);
  assert.equal(state.games.valorant.mapRows.length, 3);
  applyCompanionAction(state, { action: 'map.winner.set', number: 3, team: 'away' });
  assert.equal(state.games.valorant.mapRows[2].winner, 1);
  assert.equal(state.games.valorant.teams[1].score, 1);
});

test('Valorant score reset clears map results without clearing veto selections', () => {
  const state = createInitialState();
  state.selectedGame = 'valorant';
  const game = state.games.valorant;
  game.veto.bans = ['Bind', 'Haven', 'Lotus', 'Pearl'];
  game.veto.picks[0].map = 'Ascent';
  game.veto.picks[0].score = ['13', '9'];
  game.veto.picks[0].winner = 0;
  game.mapRows[0].map = 'Ascent';
  game.mapRows[0].score = ['13', '9'];
  game.mapRows[0].winner = 0;
  game.mapRows[0].status = 'complete';
  game.teams[0].score = 1;
  applyCompanionAction(state, { action: 'scores.reset' });
  assert.deepEqual(game.veto.bans, ['Bind', 'Haven', 'Lotus', 'Pearl']);
  assert.equal(game.veto.picks[0].map, 'Ascent');
  assert.deepEqual(game.veto.picks[0].score, ['', '']);
  assert.equal(game.veto.picks[0].winner, null);
  assert.equal(game.mapRows[0].map, 'Ascent');
  assert.deepEqual(game.mapRows[0].score, ['', '']);
  assert.equal(game.mapRows[0].winner, null);
  assert.equal(game.mapRows[0].status, 'ready');
  assert.equal(game.teams[0].score, 0);
});

test('Valorant next-match saves live round score and resets the current score', () => {
  const state = createInitialState();
  state.selectedGame = 'valorant';
  const game = state.games.valorant;
  applyCompanionAction(state, { action: 'detail_score.set', team: 'home', value: 13 });
  applyCompanionAction(state, { action: 'detail_score.set', team: 'away', value: 11 });
  applyCompanionAction(state, { action: 'match.next' });
  assert.deepEqual(game.mapRows[0].score, ['13', '11']);
  assert.equal(game.mapRows[0].winner, 0);
  assert.equal(game.teams[0].score, 1);
  assert.equal(game.teams[0].detailScore, 0);
  assert.equal(game.teams[1].detailScore, 0);
  assert.equal(game.activeMap, 1);
});

test('next-match leaves tied map scores without an automatic winner', () => {
  const state = createInitialState();
  applyCompanionAction(state, { action: 'detail_score.set', team: 'home', value: 7 });
  applyCompanionAction(state, { action: 'detail_score.set', team: 'away', value: 7 });
  applyCompanionAction(state, { action: 'match.next' });
  assert.deepEqual(state.games.overwatch.mapRows[0].score, ['7', '7']);
  assert.equal(state.games.overwatch.mapRows[0].winner, null);
  assert.equal(state.games.overwatch.mapRows[0].status, 'upcoming');
});

test('Smash score reset and next-match restore stocks to 12', () => {
  const state = createInitialState();
  state.selectedGame = 'smash';
  assert.equal(state.games.smash.teams[0].detailScore, 12);
  assert.equal(state.games.smash.teams[1].detailScore, 12);
  applyCompanionAction(state, { action: 'detail_score.set', team: 'home', value: 0 });
  applyCompanionAction(state, { action: 'detail_score.set', team: 'away', value: 5 });
  applyCompanionAction(state, { action: 'match.next' });
  assert.deepEqual(state.games.smash.mapRows[0].score, ['0', '5']);
  assert.equal(state.games.smash.mapRows[0].winner, 1);
  assert.equal(state.games.smash.teams[0].detailScore, 12);
  assert.equal(state.games.smash.teams[1].detailScore, 12);
  applyCompanionAction(state, { action: 'detail_score.set', team: 'home', value: 3 });
  applyCompanionAction(state, { action: 'score.set', team: 'away', value: 2 });
  applyCompanionAction(state, { action: 'scores.reset' });
  assert.equal(state.games.smash.teams[1].score, 0);
  assert.equal(state.games.smash.teams[0].detailScore, 12);
  assert.equal(state.games.smash.teams[1].detailScore, 12);
});

test('Rocket League next-match saves the live arena to map pool', () => {
  const state = createInitialState();
  state.selectedGame = 'rocketleague';
  state.games.rocketleague.rocketLeague.live.arena = 'cs_day_p';
  state.games.rocketleague.rocketLeague.live.overtime = true;
  state.games.rocketleague.rocketLeague.live.overtimeSeconds = 73;
  applyCompanionAction(state, { action: 'detail_score.set', team: 'home', value: 4 });
  applyCompanionAction(state, { action: 'detail_score.set', team: 'away', value: 2 });
  applyCompanionAction(state, { action: 'match.next' });
  assert.equal(state.games.rocketleague.mapRows[0].map, 'Deadeye Canyon');
  assert.deepEqual(state.games.rocketleague.mapRows[0].score, ['4', '2']);
  assert.equal(state.games.rocketleague.mapRows[0].winner, 0);
  assert.equal(state.games.rocketleague.mapRows[0].overtime, true);
  assert.equal(state.games.rocketleague.mapRows[0].overtimeSeconds, 73);
});

test('Rocket League score reset clears saved game winners', () => {
  const state = createInitialState();
  state.selectedGame = 'rocketleague';
  const game = state.games.rocketleague;
  game.mapRows[0].winner = 1;
  game.mapRows[0].score = ['1', '2'];
  game.mapRows[0].status = 'complete';
  game.teams[1].score = 1;
  applyCompanionAction(state, { action: 'scores.reset' });
  assert.equal(game.teams[0].score, 0);
  assert.equal(game.teams[1].score, 0);
  assert.equal(game.mapRows[0].winner, null);
  assert.deepEqual(game.mapRows[0].score, ['', '']);
  assert.equal(game.mapRows[0].status, 'ready');
});

test('invalid Companion actions fail without valid-looking results', () => {
  const state = createInitialState();
  assert.throws(() => applyCompanionAction(state, { action: 'score.increment', team: 'visitor' }), /home or away/);
  assert.throws(() => applyCompanionAction(state, { action: 'veto.reset' }), /only available for VALORANT/);
  assert.throws(() => applyCompanionAction(state, { action: 'does.not.exist' }), /Unknown action/);
});

test('Companion statcards.set shows, hides and toggles the player stat cards for VALORANT and Overwatch (Derk 2026-10-14)', () => {
  const state = createInitialState();
  // defaults: VALORANT cards on (they always showed), Overwatch cards off (experimental)
  assert.equal(state.games.valorant.valorantShowStatCards, true);
  assert.equal(state.games.overwatch.overwatchShowStatCards, false);
  applyCompanionAction(state, { action: 'statcards.set', value: 'hide', game: 'valorant' });
  assert.equal(state.games.valorant.valorantShowStatCards, false);
  applyCompanionAction(state, { action: 'statcards.set', value: 'toggle', game: 'valorant' });
  assert.equal(state.games.valorant.valorantShowStatCards, true);
  applyCompanionAction(state, { action: 'statcards.set', value: 'show', game: 'overwatch' });
  assert.equal(state.games.overwatch.overwatchShowStatCards, true);
  // no game given = the selected game
  state.selectedGame = 'overwatch';
  applyCompanionAction(state, { action: 'statcards.set', value: 'toggle' });
  assert.equal(state.games.overwatch.overwatchShowStatCards, false);
  // old saves without the VALORANT flag count as shown, so toggle hides
  delete state.games.valorant.valorantShowStatCards;
  applyCompanionAction(state, { action: 'statcards.set', value: 'toggle', game: 'valorant' });
  assert.equal(state.games.valorant.valorantShowStatCards, false);
  assert.throws(() => applyCompanionAction(state, { action: 'statcards.set', value: 'show', game: 'rocketleague' }), /valorant or overwatch/);
  assert.throws(() => applyCompanionAction(state, { action: 'statcards.set', value: 'blink', game: 'valorant' }), /show, hide or toggle/);
});
