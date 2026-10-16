// Parity for isu-core::boards: the REAL src/valorant-board-teams.js, valorant-board-panel.js
// (syncValorantRoster), overwatch-ocr-panel.js (syncRosterFromOcr) and the VALORANT round timeline
// of src/app.js (cut out of its text like parity-rl-live.mjs). Writes tests/parity-boards.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)); const repo = join(here, '..', '..');
const T = await import(join(repo, 'src/valorant-board-teams.js'));
const V = await import(join(repo, 'src/valorant-board-panel.js'));
const O = await import(join(repo, 'src/overwatch-ocr-panel.js'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const out = { teams: [], vsync: [], osync: [], timeline: [], slugs: [] };
const row = (name, agent) => ({ name, agent, kills: 1 });
const board = (top, bottom, colors = {}) => ({ teams: { home: { players: top.map((n) => row(n, 'jett')) }, away: { players: bottom.map((n) => row(n, 'sova')) } }, colors, match: null });
const isu = ['Sn0wfal', 'BaldReaper', 'newx', 'Eagl3', 'Ishnarb']; const lcu = ['santi', 'LCU glowstick', 'LCU nyv', 'CWTJ', 'LCU Mexican Sova']; const empty = ['', '', '', '', ''];
const game = (extra = {}) => ({ teams: [{ name: 'IDAHO STATE', detailScore: 0 }, { name: 'LCU', detailScore: 0 }], activeMap: 0, rosters: { varsity: isu.map((handle) => ({ handle })), jv: [] }, awayRosters: { varsity: [], jv: [] }, veto: { picks: [{ map: 'Ascent', attackers: 0 }, { attackers: '1' }] }, ...extra });
const cases = [
  [game(), board(lcu, isu)], [game(), board(isu, lcu)], [game(), board(['santi', 'x', 'y', 'z', 'w'], ['Sn0wfa1', 'BaldReapr', 'newx', 'Eag13', 'Ishnarb'])],
  [game(), board(empty, empty, { home: 'red', away: 'teal' })], [game({ veto: { picks: [{ attackers: 1 }] } }), board(empty, empty, { home: 'red', away: 'teal' })],
  [game({ teams: [{ detailScore: 7 }, { detailScore: 5 }] }), board(empty, empty, { home: 'red', away: 'teal' })], [game({ teams: [{ detailScore: 12 }, { detailScore: 13 }] }), board(empty, empty, { away: 'teal' })],
  [game({ valorantRoundOverride: { 0: 13 } }), board(empty, empty, { home: 'teal' })], [game({ activeMap: 1, teams: [{ detailScore: 0 }, { detailScore: 0 }] }), board(empty, empty, { home: 'red' })],
  [game({ veto: { picks: [] } }), board(empty, empty)], [game(), { foo: 1 }],
];
for (const [g, b] of cases) for (const prev of [null, { top: 'away' }]) out.teams.push({ game: g, board: b, prev, round: T.currentRound(g), attacking: T.attackingTeamNow(g), result: T.mapBoardToTeams(g, b, prev) });
// syncValorantRoster
const vgames = [
  { rosters: { varsity: [{ handle: 'Sn0wfal', character: '', role: '' }, { handle: 'BaldReaper' }, { handle: '', name: '' }] }, awayRosters: { varsity: [] }, valorantBoard: { live: { teams: { home: { players: [{ name: 'SnOwfal', agent: 'viper' }, { name: 'baldreaper', agent: 'kay-o' }, { name: 'Ishnarb', agent: 'sova' }] }, away: { players: [] } } } } },
  { rosters: { varsity: [{ handle: '' }, { handle: '' }, { handle: '' }] }, awayRosters: { varsity: [{ handle: 'x', autoAdded: true }, { handle: '' }] }, valorantBoard: { live: { teams: { home: { players: [{ name: 'Ishnarb', agent: 'sova' }, { name: 'newx', agent: 'jett' }, { name: 'Ishnarbb', agent: 'sova' }] }, away: { players: [{ name: 'santi', agent: 'omen' }, { name: 'xx', agent: 'nope' }] } } } } },
  { rosters: { varsity: [] }, awayRosters: {} }];
for (const g of vgames) { const c = clone(g); const ch = V.syncValorantRoster(c, 'varsity'); out.vsync.push({ game: g, changes: ch, after: c }); }
const ogames = [{ rosters: { varsity: [{ handle: 'TANK 1' }, { handle: '' }, { handle: '' }] }, awayRosters: { varsity: [{ handle: '' }] }, overwatchOcr: { live: { teams: { home: { players: [{ name: 'TANK 1', hero: 'Reinhardt' }, { name: 'DPS 1', hero: 'Genji' }, { name: '', hero: 'Ana' }] }, away: { players: [{ name: 'SUP 1', hero: 'Lúcio' }, { name: 'SUP 2', hero: 'Mercy' }] } } } } }];
for (const g of ogames) for (const fill of [true, false]) { const c = clone(g); const ch = O.syncRosterFromOcr(c, 'varsity', { fillEmpty: fill }); out.osync.push({ game: g, fill, changes: ch, after: c }); }
// round timeline from src/app.js
const app = readFileSync(join(repo, 'src/app.js'), 'utf8');
const cut = (name) => app.match(new RegExp(`\\nfunction ${name}\\([^]*?\\n\\}\\n`))[0];
let NOW = 1_800_000_000_000; Date.now = () => NOW;
const state = { games: { valorant: { teams: [{ detailScore: 0 }, { detailScore: 0 }], activeMap: 0, valorantOcr: { live: {} }, valorantRoundOverride: { 0: 5 } } } };
const tl = new Function('state', `${['liveValorantScore', 'emptyValorantTimelineRound', 'ensureValorantRoundTimeline', 'refreshValorantTimelineCurrentRound', 'resetValorantRoundHistory', 'valorantRoundSwapped', 'valorantRoleFor', 'markValorantRoundWinner', 'syncValorantRoundHistoryFromScore', 'syncValorantOcrScores'].map(cut).join('\n')} return { syncValorantOcrScores, resetValorantRoundHistory };`)(state);
const seq = [[0, 0], [1, 0], [1, 0], [5, 0], [1, 1], [3, 2], [3, 4], [12, 11], [13, 11], [13, 13], [14, 13], [null, 3], [25, 0], 'reset', [0, 0], [1, 1]];
for (const s of seq) {
  NOW += 1000;
  if (s === 'reset') { tl.resetValorantRoundHistory(); out.timeline.push({ step: 'reset', now: NOW, game: clone(state.games.valorant) }); continue; }
  const snap = { teams: { home: { score: s[0] }, away: { score: s[1] } } };
  const changed = tl.syncValorantOcrScores(snap);
  out.timeline.push({ step: snap, now: NOW, changed, game: clone(state.games.valorant) });
}
out.timelineStart = { teams: [{ detailScore: 0 }, { detailScore: 0 }], activeMap: 0, valorantOcr: { live: {} }, valorantRoundOverride: { 0: 5 } };
out.slugs = ['kay-o', 'jett', 'nope', ''].map((s) => [s, V.agentNameFromSlug(s)]);
writeFileSync(join(repo, 'rust/crates/isu-core/tests/parity-boards.json'), JSON.stringify(out));
console.log('teams', out.teams.length, 'timeline', out.timeline.length);
