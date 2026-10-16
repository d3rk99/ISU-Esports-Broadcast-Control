// Parity for isu-core::controls: the REAL src/app.js click-handler `actions` object (cut out of the
// text) + syncFormat, on a long button session for every game. Writes tests/parity-controls.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)); const repo = join(here, '..', '..');
const app = readFileSync(join(repo, 'src/app.js'), 'utf8');
const cut = (name) => { const m = app.match(new RegExp(`\\nfunction ${name}\\([^]*?\\n\\}\\n`)); if (!m) throw new Error(name); return m[0]; };
const actionsSrc = app.match(/\n  const actions = \{\n[^]*?\n  \};\n/)[0];
const gc = await import(join(repo, 'src/game-config.js'));
const ca = await import(join(repo, 'src/companion-actions.js'));
let NOW = 1_800_000_000_000; Date.now = () => NOW;
const clone = (v) => JSON.parse(JSON.stringify(v));
const env = { GAME_CONFIGS: gc.GAME_CONFIGS, createPlayer: gc.createPlayer, createGameState: gc.createGameState, advanceGameMatch: ca.advanceGameMatch, swapGameTeams: ca.swapGameTeams, swapGameTeamsPreservingSideScores: ca.swapGameTeamsPreservingSideScores };
const helpers = ['seriesLength', 'seriesTarget', 'visibleMapRows', 'syncFormat', 'clearSeriesMapResults', 'activeRosterCollection', 'emptyValorantTimelineRound', 'ensureValorantRoundTimeline', 'resetValorantRoundHistory'].map(cut).join('\n');
const body = `${helpers}
return {
  click(action, index, winner) { const game = state.games[state.selectedGame]; const config = GAME_CONFIGS[state.selectedGame]; const button = { dataset: { action, winner: String(winner) } }; let msg = null;
    const commit = (fn, m = 'Changes saved') => { fn(); msg = m; };
    ${actionsSrc}
    actions[action]?.(); return msg; },
  format(len) { syncFormat(state.games[state.selectedGame], len); }
};`;
const mk = (state) => new Function('state', ...Object.keys(env), 'persistState', 'toast', 'history', body)(state, ...Object.values(env), () => {}, () => {}, []);
const out = { sessions: [] };
const script = [
  ['score-plus', 0], ['score-plus', 0], ['score-plus', 0], ['score-plus', 0], ['score-minus', 1], ['score-plus', 1], ['detail-plus', 0], ['detail-plus', 0], ['detail-minus', 1],
  ['map-winner', 0, 0], ['map-winner', 1, 1], ['map-winner', 1, 1], ['map-winner', 1, 0], ['activate-map', 2], ['format', 5], ['format', 3], ['format', 1],
  ['swap-teams', 0], ['next-match', 0], ['next-match', 0], ['detail-plus', 1], ['reset-scores', 0], ['score-plus', 1], ['clear-maps', 0], ['add-player', 0], ['remove-player', 0], ['reset-veto', 0], ['nope', 0], ['reset-game', 0]];
for (const game of gc.GAME_ORDER) {
  const state = gc.createInitialState(); delete state.updatedAt; state.selectedGame = game; state.activeRosterSide = 'away';
  state.games[game].teams[0].name = 'HOME'; state.games[game].rosters.varsity[0].handle = 'P1';
  const start = clone(state); const api = mk(state); const steps = [];
  for (const [a, i, w] of script) { NOW += 1000; let msg = null; if (a === 'format') { if (gc.GAME_CONFIGS[game].formatOptions?.includes(i) || game !== 'rocketleague') api.format(i); } else msg = api.click(a, i, w); steps.push({ action: a, index: i, winner: w ?? null, now: NOW, msg, state: clone(state) }); }
  out.sessions.push({ game, start, steps });
}
writeFileSync(join(repo, 'rust/crates/isu-core/tests/parity-controls.json'), JSON.stringify(out));
console.log(out.sessions.length, 'sessions', out.sessions[0].steps.length, 'steps each');
