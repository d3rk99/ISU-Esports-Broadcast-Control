// Keep slot positions, including unknown/empty slots. No guesses from player names.
export function normalizeLoadout(value) {
  return Array.isArray(value) ? value.slice(0, 32).map((item) => typeof item === 'string' ? item.trim().slice(0, 256) : '') : [];
}

export function loadoutKey(value, scope = 'loadout') {
  const items = normalizeLoadout(value).map((item) => item.toLowerCase());
  if (!items[0] || items[0] === 'none') return '';
  return scope === 'body' ? `body:${items[0]}` : `loadout:${JSON.stringify(items)}`;
}

export function resolveCarArt(player, library = {}) {
  if (!library.enabled) return null;
  const exact = library.renders?.[loadoutKey(player.loadout)];
  const body = library.renders?.[loadoutKey(player.loadout, 'body')];
  const entry = exact || body;
  return entry?.url ? { url: entry.url, scope: exact ? 'loadout' : 'body' } : null;
}

export function updateCarArt(game) {
  for (const player of game.rocketLeague?.live?.players || []) {
    const art = resolveCarArt(player, game.rocketLeague.carRenderer);
    player.carImage = art?.url || '';
    player.carImageScope = art?.scope || '';
  }
}
