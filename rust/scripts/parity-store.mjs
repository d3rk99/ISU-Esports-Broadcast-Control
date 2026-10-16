// Parity for isu-core::store: the REAL src/store.js loadState on saved documents (current, old,
// damaged, legacy). Writes rust/crates/isu-core/tests/parity-store.json.
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)); const repo = join(here, '..', '..');
const { loadState } = await import(join(repo, 'src/store.js'));
const { createInitialState } = await import(join(repo, 'src/game-config.js'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const base = () => { const s = createInitialState(); delete s.updatedAt; return s; };
const raws = [null, '', 'not json', '"x"', '{}', '{"version":5,"games":{}}', '{"version":1}', '{"version":2,"games":{}}', '{"version":3,"games":{"valorant":{"teams":[{"score":2}]}}}'];
const muts = [
  (s) => { s.games.valorant.teams[0].score = 2; },
  (s) => { delete s.games.valorant.rosterFirstSide; s.games.valorant.teams.reverse(); },
  (s) => { s.games.valorant.rosterFirstSide = 'nope'; s.games.valorant.teams[1].shortName = 'my ISU'; },
  (s) => { s.games.valorant.valorantOcr.enabled = true; s.games.valorant.valorantOcr.live = { junk: 1 }; },
  (s) => { s.games.rocketleague.rocketLeague.live = { players: [1] }; s.games.rocketleague.rocketLeague.syncGoals = false; },
  (s) => { s.games.rocketleague.characterArt = { Octane: { url: '/o.png', name: 'oct' }, Fennec: { url: '' } }; s.games.rocketleague.rosters.varsity[0].character = 'Octane'; s.games.rocketleague.rosters.varsity[1].character = 'Fennec'; s.games.rocketleague.rosters.jv[0] = { character: 'Octane', characterImage: '/mine.png' }; },
  (s) => { s.games.valorant.seriesLength = 4; s.games.valorant.activeMap = 99; s.games.valorant.mapRows = [{ map: 'Ascent', mode: 'bogus' }]; },
  (s) => { s.games.valorant.seriesLength = 'x'; s.games.valorant.activeMap = -3; delete s.games.valorant.match; },
  (s) => { s.games.valorant.veto.bans = ['Ascent', 'Ascent', '', 'Bind']; s.games.valorant.veto.picks = [{ map: 'Bind' }, { map: 'Lotus' }, { map: 'Lotus' }]; },
  (s) => { s.games.valorant.rosters.varsity = [{ handle: 'only' }]; s.games.valorant.awayRosters = null; s.games.valorant.rosters.jv = new Array(8).fill(null).map((_, i) => ({ handle: `j${i}` })); },
  (s) => { s.games.overwatch.characterArt = { Ana: { url: '/mine.png' } }; s.games.smash.characterArt = { Mario: { url: '/m.png' } }; s.games.smash.mapArt = { x: 1 }; s.games.overwatch.mapArt = null; },
  (s) => { delete s.games.smash; s.games.overwatch = null; },
  (s) => { s.programTransitionSeconds = 99; delete s.displays; s.version = 2; },
  (s) => { s.programTransitionSeconds = 0; s.extra = { keep: true }; },
  (s) => { s.displays = { stations: { 3: { preset: 'scoreboard' } } }; s.games.smash.teams = [{ name: 'X' }]; s.games.smash.rosterFirstSide = 'away'; },
];
const cases = raws.map((r) => ({ raw: r, out: loadState({ getItem: () => r }) }));
for (const m of muts) { const s = base(); m(s); const raw = JSON.stringify(s); cases.push({ raw, out: loadState({ getItem: () => raw }) }); }
for (const c of cases) delete c.out.updatedAt;
writeFileSync(join(repo, 'rust/crates/isu-core/tests/parity-store.json'), JSON.stringify(cases));
console.log(cases.length, 'cases');
