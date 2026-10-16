// Parity for isu-net: the REAL JS spectate-state.cjs (candidates, sides, resolve), rocket-league-
// service.cjs (normalizeSettings, JsonStreamParser, normalizeEnvelope, simulator ticks) and
// spectate-receiver.cjs (normalizeSettings, setCandidates cleaning).
// Writes rust/crates/isu-net/tests/parity-net.json.   node rust/scripts/parity-net.cjs
const path = require('node:path'); const fs = require('node:fs');
const repo = path.join(__dirname, '..', '..');
const SS = require(path.join(repo, 'electron/spectate-state.cjs'));
const RL = require(path.join(repo, 'electron/rocket-league-service.cjs'));
const SR = require(path.join(repo, 'electron/spectate-receiver.cjs'));
const { createInitialState } = { createInitialState: null };
const out = { states: [], rlSettings: [], streams: [], envelopes: [], sim: [], recvSettings: [], recvCandidates: [] };
const base = (sel) => ({ selectedGame: sel, games: { valorant: { activeMap: 0, teams: [{ name: 'IDAHO STATE', detailScore: 7 }, { name: 'LCU', detailScore: 5 }], veto: { picks: [{ attackers: 0 }, { attackers: '1' }] },
  rosters: { varsity: [{ handle: 'Sn0wfal', stageStation: '1' }, { handle: 'BaldReaper', stageStation: 2 }, { handle: '', name: 'Newx Name', stageStation: 3 }, { handle: 'Dup' }, { handle: 'dup', stageStation: 9 }], jv: [{ handle: 'santi' }] },
  awayRosters: { varsity: [{ handle: 'santi', stageStation: 6 }, { handle: 'CWTJ' }], jv: [] },
  valorantBoard: { live: { teams: { home: { players: [{ name: 'SnOwfal', agent: 'viper' }, { name: 'baldreaper', agent: 'kay-o' }, { name: 'Ghost', agent: 'jett' }, { name: '' }] }, away: { players: [{ name: 'santi', agent: 'sova' }, { name: 'CWTJ', agent: 'omen' }] } }, blocks: { top: 'away', bottom: 'home' }, colors: { home: 'red', away: 'teal' }, match: { homeScore: 3, awayScore: 4 } } } },
  overwatch: { teams: [{ name: 'A' }, { name: 'B' }], rosters: { varsity: [{ handle: 'TANK 1', stageStation: 4 }], jv: [] }, awayRosters: { varsity: [], jv: [] }, overwatchOcr: { live: { teams: { home: { players: [{ name: 'TANK 1', hero: 'Rein' }] }, away: { players: [{ name: 'DPS 9' }] } } } } } } });
const variants = [];
variants.push(['valorant-full', base('valorant')]);
variants.push(['overwatch', base('overwatch')]);
{ const s = base('valorant'); delete s.games.valorant.valorantBoard.live.blocks; variants.push(['no-blocks', s]); }
{ const s = base('valorant'); delete s.games.valorant.valorantBoard.live.blocks; delete s.games.valorant.valorantBoard.live.match; s.games.valorant.teams[0].detailScore = 12; s.games.valorant.teams[1].detailScore = 13; variants.push(['overtime-26', s]); }
{ const s = base('valorant'); delete s.games.valorant.valorantBoard.live.blocks; s.games.valorant.valorantRoundOverride = { 0: 13 }; variants.push(['override-13', s]); }
{ const s = base('valorant'); delete s.games.valorant.valorantBoard.live.blocks; s.games.valorant.activeMap = 1; delete s.games.valorant.valorantBoard.live.match; s.games.valorant.teams[0].detailScore = 0; s.games.valorant.teams[1].detailScore = 0; variants.push(['map2-attackers-string', s]); }
variants.push(['rocketleague', { ...base('valorant'), selectedGame: 'rocketleague' }]);
for (const [name, st] of variants) {
  const sps = [{ name: 'snowfal', game: 'valorant', station: 99 }, { name: 'Ghost' }, { name: 'nobody', side: 'x' }, { name: '' }, { name: 'santi', game: 'overwatch' }];
  out.states.push({ name, state: st, candidates: SS.spectateCandidatesFrom(st), sides: SS.spectateSidesFrom(st), resolved: sps.map((sp) => ({ sp, out: SS.resolveSpectated(st, sp) })) });
}
for (const s of [{}, { enabled: 1, source: 'remote', transport: 'tcp', host: ' 10.0.0.5 ', tcpPort: '5000', webPort: 70000, bridgePort: 3175.5, bridgeToken: ' k ', updateIntervalMs: 0.4, extra: 'kept' }, { transport: 'carrier', updateIntervalMs: 'abc', host: '' }, { updateIntervalMs: 99 }])
  out.rlSettings.push({ in: s, out: RL.normalizeSettings(s) });
for (const chunks of [['{"Event":"A","Data":{}}{"Event":"B"'], [',"Data":{"x":"}{"}}junk{"Event":"C","Data":"{\\"q\\":1}"}'], ['garbage', '{"a":"\\"}"}', '{bad json}', '{"Event":"D"}']]) {
  const got = []; const p = new RL.JsonStreamParser((v) => got.push(v)); for (const c of chunks) p.push(c); out.streams.push({ chunks, values: got });
}
for (const m of [{ Event: 'UpdateState', Data: { a: 1 } }, { event: 'x', data: '{"b":2}' }, { Event: 'y', Data: 'nope' }, { Event: '', event: 'z' }, { Data: {} }, null, 'str', { Event: 7, Data: [1, 2] }, { Event: 'w', Data: null, data: { c: 3 } }])
  out.envelopes.push({ in: m, out: RL.normalizeEnvelope(m) });
// simulator: capture the ingested messages of a full run with a fake clock
{ const svc = new RL.RocketLeagueService({ onEvent: () => {}, onStatus: () => {} }); const seen = []; svc.ingest = (m) => seen.push(m);
  const realNow = Date.now; Date.now = () => 1700000000000; const realSI = global.setInterval; const realCI = global.clearInterval; let tick = null; let ended = false;
  global.setInterval = (f) => { tick = f; return 1; }; global.clearInterval = (t) => { if (t === 1) ended = true; };
  // fake timer: tick until the simulator clears its own interval (the MatchEnded tick), like the real one
  svc.startSimulator(); while (tick && !ended) tick(); global.setInterval = realSI; global.clearInterval = realCI; Date.now = realNow; svc.stop();
  out.sim = seen.filter((m, i) => i < 4 || m.Event !== 'UpdateState' || [14, 15, 29, 30, 100, 299].includes(300 - (m.Data?.Game?.TimeSeconds ?? -1)) || m.Data?.Game?.TimeSeconds === 0); out.simCount = seen.length; }
for (const s of [{}, { enabled: 'yes', port: '4000.4', token: '  key  ' }, { port: 80 }, { port: 'x', token: 'k'.repeat(300) }]) out.recvSettings.push({ in: s, out: SR.normalizeSettings(s) });
{ const r = new SR.SpectateReceiver(); const lists = [
  [[{ name: ' A ', station: '3', side: 'home', team: 'T'.repeat(70), agent: 'KAY/O kay-o!' }, { name: '' }, null, { name: 'B', side: 'x', station: 0 }], { red: 'home', teal: 'away', round: '13' }],
  [Array.from({ length: 45 }, (_v, i) => ({ name: `P${i}` })), { red: 'left' }],
  [[{ name: 'x'.repeat(50), station: 'NaN' }], null]];
  for (const [l, s] of lists) { const n = r.setCandidates(l, s); out.recvCandidates.push({ list: l, sides: s, n, candidates: r.candidates, sidesOut: r.sides }); } }
const GB = require(path.join(repo, 'electron/game-bridge.cjs'));
out.bridgeSettings = [{}, { game: 'valorant', graphicsHost: ' 10.0.0.2 ', bridgePort: '3175', bridgeToken: ' key ', spectate: { roi: { x: -5, y: 2000, w: 'abc' }, method: 'icon', windowName: 'VALORANT - Spectator', intervalMs: 50, portrait: { s: 999 } }, extra: 1 },
  { game: 'overwatch', spectate: { method: 'icon' } }, { game: 'tetris', rocketLeague: { transport: 'tcp', host: '1.2.3.4', tcpPort: 1 } }, { game: 'rocketleague', transport: 'websocket', webPort: 5000 }]
  .map((s) => ({ in: s, out: GB.normalizeBridgeSettings(s) }));
out.envelopes2 = [GB.createGameEnvelope('rocketleague', { a: 1 }, 7, 123), GB.createGameEnvelope('valorant', {}, 1, 5)];
fs.mkdirSync(path.join(__dirname, '..', 'crates', 'isu-net', 'tests'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'crates', 'isu-net', 'tests', 'parity-net.json'), JSON.stringify(out));
console.log('states', out.states.length, 'sim messages', out.simCount);
