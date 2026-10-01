'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConfigStore, defaults, validate, migrate } = require('../core/config.cjs');
const { StreamService } = require('../core/service.cjs');
const { DelayBuffer } = require('../core/media/delay.cjs');
const { TsReader } = require('../core/media/ts.cjs');
const { publishUrl, redact } = require('../core/media/output.cjs');
const { rationalFps } = require('../core/media/sources.cjs');
const logger = { write() {} };
const creds = { seal: (s) => Buffer.from(s).toString('base64'), open: (s) => Buffer.from(s, 'base64').toString() };

function tmp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isu-real-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('real mode with missing FFmpeg reports an actionable error and never falls back to simulation', async (t) => {
  const dir = tmp(t);
  const store = new ConfigStore(dir, creds);
  const missing = async () => { throw Object.assign(new Error('FFmpeg not found or unusable. Install an FFmpeg build...'), { code: 'FFMPEG_MISSING' }); };
  const service = new StreamService(store, logger, { dataDir: dir, findFfmpegFn: missing });
  await service.initialize();
  const status = service.status();
  assert.equal(status.simulation, false);
  assert.equal(status.engine, 'ERROR');
  assert.match(status.error, /FFmpeg not found/);
  assert.equal(status.outputsLocked, true);
  await assert.rejects(service.command('startAll'), /FFmpeg not found/);
  assert.equal(service.sim, null);
});

test('config v1 migrates to v2 as simulation (explicit), backs up the original, rejects bad engine/input', (t) => {
  const dir = tmp(t);
  const v1 = { ...defaults(), version: 1 };
  delete v1.engine; delete v1.ffmpegPath; delete v1.storageDir; v1.input = { video: 'Simulation SDI 1', audio: 'Simulation embedded audio' };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(v1));
  const loaded = new ConfigStore(dir, creds).load();
  assert.equal(loaded.version, 2);
  assert.equal(loaded.engine, 'simulation');
  assert.ok(fs.existsSync(path.join(dir, 'config.json.v1.bak')));
  assert.throws(() => validate({ ...defaults(), engine: 'magic' }), /Engine/);
  assert.throws(() => validate({ ...defaults(), input: { ...defaults().input, type: 'webcam' } }), /Input type/);
  assert.equal(migrate(defaults()).version, 2);
});

test('delay buffer never releases a chunk before it has aged past the delay', async (t) => {
  const dir = tmp(t);
  let clock = 0;
  const delay = new DelayBuffer({ directory: dir, now: () => clock, maxChunkSeconds: 1 });
  await delay.init();
  clearInterval(delay.timer); // drive release() by hand with the fake clock
  await delay.reset(10);
  const released = [];
  delay.on('chunk', (c) => released.push(c));
  // Fake TS: a PAT, a PMT (video pid 0x100 h264, audio 0x101 aac), then keyframe/audio packets.
  const reader = new TsReader();
  const pkt = (pid, { pusi = false, rai = false, payload = [] } = {}) => {
    const b = Buffer.alloc(188, 0xff);
    b[0] = 0x47; b[1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f); b[2] = pid & 0xff;
    if (rai) { b[3] = 0x30; b[4] = 1; b[5] = 0x40; Buffer.from(payload).copy(b, 6); } else { b[3] = 0x10; Buffer.from(payload).copy(b, 4); }
    return b;
  };
  const pat = pkt(0, { pusi: true, payload: [0, 0x00, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xe0 | 0x10, 0x00, 0, 0, 0, 0] });
  const pmt = pkt(0x1000, { pusi: true, payload: [0, 0x02, 0xb0, 23, 0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0, 0x1b, 0xe1, 0x00, 0xf0, 0, 0x0f, 0xe1, 0x01, 0xf0, 0, 0, 0, 0, 0] });
  const write = (...packets) => delay.write({ packets: Buffer.concat(packets), reader, receivedAt: clock });
  write(pat, pmt);
  for (let second = 0; second < 30; second++) {
    clock = second * 1000;
    write(pkt(0x100, { pusi: true, rai: true }), pkt(0x101, { pusi: true }));
    await delay.release();
    for (const c of released) assert.ok(clock - c.completedAt >= 10000, `released early at t=${clock}`);
  }
  assert.ok(released.length > 0, 'nothing ever released');
  assert.ok(released.every((c) => c.ageMs >= 10000));
  assert.equal(delay.status().ready, true);
  // Reset discards everything: readiness drops and no old-epoch chunk can come out.
  const before = released.length;
  await delay.reset(10);
  assert.equal(delay.status().ready, false);
  clock += 60000; await delay.release();
  assert.equal(released.length, before);
  await delay.close();
});

test('disk preflight refuses a delay that will not fit', async (t) => {
  const dir = tmp(t);
  const delay = new DelayBuffer({ directory: dir });
  await assert.rejects(delay.preflight(86400 * 50, 200000, 1024), /Not enough disk space/);
  assert.ok((await delay.preflight(10, 1000, 128)).needBytes > 0);
});

test('stream keys are redacted from errors and URLs are built at the connection boundary', () => {
  const url = publishUrl({ serverUrl: 'rtmps://live.example.com/app/' }, 'sk_live_abc123');
  assert.equal(url, 'rtmps://live.example.com/app/sk_live_abc123');
  assert.ok(!redact(`Failed to connect ${url}`, 'sk_live_abc123').includes('sk_live_abc123'));
  assert.ok(!redact('rtmp://host/app/someKey123 refused', '').includes('someKey123'));
  assert.equal(rationalFps(59.94), '60000/1001');
  assert.equal(rationalFps(60), '60');
});
