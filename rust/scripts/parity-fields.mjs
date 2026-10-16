// Parity for isu-core::controls::set_field: the REAL app.js 'change' handler branches for map rows,
// veto, roster players, away-roster toggle and roster first side (cut out of the text), on every game.
// Writes rust/crates/isu-core/tests/parity-fields.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)); const repo = join(here, '..', '..');
const app = readFileSync(join(repo, 'src/app.js'), 'utf8');
const lines = app.split('\n');
const from = (re) => lines.findIndex((l) => re.test(l));
const block = (startRe) => { const a = from(startRe); let depth = 0, b = a; for (; b < lines.length; b++) { for (const ch of lines[b]) { if (ch === '{') depth++; if (ch === '}') depth--; } if (depth === 0 && b > a) break; } return lines.slice(a, b + 1).join('\n'); };
const branches = [/if \(target\.dataset\.rosterFirstSide !== undefined\)/, /if \(target\.dataset\.awayRosterToggle !== undefined\)/, /if \(target\.dataset\.mapIndex !== undefined\)/, /if \(target\.dataset\.vetoBan !== undefined\)/, /if \(target\.dataset\.vetoPick !== undefined\)/, /if \(target\.dataset\.player !== undefined\)/].map(block).join('\n');
const gc = await import(join(repo, 'src/game-config.js'));
const R = await import(join(repo, 'src/roster-manager.js'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const body = `${['activeRosterCollection'].map((n) => app.match(new RegExp(`\\nfunction ${n}\\([^]*?\\n\\}\\n`))[0]).join('\n')}
const current = () => state.games[state.selectedGame];
return (target) => { let msg = null; const commit = (fn, m = null) => { fn(); msg = m; }; const render = () => {}; const publishValorantBoard = () => {};
  (() => { ${branches} })(); return msg; };`;
const out = { sessions: [] };
for (const game of gc.GAME_ORDER) {
  const state = gc.createInitialState(); delete state.updatedAt; state.selectedGame = game;
  const g = state.games[game];
  const isu = R.createTeam(g, { name: 'IDAHO STATE', isISU: true }); R.bulkAdd(isu, 'Sn0wfal,,starter\nB,,starter'); R.loadTeamIntoMatch(g, 'home', isu.id, { emptyPlayer: (i) => gc.createPlayer(gc.GAME_CONFIGS[game], i) });
  const start = clone(state);
  const handle = new Function('state', 'writeBackFromMatch', body)(state, R.writeBackFromMatch);
  const t = (dataset, value, extra = {}) => ({ dataset, value, type: 'text', checked: false, ...extra });
  const script = [
    ['mapProp', 0, 'mode', 'Control'], ['mapProp', 0, 'map', 'Ascent'], ['mapProp', 1, 'map', 'Bind'], ['mapScore', 0, 0, '13'], ['mapScore', 0, 1, '7'],
    ['vetoBan', 0, 'Lotus'], ['vetoPick', 2, 'map', 'Haven'], ['vetoPick', 1, 'attackers', '1'], ['vetoPick', 0, 'attackers', 'x'],
    ['player', 0, 'name', 'Sam Snow'], ['player', 1, 'stageStation', '4'], ['player', 0, 'character', 'Jett'],
    ['away', true], ['firstSide', 'away'], ['away', false], ['firstSide', 'home'], ['away', false]];
  const steps = [];
  for (const s of script) {
    let target;
    const [k, ...a] = s;
    if (k === 'mapProp') target = t({ mapIndex: String(a[0]), mapProp: a[1] }, a[2]);
    if (k === 'mapScore') target = t({ mapIndex: String(a[0]), mapScore: String(a[1]) }, a[2]);
    if (k === 'vetoBan') target = t({ vetoBan: String(a[0]) }, a[1]);
    if (k === 'vetoPick') target = t({ vetoPick: String(a[0]), vetoProp: a[1] }, a[2]);
    if (k === 'player') target = t({ player: String(a[0]), playerProp: a[1] }, a[2]);
    if (k === 'away') target = t({ awayRosterToggle: '' }, '', { type: 'checkbox', checked: a[0] });
    if (k === 'firstSide') target = t({ rosterFirstSide: '' }, a[0]);
    if ((k === 'vetoBan' || k === 'vetoPick') && !state.games[game].veto) { steps.push({ step: s, skip: true }); continue; }
    let msg, err = null;
    try { msg = handle(target); } catch (e) { err = String(e.message); }
    steps.push({ step: s, msg: msg ?? null, err, state: clone(state) });
  }
  out.sessions.push({ game, start, steps });
}
writeFileSync(join(repo, 'rust/crates/isu-core/tests/parity-fields.json'), JSON.stringify(out));
console.log(out.sessions.map((s) => `${s.game}:${s.steps.filter((x) => x.err).length} errors`).join(' '));
