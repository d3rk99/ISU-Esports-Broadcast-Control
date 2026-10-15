import assert from 'node:assert/strict';
import test from 'node:test';
import { decideBlocks, mapBoardToTeams, attackingTeamNow, currentRound } from '../src/valorant-board-teams.js';
import { spectateCandidatesFrom, spectateSidesFrom } from '../electron/spectate-state.cjs';
import { renderValorantBoardPanel } from '../src/valorant-board-panel.js';

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

test('YouTube round 20: map-first attackers + manual round resolve ISU to the teal bottom block despite duplicate rosters', () => {
  const g = game({ rosters: { varsity: [{ handle: 'Sn0wfal', stageStation: 1 }, { handle: 'newx' }], jv: [] },
    awayRosters: { varsity: [{ handle: 'Sn0wfal' }, { handle: 'newx' }], jv: [] },
    valorantRoundOverride: { 0: 20 } });
  const raw = board(['TUgarrett', 'kny milo', 'TU koiva', 'TU 1mBor3d', 'spectre'], ['catboyexperiment', 'malo', 'Sn0wfal', 'newx', 'Austin074574'], { home: 'red', away: 'teal' });
  raw.teams.home.players[4].agent = 'fade'; raw.teams.away.players[2].agent = 'fade';
  raw.teams.away.players[3].agent = 'cypher';
  raw.match = { homeScore: null, awayScore: 10 };
  const mapped = mapBoardToTeams(g, raw);
  assert.equal(currentRound(g), 20);
  assert.equal(attackingTeamNow(g), 'away');
  assert.equal(mapped.decision.top, 'away');
  assert.equal(mapped.decision.by, 'sides', 'duplicated names cannot decide team identity');
  g.valorantBoard = { live: mapped.board };
  const state = { selectedGame: 'valorant', games: { valorant: g } };
  assert.deepEqual(spectateSidesFrom(state), { round: 20, red: 'away', teal: 'home' });
  const candidates = spectateCandidatesFrom(state);
  assert.equal(candidates.filter((p) => p.name === 'Sn0wfal').length, 1, 'duplicate rosters cannot steal a portrait');
  assert.equal(candidates.find((p) => p.name === 'Sn0wfal').side, 'home');
  assert.equal(candidates.find((p) => p.name === 'Sn0wfal').station, 1);
  assert.equal(candidates.find((p) => p.name === 'spectre').side, 'away');
  g.valorantBoard.live.teams.home.players[2].name = 'SnQwfal';
  const fuzzyCandidates = spectateCandidatesFrom(state).filter((p) => p.agent === 'fade');
  assert.equal(fuzzyCandidates.filter((p) => p.side === 'home').length, 1);
  assert.equal(fuzzyCandidates.find((p) => p.side === 'home').name, 'Sn0wfal', 'keep the roster spelling when OCR misreads a letter');
  const panel = renderValorantBoardPanel({ live: raw, decision: mapped.decision }, g.teams, {}, [], '', g);
  assert.match(panel, /ROUND <b>20<\/b> · MANUAL OVERRIDE/);
  assert.match(panel, /ROSTER CONFLICT/);
  assert.match(panel, /LCU ATTACKING \(RED\).*IDAHO STATE DEFENDING \(TEAL\)/);
});

test('round context is consistent between reader and bridge, ignoring a stale timeline and applying per-map overrides', () => {
  const g = game(); const state = { selectedGame: 'valorant', games: { valorant: g } };
  g.valorantOcr = { live: { observer3: { roundTimeline: { currentRound: 1 } } } };
  for (const [round, attacking] of [[12, 'home'], [13, 'away'], [20, 'away'], [24, 'away'], [25, 'home'], [26, 'away'], [27, 'home']]) {
    g.valorantRoundOverride = { 0: round };
    assert.equal(currentRound(g), round);
    assert.equal(attackingTeamNow(g), attacking);
    assert.equal(spectateSidesFrom(state).red, attacking);
    assert.equal(spectateSidesFrom(state).round, round);
  }
  g.valorantRoundOverride = {};
  g.teams[0].detailScore = 10; g.teams[1].detailScore = 9;
  assert.equal(currentRound(g), 20);
  assert.equal(spectateSidesFrom(state).round, 20);
  g.valorantBoard = { live: { match: { homeScore: 11, awayScore: 9 } } };
  assert.equal(currentRound(g), 21, 'confirmed reader score gives the round without rewriting graphic scores');
  assert.equal(spectateSidesFrom(state).round, 21);
  g.valorantRoundOverride = { 0: 20 }; g.activeMap = 1;
  assert.equal(currentRound(g), 21, 'another map does not inherit the replay override');
});
