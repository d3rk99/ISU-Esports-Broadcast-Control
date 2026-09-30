const test = require('node:test');
const assert = require('node:assert/strict');
const { ObserverCellConsensus } = require('../electron/valorant-observer-consensus.cjs');

test('consensus: first value needs two reads, same value is instant', () => {
  const c = new ObserverCellConsensus();
  assert.equal(c.observe('k', 'kda', null, 3).accept, false);
  assert.equal(c.observe('k', 'kda', null, 3).accept, true);
  assert.equal(c.observe('k', 'kda', 3, 3).accept, true);
});

test('consensus: alternating noise never gets accepted', () => {
  const c = new ObserverCellConsensus();
  for (const v of [4, 7, 4, 7, 4, 7]) assert.equal(c.observe('k', 'kda', 2, v).accept, false);
});

test('consensus: big kda jump and ult required change count as corrections', () => {
  const c = new ObserverCellConsensus();
  for (let i = 0; i < 3; i += 1) assert.equal(c.observe('k', 'kda', 2, 12).accept, false);
  assert.equal(c.observe('k', 'kda', 2, 12).accept, true);
  const u = new ObserverCellConsensus();
  const cur = { status: 'charging', current: 3, required: 7, display: '3/7' };
  const nxt = { status: 'charging', current: 3, required: 8, display: '3/8' };
  for (let i = 0; i < 3; i += 1) assert.equal(u.observe('u', 'ultimate', cur, nxt).accept, false);
  assert.equal(u.observe('u', 'ultimate', cur, nxt).accept, true);
});

test('consensus: credits can go up or down after two reads', () => {
  const c = new ObserverCellConsensus();
  assert.equal(c.observe('c', 'credits', 4200, 800).accept, false);
  assert.equal(c.observe('c', 'credits', 4200, 800).accept, true);
});
