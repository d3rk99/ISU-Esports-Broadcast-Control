// Parity for isu-core::roster_manager: the REAL src/roster-manager.js on a scripted session (ids made
// deterministic by fixing Date.now / Math.random). Writes tests/parity-roster-manager.json.
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)); const repo = join(here, '..', '..');
const R = await import(join(repo, 'src/roster-manager.js'));
const gc = await import(join(repo, 'src/game-config.js'));
const O = await import(join(repo, 'src/overwatch-ocr-panel.js'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const config = gc.GAME_CONFIGS.valorant; const emptyPlayer = (i) => gc.createPlayer(config, i);
const out = { bulk: [], steps: [], isu: [], links: [] };
for (const t of ['Sn0wfal, Sam Snow, starter\nBaldReaper\tBob Reap\t6th\nnewx;;sub;jv\nCoachK, Kim Coach, coach\n\n', '  , \n, Only Name, C, V\n  spaced   tag  ,  x  ,  Sixth Man , Junior Varsity', 'a,b,start\r\nc,,bench,6', ''])
  out.bulk.push({ text: t, rows: R.parseBulk(t) });
const game = gc.createGameState('valorant');
const step = (label, fn) => { const r = fn(); out.steps.push({ label, result: r === undefined ? null : clone(r), game: clone({ rosterLibrary: game.rosterLibrary, rosterAssign: game.rosterAssign, rosters: game.rosters, awayRosters: game.awayRosters, teams: game.teams, coaches: game.coaches ?? null, showAwayRoster: game.showAwayRoster }) }); };
out.start = clone(game);
// the Rust side rebuilds the library from these snapshots, so ids don't need to be deterministic
const isu = R.createTeam(game, { name: 'IDAHO STATE', shortName: 'isu', isISU: true });
R.bulkAdd(isu, 'Sub1,,sub\nSn0wfal,,starter\nCoachK,,coach\nSixth,,6th\nA,,starter\nB,,starter\nC,,starter\nD,,starter\nJv1,,starter,jv');
const opp = R.createTeam(game, { name: 'LCU', shortName: 'lcu' });
R.bulkAdd(opp, 'santi,,starter\nLCU nyv,,starter');
step('library built', () => R.ensureLibrary(game) && null);
step('load ISU away', () => R.loadTeamIntoMatch(game, 'away', isu.id, { emptyPlayer }));
step('load LCU home', () => R.loadTeamIntoMatch(game, 'home', opp.id, { emptyPlayer }));
step('isu side', () => R.isuSide(game));
game.awayRosters.varsity[0].character = 'Viper'; game.awayRosters.varsity[0].stageStation = '3'; game.awayRosters.varsity[1].playerImage = '/x.png';
step('write back', () => R.writeBackFromMatch(game, 'away'));
step('set status', () => R.setForPlayers(isu, [isu.players[0].id, isu.players[3].id], 'status', 'starter'));
step('reload ISU away', () => R.loadTeamIntoMatch(game, 'away', isu.id, { emptyPlayer }));
step('remove', () => R.removePlayers(isu, [isu.players[1].id]));
step('sorted jv', () => R.sortedPlayers(isu, 'jv').map((p) => p.handle));
step('sorted all', () => R.sortedPlayers(isu).map((p) => p.handle));
for (const teams of [[{ shortName: 'ISU' }, { shortName: 'X' }], [{ shortName: 'X' }, { name: 'idaho state uni' }], [{ shortName: 'ISUX' }, { shortName: 'my isu' }], [{}, {}], [{ shortName: 'A ISU B' }, {}]]) {
  const g = { teams, rosterAssign: { home: '', away: '' }, rosterLibrary: { teams: [] } }; out.isu.push({ teams, side: R.isuSide(g) });
}
out.links.push({ roster: [{ handle: 'Sn0wfal' }, { handle: 'BaldReaper' }, { handle: 'Nobody' }, {}], board: [{ name: 'Sn0wfa1', row: 2, block: 'bottom', agent: 'jett' }, { name: 'BaldReaper', row: 0 }, { name: '' }], result: [...R.liveLinks([{ handle: 'Sn0wfal' }, { handle: 'BaldReaper' }, { handle: 'Nobody' }, {}], [{ name: 'Sn0wfa1', row: 2, block: 'bottom', agent: 'jett' }, { name: 'BaldReaper', row: 0 }, { name: '' }], O.tagSimilarity).entries()] });
out.uid = { p: 'p', now: 1800000000000, rand: 0.123456789 };
{ const realNow = Date.now; const realR = Math.random; Date.now = () => 1800000000000; Math.random = () => 0.123456789; const t = R.createTeam({}, {}); out.uid.id = t.id; Date.now = realNow; Math.random = realR; }
writeFileSync(join(repo, 'rust/crates/isu-core/tests/parity-roster-manager.json'), JSON.stringify(out));
console.log('steps', out.steps.length, 'uid', out.uid.id);
