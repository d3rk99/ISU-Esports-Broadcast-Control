// Display presets: what each of the 10 audience displays shows on its NDI feed.
// state.displays.stations[N] = { preset, team }  (read by /displays/station.html?station=N in OBS)
// Shared by the controller UI and Companion actions.
export const DISPLAY_PRESETS = [
  { id: 'idle', label: 'Idle', description: 'Station number on a moving background' },
  { id: 'intro', label: 'Team intro', description: 'Both teams with VS, on every station' },
  { id: 'player', label: 'Player cards', description: 'Each station shows the roster player sitting at it' },
  { id: 'banner', label: 'Team banners', description: 'Stations 1-5 = home banner, 6-10 = away, one canvas across 5 screens' },
  { id: 'score', label: 'Series score', description: 'Series score with both logos' },
  { id: 'black', label: 'Black', description: 'All black' }
];
const IDS = DISPLAY_PRESETS.map((p) => p.id);

export function ensureDisplayState(state) {
  if (!state.displays || typeof state.displays !== 'object') state.displays = {};
  if (!state.displays.stations || typeof state.displays.stations !== 'object') state.displays.stations = {};
  for (let n = 1; n <= 10; n += 1) {
    const s = state.displays.stations[n];
    if (!s || !IDS.includes(s.preset)) state.displays.stations[n] = { preset: 'idle', team: '' };
    else if (!['', 'home', 'away'].includes(s.team ?? '')) s.team = '';
  }
  return state.displays;
}

// station: 1-10 or 'all'. team: '' (automatic) | 'home' | 'away'.
export function applyDisplayPreset(state, station, preset, team = '') {
  ensureDisplayState(state);
  if (!IDS.includes(preset)) throw new Error(`Unknown display preset: ${preset}`);
  if (!['', 'home', 'away'].includes(team)) throw new Error('team must be home, away or blank');
  const targets = station === 'all' ? Array.from({ length: 10 }, (_v, i) => i + 1) : [Math.round(Number(station))];
  if (!targets.every((n) => n >= 1 && n <= 10)) throw new Error('station must be 1-10 or all');
  for (const n of targets) state.displays.stations[n] = { preset, team };
  return targets;
}
