// Parity for isu-core::rocket_league: runs the REAL src/app.js handleRocketLeagueEvent (and the
// helpers it calls) on a scripted match with a fake clock. app.js is a browser module, so the
// needed functions are cut out of its source text and evaluated with the real imports.
// Writes rust/crates/isu-core/tests/parity-rl-live.json.   node rust/scripts/parity-rl-live.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)); const repo = join(here, '..', '..');
const app = readFileSync(join(repo, 'src/app.js'), 'utf8');
const cut = (name) => { const m = app.match(new RegExp(`\\n(async )?function ${name}\\([^]*?\\n\\}\\n`)); if (!m) throw new Error(name); return m[0]; };
const consts = app.match(/const ROCKET_LEAGUE_EVENT_BADGE_MS[^]*?\n\];\n/)[0];
const gc = await import(join(repo, 'src/game-config.js'));
const ca = await import(join(repo, 'src/companion-actions.js'));
const lo = await import(join(repo, 'src/rl-loadout.js'));
const rs = await import(join(repo, 'src/rl-roster-sync.js'));
let NOW = 1_800_000_000_000; Date.now = () => NOW;
const state = gc.createInitialState(); state.selectedGame = 'rocketleague';
const rlState = state.games.rocketleague; Object.assign(rlState.rocketLeague, { syncClock: true, syncGoals: true, syncPlayers: true, autoRoster: true, autoSeriesScore: true, autoAdvance: true, blueTeam: 1 });
rlState.rocketLeague.carRenderer = { enabled: true, renders: { 'body:octane': { url: '/a/octane.png' } } };
rlState.rosters.varsity[0] = { ...rlState.rosters.varsity[0], handle: '[ISU] BengalOne', stageStation: '1' };
const log = []; const renders = []; let advanceLater = 0;
const src = `${consts}
${['mapRocketLeagueTeam', 'applyRocketLeagueScores', 'updateRocketLeagueOvertime', 'rocketLeaguePlayerId', 'normalizeLivePlayers', 'rocketLeaguePlayerStatSnapshot', 'updateRocketLeagueRecentEvents', 'syncRosterFromLive', 'handleRocketLeagueEvent', 'seriesLength', 'seriesTarget', 'visibleMapRows'].map(cut).join('\n')}
return handleRocketLeagueEvent;`;
const handle = new Function('state', 'GAME_CONFIGS', 'rocketLeagueArenaName', 'normalizeLoadout', 'updateCarArt', 'syncRosterSides', 'createPlayer', 'saveLastGameStats', 'commit', 'persistState', 'render', 'scheduleLiveUpdate', 'requestCarRender', 'window', src)(
  state, gc.GAME_CONFIGS, gc.rocketLeagueArenaName, lo.normalizeLoadout, lo.updateCarArt, rs.syncRosterSides, gc.createPlayer, ca.saveLastGameStats,
  (fn, msg) => { fn(); log.push(msg); }, () => {}, () => {}, () => { log.push('live'); }, (job) => renders.push(job.player.name), { setTimeout: () => { advanceLater += 1; } });
const P = (name, team, i, extra = {}) => ({ Name: name, PrimaryId: name === 'Bot' ? 'Unknown|0|0' : `Steam|${name}|0`, Shortcut: i, TeamNum: team, Loadout: ['Octane', 'decal', 'wheels'], Score: 0, Goals: 0, Assists: 0, Saves: 0, Shots: 0, Demos: 0, Boost: 33, bDemolished: false, ...extra });
const players = (g1, a2, s3) => [P('BengalOne', 0, 1, { Goals: g1 }), P('Opp', 1, 4, { Saves: s3 }), P('Bot', 0, 2, { Assists: a2 }), P('NoLoad', 1, 5, { Loadout: ['none'] })];
const events = [
  { Event: 'MatchCreated', Data: { MatchGuid: 'G1' } },
  { Event: 'UpdateState', Data: { MatchGuid: 'G1', Players: players(0, 0, 0), Game: { TimeSeconds: 290, bOvertime: false, Arena: 'Stadium_P', Teams: [{ TeamNum: 0, Score: 0 }, { TeamNum: 1, Score: 0 }], Target: { Name: 'Opp' } } } },
  { Event: 'UpdateState', Data: { MatchGuid: 'G1', Players: players(1, 1, 0), Game: { TimeSeconds: 200, Arena: 'Stadium_P', Teams: [{ TeamNum: 0, Score: 1 }, { TeamNum: 1, Score: 0 }], Target: { Name: 'BengalOne' } } }, dt: 1000 },
  { Event: 'ClockUpdatedSeconds', Data: { TimeSeconds: 12, bOvertime: true }, dt: 3000 },
  { Event: 'UpdateState', Data: { MatchGuid: 'G1', Players: players(1, 1, 2), Game: { TimeSeconds: 30, bOvertime: true, bReplay: true, Arena: 'Stadium_P', Teams: [{ TeamNum: 0, Score: 1 }, { TeamNum: 1, Score: 1 }] } }, dt: 7000 },
  { Event: 'MatchEnded', Data: { MatchGuid: 'G1', WinnerTeamNum: 0 } },
  { Event: 'MatchEnded', Data: { MatchGuid: 'G1', WinnerTeamNum: 0 } },
  { Event: 'MatchEnded', Data: { MatchGuid: 'G2' } },
  { Event: 'Junk', Data: {} },
];
const steps = [];
for (const e of events) { NOW += e.dt || 500; log.length = 0; renders.length = 0; const before = advanceLater; handle({ Event: e.Event, Data: e.Data }); steps.push({ event: { Event: e.Event, Data: e.Data }, now: NOW, log: [...log], renders: [...renders], advanceLater: advanceLater > before, game: JSON.parse(JSON.stringify(state.games.rocketleague)) }); }
const initial = gc.createInitialState(); initial.selectedGame = 'rocketleague'; Object.assign(initial.games.rocketleague.rocketLeague, { syncClock: true, syncGoals: true, syncPlayers: true, autoRoster: true, autoSeriesScore: true, autoAdvance: true, blueTeam: 1 });
initial.games.rocketleague.rocketLeague.carRenderer = { enabled: true, renders: { 'body:octane': { url: '/a/octane.png' } } };
initial.games.rocketleague.rosters.varsity[0] = { ...initial.games.rocketleague.rosters.varsity[0], handle: '[ISU] BengalOne', stageStation: '1' };
delete initial.updatedAt;
const names = [['[ISU] BengalOne', 'bengalone'], ['ISUBengal', 'Bengal'], ['Jäger', 'jager'], ['(x)abc', 'abc'], ['a', 'b'], ['', 'x'], ['Flip F17', 'flipf17'], ['D3RK_99', 'D3RK99']].map(([a, b]) => [a, b, rs.nameSimilarity(a, b), rs.normalizeGamerName(a)]);
writeFileSync(join(repo, 'rust/crates/isu-core/tests/parity-rl-live.json'), JSON.stringify({ initial, steps, names }));
console.log(steps.length, 'steps');
