const test = require('node:test');
const assert = require('node:assert/strict');
const {
  VALORANT_GAME_ID,
  ValorantService,
  createLiveState,
  mappedTeamKey,
  normalizeGameEvent,
  normalizeInfoUpdate,
  normalizeSettings
} = require('../electron/valorant-service.cjs');

test('VALORANT settings normalize booleans and stale interval', () => {
  const settings = normalizeSettings({ enabled: true, team0Home: false, staleMs: 100 });
  assert.equal(settings.enabled, true);
  assert.equal(settings.team0Home, false);
  assert.equal(settings.staleMs, 1000);
});

test('VALORANT team mapping keeps Home/Away independent from team IDs', () => {
  assert.equal(mappedTeamKey(0, { team0Home: true }), 'home');
  assert.equal(mappedTeamKey(1, { team0Home: true }), 'away');
  assert.equal(mappedTeamKey(0, { team0Home: false }), 'away');
  assert.equal(mappedTeamKey(1, { team0Home: false }), 'home');
});

test('VALORANT info updates normalize score, round, phase, map, roster, and observing player', () => {
  let live = createLiveState();
  live = normalizeInfoUpdate({
    info: {
      match_info: {
        map: 'Ascent',
        round_number: '7',
        round_phase: 'combat',
        match_score: '{"team_0":4,"team_1":2}',
        observing: 'Observer Target',
        roster_0: '{"name":"Bengal #ISU","player_id":"p1","character":"Phoenix","teammate":true,"local":true}'
      }
    },
    feature: 'match_info'
  }, live, { team0Home: true, syncScore: true, syncMap: true, syncRound: true, syncPhase: true, syncPlayers: true });

  assert.equal(live.match.map, 'Ascent');
  assert.equal(live.match.round, 7);
  assert.equal(live.match.phase, 'combat');
  assert.equal(live.teams.home.score, 4);
  assert.equal(live.teams.away.score, 2);
  assert.equal(live.observedPlayer, 'Observer Target');
  assert.equal(live.players[0].agent, 'Phoenix');
});

test('VALORANT malformed info data does not throw', () => {
  assert.doesNotThrow(() => normalizeInfoUpdate({
    info: { match_info: { match_score: '{not json', roster_0: '{bad' } },
    feature: 'match_info'
  }, createLiveState()));
});

test('VALORANT game events normalize match and spike states without spike timers', () => {
  let live = createLiveState();
  live = normalizeGameEvent({ events: [{ name: 'match_start', data: '' }] }, live);
  assert.equal(live.match.active, true);
  live = normalizeGameEvent({ events: [{ name: 'planted_location', data: 'A' }, { name: 'spike_defused', data: '' }] }, live);
  assert.equal(live.spike.site, 'A');
  assert.equal(live.spike.state, 'defused');
  assert.equal(Object.hasOwn(live.spike, 'timer'), false);
});

test('VALORANT service reports GEP unavailable in standard Electron', () => {
  const statuses = [];
  const service = new ValorantService({ app: {}, onStatus: (status) => statuses.push(status) });
  service.configure({ enabled: true });
  assert.equal(statuses.at(-1).status, 'unavailable');
  assert.equal(statuses.at(-1).gepAvailable, false);
  service.stop();
});

test('VALORANT simulator emits through the normalized pipeline', async () => {
  const events = [];
  const service = new ValorantService({ onEvent: (event) => events.push(event) });
  service.startSimulator();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(service.live.status, 'simulating');
  assert.equal(service.live.match.map, 'Ascent');
  assert.equal(service.live.teams.home.score, 0);
  assert.ok(events.some((event) => event.live?.match?.matchId?.startsWith('SIM-')));
  service.handleInfoUpdate(VALORANT_GAME_ID, { info: { match_info: { match_score: '{"team_0":2,"team_1":1}' } }, feature: 'match_info' });
  assert.equal(service.live.teams.home.score, 2);
  service.stop();
});
