import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCompanionAction } from '../src/companion-actions.js';
import { createInitialState } from '../src/game-config.js';

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

test('invalid Companion actions fail without valid-looking results', () => {
  const state = createInitialState();
  assert.throws(() => applyCompanionAction(state, { action: 'score.increment', team: 'visitor' }), /home or away/);
  assert.throws(() => applyCompanionAction(state, { action: 'veto.reset' }), /only available for VALORANT/);
  assert.throws(() => applyCompanionAction(state, { action: 'does.not.exist' }), /Unknown action/);
});
