import test from 'node:test';
import assert from 'node:assert/strict';
import { nameSimilarity, pairPlayers, syncRosterSides, needsAutoCar, liveLoadoutKey } from '../src/rl-roster-sync.js';

const blank = () => ({ handle: '', name: '', characterImage: '' });

test('name matching tolerates case, tags, spacing and small typos', () => {
  assert.equal(nameSimilarity('BengalOne', 'bengalone'), 1);
  assert.ok(nameSimilarity('[ISU] Bengal One', 'BengalOne') === 1);
  assert.ok(nameSimilarity('Bengal0ne', 'BengalOne') >= 0.74);
  assert.ok(nameSimilarity('ISUBengal', 'Bengal') >= 0.85);
  assert.ok(nameSimilarity('Kaizen', 'BengalOne') < 0.5);
  assert.equal(nameSimilarity('', 'x'), 0);
});

test('pairs best matches first and never reuses a slot', () => {
  const roster = [{ handle: 'Bengal' }, { handle: 'BengalOne' }, blank()];
  const players = [{ id: 'a', name: 'BengalOne' }, { id: 'b', name: 'Bengal' }, { id: 'c', name: 'Stranger' }];
  const { pairs, unmatched } = pairPlayers(players, roster);
  const byPlayer = Object.fromEntries(pairs.map((x) => [players[x.p].id, x.r]));
  assert.deepEqual(byPlayer, { a: 1, b: 0 });
  assert.deepEqual(unmatched, [2]);
});

test('real name matches too, and a linked id wins', () => {
  const roster = [{ handle: 'zzz', name: 'John Smith' }, { handle: 'Other', rlPlayerId: 'Steam|9|0' }];
  const { pairs } = pairPlayers([{ id: 'Epic|1|0', name: 'johnsmith' }, { id: 'Steam|9|0', name: 'renamed guy' }], roster);
  assert.equal(pairs.length, 2);
});

test('sync fills away side, links home side, keeps manual PNGs, queues renders', () => {
  const home = [{ handle: 'BengalOne', characterImage: 'manual.png' }, { handle: 'BengalTwo' }, blank()];
  const away = [blank(), blank(), blank()];
  const load = ['Body_Octane', 'None', 'WHEEL_Star'];
  const r = syncRosterSides([
    { side: 'home', roster: home, players: [{ id: 'h1', name: 'bengalone', loadout: load }, { id: 'h2', name: 'BengalTwo', loadout: load }] },
    { side: 'away', roster: away, players: [{ id: 'o1', name: 'Opp1', loadout: load }, { id: 'o2', name: 'Opp2', loadout: load }, { id: 'o3', name: 'Opp3', loadout: load }, { id: 'o4', name: 'Opp4', loadout: load }] }
  ], blank);
  assert.equal(home[0].rlPlayerId, 'h1');
  assert.equal(home[0].characterImage, 'manual.png');
  assert.deepEqual(away.map((p) => p.handle), ['Opp1', 'Opp2', 'Opp3', 'Opp4']);
  assert.equal(r.added.length, 4);
  const renderKeys = r.renders.map((x) => `${x.side}${x.index}`).sort();
  assert.deepEqual(renderKeys, ['away0', 'away1', 'away2', 'away3', 'home1']);
});

test('auto car re-renders only when the loadout changed', () => {
  const player = { loadout: ['Body_Octane', 'x', 'y'] };
  assert.equal(needsAutoCar({}, player), true);
  assert.equal(needsAutoCar({ characterImage: 'm.png' }, player), false);
  assert.equal(needsAutoCar({ characterImage: 'a.png', characterImageAuto: true, characterImageLoadout: liveLoadoutKey(player.loadout) }, player), false);
  assert.equal(needsAutoCar({ characterImage: 'a.png', characterImageAuto: true, characterImageLoadout: 'old' }, player), true);
  assert.equal(needsAutoCar({}, { loadout: ['None'] }), false);
});
