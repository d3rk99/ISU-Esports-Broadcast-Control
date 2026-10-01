const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConfigStore, defaults, validate, ElectronCredentialStore } = require('../core/config.cjs');
const { StreamService } = require('../core/service.cjs');
const { Logger } = require('../core/logger.cjs');
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ConfigStore(dir, { seal: s => Buffer.from(s).toString('base64') });
  const logger = new Logger(path.join(dir, 'logs'));
  return { dir, store, service: new StreamService(store, logger), logger };
}
test('all and individual starts are locked until delay filled; signal loss revokes readiness', async t => {
  const { service: s } = setup(t); await s.initialize();
  await assert.rejects(s.command('startAll'), /locked/); await assert.rejects(s.command('start', { id: 'output-1' }), /locked/);
  s.tick(299); assert.equal(s.status().outputsLocked, true); s.tick(1);
  await s.command('startAll'); s.tick(1); assert.ok(s.status().outputs.every(o => o.state === 'CONNECTED'));
  await s.command('signal'); assert.ok(s.status().outputs.every(o => o.state === 'STOPPED')); assert.equal(s.status().outputsLocked, true);
  await s.command('signal'); assert.equal(s.status().buffer.filledSeconds, 0);
});
test('zero delay, disabled destinations, reconnect cancellation, config reset and restart', async t => {
  const { service: s, store, logger } = setup(t); await s.initialize();
  const config = s.view().config; config.delaySeconds = 0; config.destinations[1].enabled = false;
  await s.command('save', config); assert.equal(s.status().outputsLocked, false);
  await assert.rejects(s.command('start', { id: 'output-2' }), /disabled/);
  await s.command('startAll'); s.tick(1); await s.command('fail', { id: 'output-1' }); assert.equal(s.status().outputs[0].state, 'ERROR');
  s.tick(1); assert.equal(s.status().outputs[0].state, 'RECONNECTING');
  await s.command('stopAll'); s.tick(10); assert.equal(s.status().outputs[0].state, 'STOPPED');
  await s.command('startAll'); s.tick(1); await s.command('fail', { id: 'output-1' }); s.tick(1); s.tick(1); assert.equal(s.status().outputs[0].state, 'CONNECTED');
  config.delaySeconds = 600; await s.command('save', config); assert.equal(s.status().outputsLocked, true);
  const restarted = new StreamService(store, logger); await restarted.initialize(); assert.equal(restarted.config.delaySeconds, 600); assert.equal(restarted.status().buffer.filledSeconds, 0);
});
test('credentials remain private, survive blank edits, and clear explicitly', async t => {
  const { service: s, dir } = setup(t); await s.initialize();
  const config = s.view().config; config.destinations[0].streamKey = 'secret-canary'; await s.command('save', config);
  assert.equal(s.view().config.destinations[0].hasKey, true); assert.ok(!JSON.stringify(s.view()).includes('secret-canary'));
  assert.ok(!fs.readFileSync(path.join(dir, 'config.json'), 'utf8').includes('secret-canary'));
  await s.command('save', s.view().config); assert.equal(s.view().config.destinations[0].hasKey, true);
  const clear = s.view().config; clear.destinations[0].clearKey = true; await s.command('save', clear); assert.equal(s.view().config.destinations[0].hasKey, false);
  assert.ok(!fs.readFileSync(path.join(dir, 'logs/stream-server.jsonl'), 'utf8').includes('secret-canary'));
  assert.throws(() => new ElectronCredentialStore({ isEncryptionAvailable: () => false }).seal('secret'), /unavailable/);
});
test('malformed config preserved, invalid URLs and duplicate IDs rejected', t => {
  const { store } = setup(t); fs.writeFileSync(store.file, '{broken'); assert.throws(() => store.load()); assert.equal(fs.readFileSync(store.file, 'utf8'), '{broken');
  const c = defaults(); c.destinations.push(c.destinations[0]); assert.throws(() => validate(c));
  const u = defaults(); u.destinations[0].serverUrl = 'rtmp://host/live'; assert.throws(() => validate(u));
  u.destinations[0].serverUrl = 'rtmps://user:secret@host/live'; assert.throws(() => validate(u));
  for (const seconds of [0, 30, 60, 300, 600, 3600]) { const valid = defaults(); valid.delaySeconds = seconds; assert.equal(validate(valid).delaySeconds, seconds); }
});
test('invalid save leaves running state intact and simulation clock does not affect reconnect clock', async t => {
  const { service: s } = setup(t); await s.initialize(); await s.command('speed', { value: 60 }); s.tick(5);
  await s.command('startAll'); s.tick(0.1); assert.equal(s.status().outputs[0].state, 'CONNECTING');
  const invalid = s.view().config; invalid.delaySeconds = -1; await assert.rejects(s.command('save', invalid)); assert.equal(s.status().buffer.ready, true);
  s.tick(1); assert.equal(s.status().outputs[0].state, 'CONNECTED');
});
