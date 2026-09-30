import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLoadout, loadoutKey, resolveCarArt, updateCarArt } from '../src/rl-loadout.js';
import { createRequire } from 'node:module';
const { validateCarGlb } = createRequire(import.meta.url)('../electron/rl-car-assets.cjs');

test('loadout slots stay aligned and missing data never matches a body', () => {
  assert.deepEqual(normalizeLoadout(['body_test', null, 'wheels']), ['body_test', '', 'wheels']);
  assert.equal(loadoutKey([]), '');
  assert.equal(loadoutKey(['None']), '');
  assert.equal(loadoutKey([' BODY_TEST '], 'body'), 'body:body_test');
  assert.notEqual(loadoutKey(['a', 'b']), loadoutKey(['a', 'c']));
});
test('specific artwork wins over body artwork; disabling clears existing URLs', () => {
  const player = { loadout: ['body_a', 'decal_a'] };
  const library = { enabled: true, renders: {
    [loadoutKey(player.loadout)]: { url: 'specific.png' },
    [loadoutKey(player.loadout, 'body')]: { url: 'body.png' }
  } };
  assert.equal(resolveCarArt(player, library).url, 'specific.png');
  player.loadout[1] = 'decal_b';
  assert.equal(resolveCarArt(player, library).scope, 'body');
  const game = { rocketLeague: { carRenderer: library, live: { players: [player] } } };
  updateCarArt(game); assert.equal(player.carImage, 'body.png');
  library.enabled = false; updateCarArt(game); assert.equal(player.carImage, '');
  library.enabled = true; player.loadout = []; updateCarArt(game); assert.equal(player.carImage, '');
});
function glb(json) {
  const text = Buffer.from(JSON.stringify(json));
  const length = Math.ceil(text.length / 4) * 4;
  const output = Buffer.alloc(20 + length, 0x20);
  output.writeUInt32LE(0x46546c67, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(length, 12); output.writeUInt32LE(0x4e4f534a, 16); text.copy(output, 20);
  return output;
}
test('GLB import rejects bad headers, external resource access and unsupported compression', () => {
  const valid = { asset: { version: '2.0' }, meshes: [{}] };
  assert.equal(validateCarGlb(glb(valid)).asset.version, '2.0');
  for (const uri of ['https://example.com/image.png', 'file:///C:/secret', '../secret', 'data:image/svg+xml;base64,AAAA']) {
    assert.throws(() => validateCarGlb(glb({ ...valid, images: [{ uri }] })), /external resources/);
  }
  assert.throws(() => validateCarGlb(Buffer.alloc(24)), /valid glTF/);
  assert.throws(() => validateCarGlb(glb({ ...valid, extensionsRequired: ['KHR_draco_mesh_compression'] })), /uncompressed/);
  assert.throws(() => validateCarGlb(glb({ ...valid, accessors: [{ count: 6000000 }] })), /complex/);
});
