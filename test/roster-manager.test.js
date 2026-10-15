import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeam, bulkAdd, parseBulk, loadTeamIntoMatch, isuSide, setForPlayers, liveLinks, writeBackFromMatch } from '../src/roster-manager.js';
import { tagSimilarity } from '../src/overwatch-ocr-panel.js';
import { createGameState, createPlayer, GAME_CONFIGS } from '../src/game-config.js';

const config = GAME_CONFIGS.valorant;
const emptyPlayer = (i) => createPlayer(config, i);

test('Roster Manager: bulk paste reads gamertag, name, status, program', () => {
  const rows = parseBulk('Sn0wfal, Sam Snow, starter\nBaldReaper\tBob Reap\t6th\nnewx;;sub;jv\nCoachK, Kim Coach, coach\n\n');
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], { handle: 'Sn0wfal', name: 'Sam Snow', status: 'starter' });
  assert.equal(rows[1].status, 'sixth'); assert.equal(rows[2].program, 'jv'); assert.equal(rows[3].status, 'coach');
});

test('Roster Manager: loading a team fills the match roster (starters first), coaches apart, team identity, ISU side', () => {
  const game = createGameState('valorant');
  const isu = createTeam(game, { name: 'IDAHO STATE', shortName: 'ISU', isISU: true });
  bulkAdd(isu, 'Sub1,,sub\nSn0wfal,,starter\nCoachK,,coach\nSixth,,6th\nA,,starter\nB,,starter\nC,,starter\nD,,starter\nJv1,,starter,jv');
  const opp = createTeam(game, { name: 'LCU', shortName: 'LCU' });
  bulkAdd(opp, 'santi,,starter\nLCU nyv,,starter');
  assert.ok(loadTeamIntoMatch(game, 'away', isu.id, { emptyPlayer }));
  assert.ok(loadTeamIntoMatch(game, 'home', opp.id, { emptyPlayer }));
  const v = game.awayRosters.varsity.map((p) => p.handle);
  assert.deepEqual(v.slice(0, 7), ['Sn0wfal', 'A', 'B', 'C', 'D', 'Sixth', 'Sub1']);
  assert.ok(!v.includes('CoachK'), 'coaches are not player slots');
  assert.deepEqual(game.coaches.away.map((c) => c.handle), ['CoachK']);
  assert.equal(game.awayRosters.jv[0].handle, 'Jv1');
  assert.equal(game.teams[1].name, 'IDAHO STATE'); assert.equal(game.teams[0].shortName, 'LCU');
  assert.equal(isuSide(game), 'away', 'ISU is the team marked ISU, wherever it is loaded');
  assert.equal(game.showAwayRoster, true);
});

test('Roster Manager: reloading keeps live fields (agent) by gamertag; bulk status change; write-back', () => {
  const game = createGameState('valorant');
  const t = createTeam(game, { name: 'IDAHO STATE', isISU: true });
  bulkAdd(t, 'Sn0wfal,,starter\nnewx,,sub');
  loadTeamIntoMatch(game, 'home', t.id, { emptyPlayer });
  game.rosters.varsity[0].character = 'Viper';
  game.rosters.varsity[0].stageStation = '3';
  assert.equal(writeBackFromMatch(game, 'home') >= 1, true);
  assert.equal(t.players[0].stageStation, '3');
  setForPlayers(t, [t.players[1].id], 'status', 'starter');
  loadTeamIntoMatch(game, 'home', t.id, { emptyPlayer });
  assert.equal(game.rosters.varsity[0].character, 'Viper', 'agent kept');
  assert.equal(game.rosters.varsity[1].libraryStatus, 'starter');
});

test('Roster Manager: live link to the scoreboard reader with % confidence', () => {
  const links = liveLinks([{ handle: 'Sn0wfal' }, { handle: 'BaldReaper' }, { handle: 'Nobody' }], [{ name: 'Sn0wfa1', row: 2, block: 'bottom' }, { name: 'BaldReaper', row: 0 }], tagSimilarity);
  assert.equal(links.get(1).score, 1); assert.equal(links.get(1).linked, true);
  assert.ok(links.get(0).score > 0.8 && links.get(0).row === 2);
  assert.equal(links.has(2), false);
});
