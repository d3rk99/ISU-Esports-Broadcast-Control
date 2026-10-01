const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Preview, MAX_BACKLOG_BYTES } = require('../core/media/preview.cjs');

// TS packet helpers: video PID 0x100; flags: start (PUSI) and keyframe (random access).
function pkt({ start = false, key = false } = {}) {
  const b = Buffer.alloc(188, 0xff);
  b[0] = 0x47; b[1] = (start ? 0x40 : 0) | 0x01; b[2] = 0x00;
  if (key) { b[3] = 0x30; b[4] = 1; b[5] = 0x40; } else b[3] = 0x10;
  return b;
}
const chunk = (...p) => Buffer.concat(p);
const reader = { videoPid: 0x100, headers: () => Buffer.alloc(0) };

function fakeSpawn(writes, { backpressure = true, backlog = () => 0 } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdio = [null, null, null, new EventEmitter()];
    child.stdin = new EventEmitter();
    child.stdin.write = (d) => { writes.push(d); return !backpressure; }; // Windows pipes: false almost always
    Object.defineProperty(child.stdin, 'writableLength', { get: backlog });
    child.stdin.end = () => {}; child.kill = () => {};
    return child;
  };
}

test('Windows-style write()=false does NOT make the preview skip (old bug: constant keyframe resync, ~5 fps, smears)', () => {
  const writes = [];
  const p = new Preview({ ffmpegPath: 'x', spawnFn: fakeSpawn(writes, { backpressure: true, backlog: () => 64 * 1024 }) });
  p.feed({ instance: 1, packets: chunk(pkt({ start: true, key: true }), pkt()), reader });
  for (let i = 0; i < 50; i++) p.feed({ instance: 1, packets: chunk(pkt({ start: true }), pkt()), reader });
  assert.equal(writes.length, 51); // every chunk delivered, none skipped
  assert.equal(p.waitingKeyframe, false);
});

test('real backlog: finishes the frame in flight, drops until drained, then rejoins on a keyframe', () => {
  const writes = []; let backlog = 0;
  const p = new Preview({ ffmpegPath: 'x', spawnFn: fakeSpawn(writes, { backlog: () => backlog }) });
  p.feed({ instance: 1, packets: chunk(pkt({ start: true, key: true }), pkt()), reader });
  backlog = MAX_BACKLOG_BYTES + 1;
  p.feed({ instance: 1, packets: chunk(pkt({ start: true }), pkt()), reader }); // goes congested
  assert.equal(p.congested, true);
  const tail = pkt(); const nextFrame = pkt({ start: true });
  p.feed({ instance: 1, packets: chunk(tail, nextFrame, pkt()), reader });
  assert.equal(writes[writes.length - 1].length, 188); // only the rest of the frame in flight, cut before the next frame
  const before = writes.length;
  p.feed({ instance: 1, packets: chunk(pkt({ start: true }), pkt()), reader }); // still behind: dropped
  assert.equal(writes.length, before);
  backlog = 0;
  p.feed({ instance: 1, packets: chunk(pkt({ start: true }), pkt()), reader }); // drained but no keyframe: wait
  assert.equal(writes.length, before);
  p.feed({ instance: 1, packets: chunk(pkt(), pkt({ start: true, key: true }), pkt()), reader }); // rejoin exactly on the keyframe
  assert.equal(writes[writes.length - 1].length, 2 * 188);
  assert.equal(p.waitingKeyframe, false);
});
