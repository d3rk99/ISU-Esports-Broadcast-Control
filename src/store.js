import { createInitialState, GAME_CONFIGS, GAME_ORDER } from './game-config.js';

export const STORAGE_KEY = 'isu-esports-control-state-v1';

export function loadState(storage = window.localStorage) {
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY));
    if (!parsed || ![1, 2, 3, 4].includes(parsed.version) || !parsed.games) return createInitialState();
    const fallback = createInitialState();
    for (const game of GAME_ORDER) {
      if (!parsed.games[game]) {
        parsed.games[game] = fallback.games[game];
        continue;
      }
      parsed.games[game] = { ...fallback.games[game], ...parsed.games[game] };
      const config = GAME_CONFIGS[game];
      parsed.games[game].seriesLength = Number(parsed.games[game].seriesLength) || config.defaultSeriesLength || fallback.games[game].seriesLength;
      parsed.games[game].match = {
        ...fallback.games[game].match,
        ...(parsed.games[game].match || {}),
        format: config.defaultSeriesLength ? `Best of ${parsed.games[game].seriesLength}` : parsed.games[game].match?.format || fallback.games[game].match.format
      };
      const savedRows = Array.isArray(parsed.games[game].mapRows) ? parsed.games[game].mapRows : [];
      parsed.games[game].mapRows = config.modes.map((mode, index) => ({
        ...fallback.games[game].mapRows[index],
        ...(savedRows[index] || {}),
        mode: config.modes.includes(savedRows[index]?.mode) ? savedRows[index].mode : fallback.games[game].mapRows[index]?.mode ?? mode
      }));
      parsed.games[game].activeMap = Math.max(0, Math.min(parsed.games[game].mapRows.length - 1, Number(parsed.games[game].activeMap) || 0));
      parsed.games[game].teams = fallback.games[game].teams.map((team, index) => ({
        ...team,
        ...(parsed.games[game].teams?.[index] || {})
      }));
      for (const collection of ['rosters', 'awayRosters']) {
        parsed.games[game][collection] ||= fallback.games[game][collection];
        for (const rosterType of ['varsity', 'jv']) {
          const savedRoster = parsed.games[game][collection]?.[rosterType] || [];
          parsed.games[game][collection][rosterType] = savedRoster.map((player, index) => ({
            ...(fallback.games[game][collection][rosterType][index] || fallback.games[game][collection][rosterType][0]),
            ...player
          }));
        }
      }
      parsed.games[game].characterArt = game === 'overwatch'
        ? { ...(parsed.games[game].characterArt || {}), ...fallback.games[game].characterArt }
        : parsed.games[game].characterArt || {};
      parsed.games[game].mapArt = game === 'overwatch'
        ? { ...(parsed.games[game].mapArt || {}), ...fallback.games[game].mapArt }
        : parsed.games[game].mapArt || {};
      if (game === 'rocketleague') {
        parsed.games[game].rocketLeague = {
          ...fallback.games[game].rocketLeague,
          ...(parsed.games[game].rocketLeague || {}),
          live: { ...fallback.games[game].rocketLeague.live }
        };
      }
      if (parsed.games[game].veto) {
        const usedMaps = new Set();
        parsed.games[game].veto.bans = parsed.games[game].veto.bans.map((map) => {
          if (!map || usedMaps.has(map)) return '';
          usedMaps.add(map);
          return map;
        });
        parsed.games[game].veto.picks = parsed.games[game].veto.picks.map((pick) => {
          if (!pick.map || usedMaps.has(pick.map)) return { ...pick, map: '' };
          usedMaps.add(pick.map);
          return pick;
        });
      }
    }
    return { ...fallback, ...parsed, version: 4 };
  } catch {
    return createInitialState();
  }
}

export function saveState(state, storage = window.localStorage) {
  const snapshot = { ...state, updatedAt: new Date().toISOString() };
  storage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  return snapshot;
}

export function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}
