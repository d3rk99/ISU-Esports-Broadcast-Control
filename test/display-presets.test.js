import test from 'node:test';
import assert from 'node:assert/strict';
import { DISPLAY_PRESETS, applyDisplayPreset, ensureDisplayState } from '../src/display-presets.js';
import { applyCompanionAction, saveLastGameStats, advanceGameMatch } from '../src/companion-actions.js';
import { createInitialState } from '../src/game-config.js';
import { loadState } from '../src/store.js';

test('display presets: defaults, per station, all, team override, bad input', () => {
  const state = createInitialState();
  assert.equal(state.displays.stations[1].preset, 'idle');
  assert.deepEqual(DISPLAY_PRESETS.map((p) => p.id), ['idle', 'intro', 'player', 'banner', 'score', 'black']);
  applyDisplayPreset(state, 4, 'player');
  assert.deepEqual(state.displays.stations[4], { preset: 'player', team: '' });
  applyDisplayPreset(state, 'all', 'banner', 'away');
  assert.ok(Object.values(state.displays.stations).every((s) => s.preset === 'banner' && s.team === 'away'));
  assert.throws(() => applyDisplayPreset(state, 11, 'idle'), /1-10/);
  assert.throws(() => applyDisplayPreset(state, 1, 'wall'), /Unknown display preset/);
  const broken = { displays: { stations: { 2: { preset: 'nope' } } } };
  ensureDisplayState(broken);
  assert.equal(broken.displays.stations[2].preset, 'idle');
  assert.equal(Object.keys(broken.displays.stations).length, 10);
});

test('display presets: Companion action and old saves get the displays block', () => {
  const state = createInitialState();
  applyCompanionAction(state, { action: 'display.preset', station: '7', preset: 'score' });
  assert.equal(state.displays.stations[7].preset, 'score');
  applyCompanionAction(state, { action: 'display.preset', preset: 'intro' });
  assert.equal(state.displays.stations[1].preset, 'intro');
  assert.throws(() => applyCompanionAction(state, { action: 'display.preset', preset: 'x' }), /Unknown display preset/);
  const saved = createInitialState(); delete saved.displays; saved.stageObs = { stations: {} };
  const storage = { getItem: () => JSON.stringify(saved), setItem() {} };
  const loaded = loadState(storage);
  assert.equal(loaded.displays.stations[10].preset, 'idle');
});

test('display presets: station groups 1-5 and 6-10', async () => {
  const { stationTargets } = await import('../src/display-presets.js');
  assert.deepEqual(stationTargets('1-5'), [1, 2, 3, 4, 5]);
  assert.deepEqual(stationTargets('6-10'), [6, 7, 8, 9, 10]);
  assert.equal(stationTargets('all').length, 10);
  assert.deepEqual(stationTargets(3), [3]);
  assert.throws(() => stationTargets('2-4'), /1-5, 6-10/);
  const state = createInitialState();
  applyDisplayPreset(state, '1-5', 'player');
  applyDisplayPreset(state, '6-10', 'black');
  assert.deepEqual(Object.values(state.displays.stations).map((s) => s.preset), ['player', 'player', 'player', 'player', 'player', 'black', 'black', 'black', 'black', 'black']);
  applyCompanionAction(state, { action: 'display.preset', station: '6-10', preset: 'banner' });
  assert.equal(state.displays.stations[6].preset, 'banner');
  assert.equal(state.displays.stations[5].preset, 'player', '1-5 untouched');
});

test('Overwatch hero bans: per map, per team, via Companion; unknown hero rejected', () => {
  const state = createInitialState();
  state.selectedGame = 'overwatch';
  const game = state.games.overwatch;
  game.activeMap = 1;
  applyCompanionAction(state, { action: 'overwatch.ban', team: 'home', hero: 'tracer' });
  applyCompanionAction(state, { action: 'overwatch.ban', team: 'away', hero: 'Soldier: 76' });
  assert.deepEqual(game.mapRows[1].heroBans, { home: 'Tracer', away: 'Soldier: 76' });
  assert.equal(game.mapRows[0].heroBans, undefined, 'other maps keep their own bans');
  applyCompanionAction(state, { action: 'overwatch.ban', team: 'home', hero: '' });
  assert.equal(game.mapRows[1].heroBans.home, '');
  assert.throws(() => applyCompanionAction(state, { action: 'overwatch.ban', team: 'home', hero: 'Pikachu' }), /Unknown hero/);
});

test('last game stats: saved per station when a game ends (VALORANT K/D/A, RL stats, Overwatch), Varsity + JV', () => {
  const val = { activeMap: 0, mapRows: [{ map: 'Ascent' }, { map: 'Bind' }],
    rosters: { varsity: [{ handle: 'Sn0wfal', stageStation: 1 }], jv: [{ handle: 'newx', stageStation: 6 }] }, awayRosters: { varsity: [{ handle: 'CWTJ', stageStation: 9 }], jv: [] },
    valorantBoard: { live: { teams: { home: { players: [{ name: 'SnOwfal', agent: 'viper', kills: 18, deaths: 12, assists: 6, credits: 2600 }, { name: 'newx', agent: 'yoru', kills: 4, deaths: 9, assists: 2 }] }, away: { players: [{ name: 'CWTJ', agent: 'tejo', kills: 7, deaths: 8, assists: 11 }] } } } } };
  assert.equal(saveLastGameStats(val, 'valorant', 'varsity'), 3);
  assert.deepEqual(val.lastGameStats[1].stats, { kills: 18, deaths: 12, assists: 6 }, 'K/D/A only, no credits');
  assert.equal(val.lastGameStats[1].map, 'Ascent');
  assert.equal(val.lastGameStats[1].character, 'viper');
  assert.equal(val.lastGameStats[6].stats.kills, 4, 'JV on stage too');
  assert.equal(val.lastGameStats[9].stats.assists, 11);
  const rl = { activeMap: 0, mapRows: [{ map: 'DFH Stadium' }], rosters: { varsity: [{ handle: 'D3RK99', stageStation: 2, character: 'Fennec' }] }, awayRosters: { varsity: [] },
    rocketLeague: { live: { players: [{ name: 'D3RK_99', score: 412, goals: 2, assists: 1, saves: 3, shots: 5, demos: 1, boost: 64 }] } } };
  saveLastGameStats(rl, 'rocketleague');
  assert.deepEqual(rl.lastGameStats[2].stats, { score: 412, goals: 2, assists: 1, saves: 3, shots: 5, demos: 1 }, 'no boost');
  const ow = { activeMap: 0, mapRows: [{ map: 'Busan' }, { map: 'Ilios' }], teams: [{ score: 0 }, { score: 0 }], rosters: { varsity: [{ handle: 'D3RK99', stageStation: 3 }] }, awayRosters: { varsity: [] },
    overwatchOcr: { live: { teams: { home: { players: [{ name: 'D3RK99', hero: 'Tracer', elims: 12, deaths: 4, assists: 3, damage: 9000, healing: 0, mitigation: 0 }] }, away: { players: [] } } } } };
  advanceGameMatch(ow, 'overwatch');
  assert.equal(ow.lastGameStats[3].stats.elims, 12, 'NEXT MATCH saves the map that just ended');
  assert.equal(ow.lastGameStats[3].map, 'Busan');
  assert.equal(ow.overwatchLastMapStats[3].hero, 'Tracer');
});

test('VALORANT round history bar clears on NEXT MATCH and on reset, also through Companion', async () => {
  const state = createInitialState(); state.selectedGame = 'valorant';
  const fill = () => {
    const g = state.games.valorant;
    g.valorantOcr.live = { observer3: { roundTimeline: { currentRound: 6, rounds: Array.from({ length: 24 }, (_v, i) => ({ round: i + 1, winnerSide: i < 5 ? 'home' : null, winnerRole: i < 5 ? 'defense' : null })) } } };
  };
  const won = () => state.games.valorant.valorantOcr.live.observer3.roundTimeline.rounds.filter((r) => r.winnerSide || r.winnerRole).length;
  fill(); assert.equal(won(), 5);
  applyCompanionAction(state, { action: 'match.next' });
  assert.equal(won(), 0, 'Companion NEXT MATCH clears the bar');
  assert.equal(state.games.valorant.valorantOcr.live.observer3.roundTimeline.currentRound, 1);
  fill(); applyCompanionAction(state, { action: 'scores.reset' });
  assert.equal(won(), 0, 'Companion reset clears the bar');
});
