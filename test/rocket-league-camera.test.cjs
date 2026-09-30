const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCompanionVariables } = require('../electron/companion-api-service.cjs');

test('team camera slots sort by shortcut, follow team mapping, and clear safely', () => {
  const game = { rocketLeague: { blueTeam: 0, live: { status: 'connected', players: [
    { name: 'Blue 2', teamNum: 0, shortcut: 2 },
    { name: 'Orange 1', teamNum: 1, shortcut: 4, spectated: true },
    { name: 'Blue 1', teamNum: 0, shortcut: 1 }
  ] } } };
  const state = { selectedGame: 'rocketleague', games: { rocketleague: game } };
  let values = buildCompanionVariables(state);
  assert.equal(values.rl_home_player_1_name, 'Blue 1');
  assert.equal(values.rl_home_player_3_name, '');
  assert.equal(values.rl_spectated_slot, 'away_1');
  game.rocketLeague.blueTeam = 1;
  values = buildCompanionVariables(state);
  assert.equal(values.rl_home_player_1_name, 'Orange 1');
  assert.equal(values.rl_spectated_slot, 'home_1');
  for (const change of [{ replay: true }, { replay: false, status: 'waiting' }, { status: 'connected', dataAgeMs: 3000 }]) {
    Object.assign(game.rocketLeague.live, change);
    assert.equal(buildCompanionVariables(state).rl_spectated_slot, '');
    assert.equal(buildCompanionVariables(state).rl_home_player_1_spectated, false);
  }
  state.selectedGame = 'valorant';
  values = buildCompanionVariables(state);
  assert.equal(values.rl_home_player_1_name, '');
  assert.equal(values.rl_spectated_slot, '');
});
