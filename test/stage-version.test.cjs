const test = require('node:test');
const assert = require('node:assert/strict');
const { isOlderVersion } = require('../electron/stage-displays/client-version.cjs');
const { StageDisplayManager } = require('../electron/stage-displays/stage-display-manager.cjs');

test('stage update comparisons never downgrade equal or newer clients', () => {
  assert.equal(isOlderVersion('0.1.3', '0.1.1'), false);
  assert.equal(isOlderVersion('0.1.3', '0.1.3'), false);
  assert.equal(isOlderVersion('0.1.3', '0.1.10'), true);
  assert.equal(isOlderVersion('', '0.1.3'), false);
  assert.equal(isOlderVersion('0.1.3', undefined), false);
});

test('outdated status and update targets follow the published release', () => {
  const manager = new StageDisplayManager();
  for (let station = 1; station <= 10; station++) {
    manager.stations.set(station, { station, online: true, clientVersion: '0.1.3' });
  }
  manager.publishedClientUpdate = () => ({ available: true, version: '0.1.1' });
  assert.deepEqual(manager.updateTargetStations(), []);
  assert.equal(manager.status().warnings.length, 0);
  assert.equal(manager.status().stations.some((s) => s.outdated), false);
  manager.publishedClientUpdate = () => ({ available: true, version: '0.1.4' });
  assert.equal(manager.updateTargetStations().length, 10);
  assert.equal(manager.status().stations.filter((s) => s.online).every((s) => s.outdated), true);
});

test('test station playback preserves the stage cue and global commands exclude station 11', async () => {
  const manager = new StageDisplayManager();
  const sent = [];
  manager.sendToStation = (station, payload) => { sent.push({ station, payload }); return true; };
  manager.stations.get(11).online = true;
  manager.presetDetails = () => ({ name: 'test', assetPath: '/stage-assets/test/index.html' });
  const cue = { playId: 'live-cue', targetStations: [1, 2, 3, 4, 5] };
  manager.pendingPreset = cue;
  manager.lastGlobalMode = 'gameplay';
  const result = await manager.playPreset('test', { targetStations: [11], mode: 'wall', wallTotal: 5, wallPosition: 3 });
  assert.equal(result.ok, true);
  assert.equal(manager.pendingPreset, cue);
  assert.equal(manager.lastGlobalMode, 'gameplay');
  assert.deepEqual(sent.map((item) => item.station), [11]);
  assert.equal(sent[0].payload.wallPosition, 3);
  assert.equal(sent[0].payload.wallTotal, 5);
  assert.equal(manager.preparePreset('test', { targetStations: [11] }).ok, false);
  assert.equal(manager.pendingPreset, cue);
  sent.length = 0;
  manager.setGlobalMode('blackout');
  assert.deepEqual(sent.map((item) => item.station), [1,2,3,4,5,6,7,8,9,10]);
  assert.equal(manager.status().onlineCount, 0);
  assert.equal(manager.status().testOnline, true);
  assert.equal(manager.updateTargetStations('all').includes(11), false);
});
