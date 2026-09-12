import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameState, createInitialState, GAME_CONFIGS, GAME_ORDER } from '../src/game-config.js';
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
  assert.equal(createGameState('overwatch').mapRows[0].map, '');
  assert.equal(createGameState('overwatch').mapRows[0].mode, '');
  assert.equal(createGameState('valorant').mapRows.length, 3);
  assert.equal(createGameState('smash').mapRows.length, 3);
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

test('saved empty rosters are backfilled with default slots', () => {
  const saved = createInitialState();
  saved.games.rocketleague.rosters.varsity = [];
  saved.games.rocketleague.awayRosters.varsity = [];
  const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(saved) });
  const rocketLeague = loadState(storage).games.rocketleague;
  assert.equal(rocketLeague.rosters.varsity.length, 3);
  assert.equal(rocketLeague.awayRosters.varsity.length, 3);
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
  const overwatch = createGameState('overwatch');
  for (const hero of GAME_CONFIGS.overwatch.characters) {
    assert.ok(overwatch.characterArt[hero], `${hero} is missing hero art`);
    assert.ok(overwatch.characterArt[hero].url.startsWith('/assets/overwatch/heroes/'));
  }
  for (const map of GAME_CONFIGS.overwatch.maps) {
    assert.ok(overwatch.mapArt[map], `${map} is missing map art`);
    assert.ok(overwatch.mapArt[map].url.startsWith('/assets/overwatch/maps/'));
  }
  const valorant = createGameState('valorant');
  assert.equal(valorant.characterArt && Object.keys(valorant.characterArt).length, 0);
  assert.ok(valorant.mapArt.Ascent.url.endsWith('/ascent.webp'));
  assert.ok(valorant.mapArt.Fracture.url.endsWith('/fracture.webp'));
  assert.ok(valorant.mapArt.Range.url.endsWith('/range.webp'));
  assert.ok(createGameState('rocketleague').mapArt.Mannfield.url.endsWith('/mannfield.webp'));
  assert.ok(createGameState('rocketleague').mapArt['Forbidden Temple'].url.endsWith('/forbidden-temple.webp'));
  assert.equal(state.version, 4);
});

test('saved Overwatch data inherits built-in hero art', () => {
  const saved = createInitialState();
  saved.games.overwatch.characterArt = {};
  saved.games.overwatch.mapArt = {};
  const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(saved) });
  const overwatch = loadState(storage).games.overwatch;
  for (const hero of GAME_CONFIGS.overwatch.characters) {
    assert.ok(overwatch.characterArt[hero], `${hero} is missing migrated hero art`);
  }
  for (const map of GAME_CONFIGS.overwatch.maps) {
    assert.ok(overwatch.mapArt[map], `${map} is missing migrated map art`);
  }
  assert.ok(overwatch.characterArt.Tracer.url.endsWith('/tracer.webp'));
  assert.ok(overwatch.mapArt.Midtown.url.endsWith('/midtown.webp'));
});

test('saved Valorant data inherits built-in map art', () => {
  const saved = createInitialState();
  saved.games.valorant.mapArt = {};
  const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(saved) });
  const valorant = loadState(storage).games.valorant;
  for (const map of GAME_CONFIGS.valorant.maps) {
    assert.ok(valorant.mapArt[map], `${map} is missing migrated map art`);
  }
  assert.ok(valorant.mapArt.Ascent.url.endsWith('/ascent.webp'));
  assert.ok(valorant.mapArt.Corrode.url.endsWith('/corrode.webp'));
});

test('saved Rocket League shared car art migrates to player car PNGs', () => {
  const saved = createInitialState();
  saved.games.rocketleague.rosters.varsity[0].character = 'Octane';
  saved.games.rocketleague.characterArt = {
    Octane: { url: '/assets/rocketleague/octane-player.webp', name: 'octane-player.webp' }
  };
  const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(saved) });
  const player = loadState(storage).games.rocketleague.rosters.varsity[0];
  assert.equal(player.characterImage, '/assets/rocketleague/octane-player.webp');
  assert.equal(player.characterImageName, 'octane-player.webp');
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

test('saved map rows migrate to current configured row counts', () => {
  const legacy = createInitialState();
  legacy.games.valorant.mapRows.push({ mode: 'Map 4', map: 'Split', status: 'upcoming', winner: null, score: ['', ''] });
  legacy.games.valorant.mapRows.push({ mode: 'Map 5', map: 'Sunset', status: 'upcoming', winner: null, score: ['', ''] });
  legacy.games.smash.mapRows.push({ mode: 'Game 4', map: 'Town and City', status: 'upcoming', winner: null, score: ['', ''] });
  legacy.games.smash.mapRows.push({ mode: 'Game 5', map: 'Smashville', status: 'upcoming', winner: null, score: ['', ''] });
  const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(legacy) });
  const migrated = loadState(storage);
  assert.equal(migrated.games.valorant.mapRows.length, 3);
  assert.equal(migrated.games.smash.mapRows.length, 3);
  assert.equal(migrated.games.rocketleague.mapRows.length, 7);
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
