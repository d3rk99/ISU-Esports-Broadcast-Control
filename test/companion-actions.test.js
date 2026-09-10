import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCompanionAction } from '../src/companion-actions.js';
import { createInitialState } from '../src/game-config.js';

test('Companion score and next-match actions update the selected game', () => {
  const state = createInitialState();
  applyCompanionAction(state, { action: 'score.increment', team: 'home' });
  applyCompanionAction(state, { action: 'detail_score.set', team: 'away', value: 12 });
  assert.equal(state.games.overwatch.teams[0].score, 1);
  assert.equal(state.games.overwatch.teams[1].detailScore, 12);
  applyCompanionAction(state, { action: 'match.next' });
  assert.equal(state.games.overwatch.activeMap, 1);
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

test('map winner and reset actions keep series score in sync', () => {
  const state = createInitialState();
  applyCompanionAction(state, { action: 'map.winner.set', number: 1, team: 'home' });
  assert.equal(state.games.overwatch.mapRows[0].winner, 0);
  assert.equal(state.games.overwatch.teams[0].score, 1);
  applyCompanionAction(state, { action: 'maps.reset' });
  assert.equal(state.games.overwatch.mapRows[0].winner, null);
  assert.equal(state.games.overwatch.teams[0].score, 0);
});

test('invalid Companion actions fail without valid-looking results', () => {
  const state = createInitialState();
  assert.throws(() => applyCompanionAction(state, { action: 'score.increment', team: 'visitor' }), /home or away/);
  assert.throws(() => applyCompanionAction(state, { action: 'veto.reset' }), /only available for VALORANT/);
  assert.throws(() => applyCompanionAction(state, { action: 'does.not.exist' }), /Unknown action/);
});
