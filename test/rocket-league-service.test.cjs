const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { JsonStreamParser, RocketLeagueService, normalizeEnvelope, normalizeSettings } = require('../electron/rocket-league-service.cjs');

test('TCP parser handles fragmented and concatenated Stats API messages', () => {
  const messages = [];
  const parser = new JsonStreamParser((message) => messages.push(message));
  parser.push('{"Event":"ClockUpdatedSeconds","Data":{"Time');
  parser.push('Seconds":42}}{"Event":"MatchEnded","Data":{"WinnerTeamNum":0}}');
  assert.equal(messages.length, 2);
  assert.equal(messages[0].Data.TimeSeconds, 42);
  assert.equal(messages[1].Event, 'MatchEnded');
});

test('Stats API string Data payload is normalized', () => {
  const envelope = normalizeEnvelope({ Event: 'UpdateState', Data: '{"MatchGuid":"abc"}' });
  assert.deepEqual(envelope, { Event: 'UpdateState', Data: { MatchGuid: 'abc' } });
});

test('invalid connection settings fall back to safe ports', () => {
  const settings = normalizeSettings({ enabled: true, source: 'remote', bridgePort: 99999 });
  assert.equal(settings.bridgePort, 3175);
  assert.equal(settings.source, 'remote');
  assert.equal(normalizeSettings({ updateIntervalMs: 0 }).updateIntervalMs, 1);
  assert.equal(normalizeSettings({ updateIntervalMs: 75 }).updateIntervalMs, 50);
});

test('UpdateState delivery follows the configured interval', () => {
  const events = [];
  const service = new RocketLeagueService({ onEvent: (event) => events.push(event) });
  service.settings = normalizeSettings({ updateIntervalMs: 50 });
  service.ingest({ Event: 'UpdateState', Data: {} }, 'test');
  service.ingest({ Event: 'UpdateState', Data: {} }, 'test');
  assert.equal(events.length, 1);
  service.lastTickSent -= 50;
  service.ingest({ Event: 'UpdateState', Data: {} }, 'test');
  assert.equal(events.length, 2);
  service.stop();
});

test('simulator emits an immediately usable match state', () => {
  const events = [];
  const service = new RocketLeagueService({ onEvent: (event) => events.push(event) });
  service.startSimulator();
  assert.deepEqual(events.slice(0, 2).map((event) => event.Event), ['MatchCreated', 'UpdateState']);
  assert.equal(events[1].Data.Players.length, 6);
  assert.equal(service.status.state, 'simulating');
  service.stop();
});

test('remote receiver accepts the matching bridge key', async () => {
  const events = [];
  let listening;
  const ready = new Promise((resolve) => { listening = resolve; });
  const service = new RocketLeagueService({
    onEvent: (event) => events.push(event),
    onStatus: (status) => { if (status.state === 'listening') listening(); }
  });
  service.configure({ enabled: true, source: 'remote', bridgePort: 43175, bridgeToken: 'test-key' });
  await ready;
  const socket = new WebSocket('ws://127.0.0.1:43175/rocket-league?token=test-key');
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'telemetry', event: { Event: 'ClockUpdatedSeconds', Data: { TimeSeconds: 88 } } }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(events[0].Data.TimeSeconds, 88);
  socket.close();
  service.stop();
});
