import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAssetIndex, composeCar, teamPaint } from '../src/rl-car-compose.js';

const pack = {
  bodies: [{ id: 'body_grain', displayName: 'Fennec', aliases: ['4284'] }, { id: 'Body_Octane', displayName: 'Octane' }],
  wheels: [{ id: 'Wheel_SoccerBall', displayName: 'Cristiano' }],
  decals: [
    { id: 'skin_grain_flames', displayName: 'Fennec: Flames', appliesToBodyId: 'body_grain', appliesToBodyName: 'Fennec' },
    { id: 'Skin_Octane_Flames', displayName: 'Octane: Flames', appliesToBodyId: 'Body_Octane', appliesToBodyName: 'Octane' }
  ]
};
const index = buildAssetIndex(pack);

test('compose: Stats API loadout slots resolve to body, decal and wheel', () => {
  const car = composeCar({ Loadout: ['BODY_GRAIN', 'Skin_Grain_Flames', 'wheel_soccerball', 'Boost_AlphaReward', 'None'], TeamNum: 1 }, [], index);
  assert.equal(car.body.id, 'body_grain');
  assert.equal(car.decal.id, 'skin_grain_flames');
  assert.equal(car.wheel.id, 'Wheel_SoccerBall');
  assert.equal(car.teamNum, 1);
  assert.deepEqual(car.missing, []);
});

test('compose: a decal for another body is skipped with a note; unknown items are reported', () => {
  const car = composeCar({ Loadout: ['body_grain', 'Skin_Octane_Flames', 'Wheel_Unknown'], TeamNum: 0 }, [], index);
  assert.equal(car.decal, null);
  assert.match(car.notes[0], /Octane/);
  assert.deepEqual(car.missing, [{ slot: 'wheel', name: 'Wheel_Unknown' }]);
});

test('compose: "None" slots are empty, not missing', () => {
  const car = composeCar({ Loadout: ['Body_Octane', 'None', 'None'], TeamNum: 0 }, [], index);
  assert.equal(car.decal, null);
  assert.equal(car.wheel, null);
  assert.deepEqual(car.missing, []);
});

test('paint: team colours come from the packet, with blue/orange defaults', () => {
  assert.deepEqual(teamPaint(0, [{ TeamNum: 0, ColorPrimary: 'F47920', ColorSecondary: '111111' }]), { primary: '#f47920', accent: '#111111' });
  assert.equal(teamPaint(1, []).primary, '#fc7c0c');
  assert.equal(teamPaint(0, [{ TeamNum: 0, ColorPrimary: 'bad' }]).primary, '#0c88fc');
});

test('player garage colours override team colours', async () => {
  const { composeCar: compose, playerPaint } = await import('../src/rl-car-compose.js');
  const { BLUE_PRIMARY, ORANGE_PRIMARY, ACCENT } = await import('../src/rl-car-palette.js');
  assert.equal(BLUE_PRIMARY.length, 70);
  assert.equal(ORANGE_PRIMARY.length, 70);
  assert.equal(ACCENT.length, 105);
  assert.deepEqual(playerPaint(0, { primaryId: 5, accentId: 3 }), { primary: BLUE_PRIMARY[5], accent: ACCENT[3] });
  assert.deepEqual(playerPaint(1, { primaryId: 5 }), { primary: ORANGE_PRIMARY[5], accent: ACCENT[0] });
  assert.deepEqual(playerPaint(0, { primary: 'FF00AA', accent: '#00ff00' }), { primary: '#ff00aa', accent: '#00ff00' });
  assert.equal(playerPaint(0, null), null);
  const car = compose({ Loadout: ['None'], TeamNum: 1, paint: { primaryId: 12, accentId: 40 } }, [{ TeamNum: 1, ColorPrimary: 'FFFFFF' }], {});
  assert.equal(car.paintSource, 'player');
  assert.equal(car.paint.primary, ORANGE_PRIMARY[12]);
  const team = compose({ Loadout: ['None'], TeamNum: 1 }, [{ TeamNum: 1, ColorPrimary: 'FFFFFF', ColorSecondary: '000000' }], {});
  assert.equal(team.paintSource, 'team');
  assert.equal(team.paint.primary, '#ffffff');
});
