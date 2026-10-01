import test from 'node:test';
import assert from 'node:assert/strict';
import { finishMaterialParams, findFinish } from '../src/rl-car-finish.js';

// Real values read from the game's ProductAsset_PaintFinish_TA objects.
const MATTE = { displayName: 'Matte', lightCurve: 'Matte', specularStrength: 0.25, environmentStrength: 0.03125, specularTint: 0.25, rimLightTint: 0.25, diffuseDetailNormalStrength: 0.5 };
const GLOSSY = { displayName: 'Glossy', lightCurve: 'Glossy', specularStrength: 2, environmentStrength: 0.25, specularTint: 0.25, rimLightTint: 0.25 };
const BRUSHED = { displayName: 'Brushed Metal', lightCurve: 'Metallic', specularStrength: 12, environmentStrength: 1, sparkleStrength: 16, specularTint: 0.875, rimLightTint: 0.25, diffuseDetailNormalStrength: 0.5 };
const ANODIZED = { displayName: 'Anodized', lightCurve: 'Metallic', specularStrength: 3, environmentStrength: 10, sparkleStrength: 4, specularTint: 0.9, rimLightTint: 0.9 };
const PEARL = { displayName: 'Metallic Pearl', lightCurve: 'Metallic', specularStrength: 5, environmentStrength: 0.5, sparkleStrength: 32, pearlescentStrength: 1, specularTint: 0.75 };
const FUR = { displayName: 'Furry', lightCurve: 'Matte', specularStrength: 0.125, environmentStrength: 0.03125, diffuseDetailNormalStrength: 1.75 };

test('no finish -> null', () => assert.equal(finishMaterialParams(null), null));

test('matte is rough and barely reflective; glossy is smooth with clearcoat', () => {
  const m = finishMaterialParams(MATTE); const g = finishMaterialParams(GLOSSY);
  assert.ok(m.roughness > 0.7 && m.metalness === 0 && m.envMapIntensity < 0.3);
  assert.ok(g.roughness < 0.25 && g.clearcoat > 0.5 && g.metalness === 0);
  assert.ok(g.envMapIntensity > m.envMapIntensity);
});

test('metals are metallic; anodized is more mirror-like than brushed', () => {
  const b = finishMaterialParams(BRUSHED); const a = finishMaterialParams(ANODIZED);
  assert.ok(b.metalness > 0.7 && a.metalness > 0.7);
  assert.ok(a.roughness < b.roughness && a.envMapIntensity > b.envMapIntensity);
  assert.ok(b.sparkle > 0);
});

test('pearl gets iridescence, fur gets sheen and stays non-metal', () => {
  assert.ok(finishMaterialParams(PEARL).iridescence > 0);
  const f = finishMaterialParams(FUR);
  assert.ok(f.sheen > 0 && f.metalness === 0 && f.iridescence === 0);
});

test('findFinish matches id, display name and product id; None is nothing', () => {
  const list = [{ id: 'PaintFinish_Matte', productId: 273, displayName: 'Matte' }, { id: 'PaintFinish_BrushedMetal', productId: 266, displayName: 'Brushed Metal' }];
  assert.equal(findFinish(list, 'paintfinish_matte').productId, 273);
  assert.equal(findFinish(list, 'Brushed Metal').productId, 266);
  assert.equal(findFinish(list, '266').displayName, 'Brushed Metal');
  assert.equal(findFinish(list, 'None'), null);
  assert.equal(findFinish(list, 'Body_Octane'), null);
});
