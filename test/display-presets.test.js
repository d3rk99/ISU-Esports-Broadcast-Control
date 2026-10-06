import test from 'node:test';
import assert from 'node:assert/strict';
import { DISPLAY_PRESETS, applyDisplayPreset, ensureDisplayState } from '../src/display-presets.js';
import { applyCompanionAction } from '../src/companion-actions.js';
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
