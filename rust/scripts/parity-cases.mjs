// Parity cases for the Rust port: runs the REAL JS controller code on a list of cases and writes
// what it did (resulting state / result / error). tests/parity.rs runs the same cases through the
// Rust port and compares the JSON. Cases cover every Companion action + variables + tags.
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..', 'src');
const { createInitialState } = await import(join(src, 'game-config.js'));
const { applyCompanionAction } = await import(join(src, 'companion-actions.js'));
const { tagSimilarity } = await import(join(src, 'overwatch-ocr-panel.js'));
const { buildCompanionVariables, buildStageVariables, buildCompanionCapabilities } = await import(join(here, '..', '..', 'electron', 'companion-api-service.cjs')).then((m) => m.default || m);

const NOW = 1_800_000_000_000;
Date.now = () => NOW;
const clone = (v) => JSON.parse(JSON.stringify(v));
// Only what an action changed, as JSON-pointer -> new value (keeps the fixture small).
function diff(a, b, path = '', out = {}) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  const obj = (x) => x && typeof x === 'object';
  if (!obj(a) || !obj(b) || Array.isArray(a) !== Array.isArray(b)) { out[path] = b === undefined ? '__removed__' : b; return out; }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${path}/${String(k).replace(/~/g, '~0').replace(/\//g, '~1')}`, out);
  return out;
}
function base(game) {
  const s = createInitialState(); delete s.updatedAt; s.updatedAt = '2026-10-15T00:00:00.000Z';
  if (game) s.selectedGame = game;
  return s;
}
// a richer state: live VALORANT board + rosters with stations, RL live feed, OW OCR
function rich() {
  const s = base('valorant');
  const v = s.games.valorant;
  v.rosters.varsity[0] = { ...v.rosters.varsity[0], handle: 'Sn0wfal', stageStation: '1' };
  v.rosters.varsity[1] = { ...v.rosters.varsity[1], handle: 'BaldReaper', stageStation: 2 };
  v.awayRosters.varsity[0] = { ...v.awayRosters.varsity[0], handle: 'santi', stageStation: '6' };
  v.valorantBoard = { live: { teams: { home: { players: [{ name: 'SnOwfal', agent: 'viper', kills: 12, deaths: 3, assists: 4 }, { name: 'baldreaper', agent: 'kay-o', kills: '7', deaths: null, assists: '' }] }, away: { players: [{ name: 'santi', agent: 'jett', kills: 9, deaths: 9, assists: 1 }] } }, blocks: { top: 'away', bottom: 'home' } } };
  v.teams[0].detailScore = 13; v.teams[1].detailScore = 11;
  v.valorantRoundOverride = { 0: 20 };
  v.valorantOcr = v.valorantOcr || {};
  const rl = s.games.rocketleague;
  rl.rocketLeague.live = { status: 'connected', dataAgeMs: 100, arena: 'Stadium_P', timeSeconds: 0, overtime: true, overtimeSeconds: 47.9, packetRate: 30, packets: 999,
    players: [{ id: 'b', name: 'Bob', teamNum: 0, shortcut: 2, boost: 33, goals: 1, spectated: true, score: 300 }, { id: 'a', name: 'Al', teamNum: 0, shortcut: 1, boost: null }, { id: 'c', name: 'Cy', teamNum: 1, shortcut: 5, goals: '2' }] };
  rl.rosters.varsity[0] = { ...rl.rosters.varsity[0], handle: 'Bob', stageStation: 3 };
  rl.teams[0].detailScore = 2; rl.teams[1].detailScore = 1;
  const ow = s.games.overwatch;
  ow.overwatchOcr = { live: { teams: { home: { players: [{ name: 'Tanky', hero: 'Reinhardt', elims: 20, deaths: 5, assists: 3, damage: 9000, healing: 0, mitigation: 12000 }] }, away: { players: [] } } } };
  ow.rosters.varsity[0] = { ...ow.rosters.varsity[0], handle: 'Tanky', stageStation: 4 };
  s.displays.stations[3] = { preset: 'banner', team: 'weird' };
  return s;
}
const A = (o) => o;
const cases = [];
const states = { base: base(), val: base('valorant'), rich: rich(), rl: { ...rich(), selectedGame: 'rocketleague' }, ow: { ...rich(), selectedGame: 'overwatch' }, smash: base('smash') };
const reqs = [
  { action: 'score.increment', team: 'home' }, { action: 'score.increment', team: 1, amount: '3' }, { action: 'score.increment', team: 'home', amount: 2.5 },
  { action: 'score.increment', team: 'nobody' }, { action: 'score.increment', team: 'away', amount: 'x' },
  { action: 'score.decrement', team: 'away' }, { action: 'score.set', team: '0', value: 99 }, { action: 'score.set', team: 'home' },
  { action: 'detail_score.increment', team: 'away', amount: 4 }, { action: 'detail_score.decrement', team: 'home', amount: 50 }, { action: 'detail_score.set', team: 'away', value: '7.5' },
  { action: 'match.next' }, { action: 'scores.reset' },
  { action: 'teams.swap' }, { action: 'game.select', game: 'smash' }, { action: 'game.select', game: 'tetris' }, { action: 'game.select' },
  { action: 'output.select', output: 'roster' }, { action: 'output.select', name: 'clean' }, { action: 'output.select', output: 'tv' },
  { action: 'map.activate', number: 2 }, { action: 'map.activate', number: 99 }, { action: 'map.activate' },
  { action: 'map.winner.set', number: 1, team: 'away' }, { action: 'map.winner.set', number: 1, team: 'clear' }, { action: 'map.winner.set', number: 2, team: null },
  { action: 'maps.reset' }, { action: 'veto.reset' }, { action: 'overwatch.ban', team: 'home', hero: 'mercy' }, { action: 'overwatch.ban', side: 'away', hero: '' },
  { action: 'overwatch.ban', team: 'home', hero: 'Pikachu' }, { action: 'overwatch.ban', team: 'mid' },
  { action: 'statcards.set', value: 'hide' }, { action: 'statcards.set' }, { action: 'statcards.set', game: 'overwatch', mode: 'show' }, { action: 'statcards.set', game: 'smash' }, { action: 'statcards.set', value: 'sideways' },
  { action: 'display.preset', preset: 'banner' }, { action: 'display.preset', preset: 'player', station: 3, team: 'home' }, { action: 'display.preset', preset: 'score', station: '6-10' },
  { action: 'display.preset', preset: 'nope' }, { action: 'display.preset', preset: 'idle', station: 11 }, { action: 'display.preset', preset: 'idle', team: 'left' },
  { action: 'fly' }, {}, { action: 'score.increment', team: 'home', game: 'tetris' },
];
for (const [sn, st] of Object.entries(states)) for (const r of reqs) {
  const s = clone(st); let result = null; let error = null;
  try { result = applyCompanionAction(s, clone(r)); } catch (e) { error = { message: e.message, status: e.statusCode || 400 }; }
  cases.push({ kind: 'action', state: sn, request: r, changes: diff(JSON.parse(JSON.stringify(st)), JSON.parse(JSON.stringify(s))), result: result && JSON.parse(JSON.stringify(result)), error });
}
// a chain: a whole VALORANT series driven by actions (state carried over)
{ const s = clone(states.rich); const seq = [{ action: 'detail_score.set', team: 'home', value: 13 }, { action: 'match.next' }, { action: 'teams.swap' }, { action: 'detail_score.increment', team: 'away', amount: 13 }, { action: 'match.next' }, { action: 'map.winner.set', number: 3, team: 'home' }, { action: 'scores.reset' }];
  const steps = []; for (const r of seq) { let error = null; try { applyCompanionAction(s, r); } catch (e) { error = e.message; } steps.push({ request: r, after: JSON.parse(JSON.stringify(s)), error }); }
  const final = steps.at(-1).after; for (const st of steps) delete st.after;
  cases.push({ kind: 'chain', state: 'rich', steps, final }); }
for (const [sn, st] of Object.entries(states)) cases.push({ kind: 'variables', state: sn, variables: buildCompanionVariables(st), capabilities: buildCompanionCapabilities(st) });
const stageStatus = { onlineCount: 2, stations: [{ station: 1, online: true, mode: 'ndi', state: 'receiving', hostname: 'ST1', noise: true, noiseState: 'playing' }, { station: '2', online: true, mode: 'mirror' }, { station: 3, online: false, mode: 'ndi' }], spectated: { name: 'Sn0wfal', station: '1', side: 'home', team: 'IDAHO STATE', receivedAt: NOW - 500 } };
cases.push({ kind: 'stage', state: 'rich', status: stageStatus, variables: buildStageVariables(stageStatus, states.rich) });
cases.push({ kind: 'stage', state: 'base', status: { spectated: { name: 'x', receivedAt: NOW - 20000 } }, variables: buildStageVariables({ spectated: { name: 'x', receivedAt: NOW - 20000 } }, states.base) });
const pairs = [['Sn0wfal', 'SnOwfal'], ['BaldReaper', 'baldreaper'], ['Lúcio', 'LUCIO'], ['', 'x'], ['LCU nyv', 'lcu_nyv'], ['Sova', 'Nova'], ['ab#c', 'ABC'], ['Ishnarb', 'Ishnarbb'], ['Mexican Sova', 'mexicansova'], ['ẞtraße', 'STRASSE']];
cases.push({ kind: 'tags', pairs: pairs.map(([a, b]) => [a, b, tagSimilarity(a, b)]) });
writeFileSync(join(here, '..', 'crates', 'isu-core', 'tests', 'parity-cases.json'), JSON.stringify({ now: NOW, states, cases }));
console.log(cases.length, 'cases');
