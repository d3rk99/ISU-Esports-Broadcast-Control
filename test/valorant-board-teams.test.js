import assert from 'node:assert/strict';
import test from 'node:test';
import { decideBlocks, mapBoardToTeams, attackingTeamNow } from '../src/valorant-board-teams.js';

const row = (name) => ({ name, kills: 1, deaths: 1 });
const board = (top, bottom, colors = {}) => ({ teams: { home: { players: top.map(row) }, away: { players: bottom.map(row) } }, colors });
const isu = ['Sn0wfal', 'BaldReaper', 'newx', 'Eagl3', 'Ishnarb'];
const lcu = ['santi', 'LCU glowstick', 'LCU nyv', 'CWTJ', 'LCU Mexican Sova'];
const game = (extra = {}) => ({ teams: [{ name: 'IDAHO STATE', detailScore: 0 }, { name: 'LCU', detailScore: 0 }], activeMap: 0,
  rosters: { varsity: isu.map((handle) => ({ handle })), jv: [] }, awayRosters: { varsity: [], jv: [] }, veto: { picks: [{ map: 'Ascent', attackers: 0 }] }, ...extra });

test('VALORANT board -> teams: ISU roster names in the BOTTOM block put ISU (home) on the bottom (Derk 2026-10-15)', () => {
  const g = game();
  const d = decideBlocks(g, board(lcu, isu));
  assert.equal(d.top, 'away'); assert.equal(d.by, 'names');
  const { board: mapped } = mapBoardToTeams(g, board(lcu, isu));
  assert.deepEqual(mapped.teams.home.players.map((p) => p.name), isu, 'home = ISU players, whatever block');
  assert.equal(mapped.teams.home.players[0].block, 'bottom');
  assert.deepEqual(mapped.blocks, { top: 'away', bottom: 'home' });
});

test('VALORANT board -> teams: names misread a little still decide (80% similar)', () => {
  const d = decideBlocks(game(), board(['santi', 'x', 'y', 'z', 'w'], ['Sn0wfa1', 'BaldReapr', 'newx', 'Eag13', 'Ishnarb']));
  assert.equal(d.top, 'away'); assert.equal(d.by, 'names');
});

test('VALORANT board -> teams: no names yet -> map pool attacking side + red (attackers) block decide', () => {
  // ISU (home, team 0) attacks first on this map; the board shows the TOP block red -> top = ISU
  const empty = ['', '', '', '', ''];
  assert.equal(decideBlocks(game(), board(empty, empty, { home: 'red', away: 'teal' })).top, 'home');
  // LCU attacks first (attackers: 1): red top block = LCU
  assert.equal(decideBlocks(game({ veto: { picks: [{ map: 'Ascent', attackers: 1 }] } }), board(empty, empty, { home: 'red', away: 'teal' })).top, 'away');
  // second half (round 13+): sides swapped, ISU defends -> red top block = LCU
  const half2 = game({ teams: [{ detailScore: 7 }, { detailScore: 5 }] });
  assert.equal(attackingTeamNow(half2), 'away');
  assert.equal(decideBlocks(half2, board(empty, empty, { home: 'red', away: 'teal' })).top, 'away');
});

test('VALORANT board -> teams: nothing to go on keeps the last decision', () => {
  const empty = ['', '', '', '', ''];
  assert.equal(decideBlocks(game({ veto: { picks: [] } }), board(empty, empty), { top: 'away' }).top, 'away');
});
