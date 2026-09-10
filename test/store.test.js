import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameState, createInitialState, GAME_ORDER } from '../src/game-config.js';
import { loadState, saveState, STORAGE_KEY } from '../src/store.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value)
  };
}

test('initial state includes every supported game', () => {
  const state = createInitialState();
  assert.deepEqual(Object.keys(state.games), GAME_ORDER);
  assert.equal(state.selectedGame, 'overwatch');
});

test('game state creates the expected default roster size', () => {
  assert.equal(createGameState('rocketleague').rosters.varsity.length, 3);
  assert.equal(createGameState('rocketleague').awayRosters.varsity.length, 3);
  assert.equal(createGameState('overwatch').rosters.varsity.length, 5);
  assert.equal(createGameState('valorant').veto.picks.length, 3);
  assert.equal(createGameState('valorant').rosters.varsity[0].playerImage, '');
  assert.equal(createGameState('valorant').showAwayRoster, false);
  assert.ok(createGameState('smash').characterArt);
});

test('saved state can be restored', () => {
  const storage = memoryStorage();
  const state = createInitialState();
  state.games.valorant.teams[0].score = 2;
  saveState(state, storage);
  assert.equal(loadState(storage).games.valorant.teams[0].score, 2);
  assert.ok(storage.getItem(STORAGE_KEY));
});

test('invalid saved data falls back safely', () => {
  const storage = memoryStorage({ [STORAGE_KEY]: '{not json' });
  assert.equal(loadState(storage).selectedGame, 'overwatch');
});

test('version 1 data migrates dual rosters, media, colors, and veto fields', () => {
  const legacy = createInitialState();
  legacy.version = 1;
  delete legacy.games.valorant.veto;
  legacy.games.valorant.rosters.varsity = [{ handle: 'LegacyPlayer', name: '', role: 'Duelist' }];
  const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(legacy) });
  const migrated = loadState(storage);
  assert.equal(migrated.version, 4);
  assert.equal(migrated.games.valorant.rosters.varsity[0].characterImage, '');
  assert.equal(migrated.games.valorant.veto.bans.length, 4);
  assert.equal(migrated.games.valorant.awayRosters.varsity.length, 5);
  assert.equal(migrated.games.valorant.teams[0].secondaryColor, '#101012');
  assert.equal(migrated.activeRosterSide, 'home');
  assert.equal(migrated.games.rocketleague.rocketLeague.webPort, 49124);
});

test('character choices and shared artwork library are game specific', () => {
  const state = createInitialState();
  assert.ok(state.games.overwatch.characterArt);
  assert.equal(state.version, 4);
});

test('saved veto data drops duplicate map selections', () => {
  const legacy = createInitialState();
  legacy.games.valorant.veto.bans[1] = legacy.games.valorant.veto.bans[0];
  legacy.games.valorant.veto.picks[0].map = legacy.games.valorant.veto.bans[0];
  const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(legacy) });
  const veto = loadState(storage).games.valorant.veto;
  assert.equal(veto.bans[1], '');
  assert.equal(veto.picks[0].map, '');
});

test('saved Rocket League session telemetry is cleared on app launch', () => {
  const saved = createInitialState();
  saved.games.rocketleague.rocketLeague.live = {
    ...saved.games.rocketleague.rocketLeague.live,
    status: 'connected',
    packets: 900,
    lastPacketAt: '2026-01-01T00:00:00.000Z',
    players: [{ name: 'Stale Player' }]
  };
  const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(saved) });
  const live = loadState(storage).games.rocketleague.rocketLeague.live;
  assert.equal(live.status, 'disabled');
  assert.equal(live.packets, 0);
  assert.equal(live.lastPacketAt, null);
  assert.deepEqual(live.players, []);
});
