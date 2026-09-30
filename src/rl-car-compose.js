// Loadout -> renderable car description, from Stats API data alone.
//
// The Stats API gives, per player: Loadout (asset names by product slot, e.g.
// ["body_grain","Skin_bartees","Wheel_SoccerBall","Boost_AlphaReward","None",...]),
// TeamNum, and per team ColorPrimary / ColorSecondary hex. It does NOT send painted
// item colours or the player's custom primary/accent choice beyond the team colours,
// so paint comes from the team colours (what the game itself shows in-match).
//
// Pure functions only (no DOM/three) so this can be unit tested in node.

const SLOT = Object.freeze({ body: 0, decal: 1, wheel: 2, boost: 3 });

export function itemKey(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function assetKeys(asset = {}) {
  return [asset.id, asset.productId, asset.displayName, ...(asset.aliases || [])]
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map((value) => itemKey(String(value).split('.').pop()));
}

export function buildAssetIndex(pack = {}) {
  const index = { body: new Map(), wheel: new Map(), decal: new Map() };
  for (const [kind, list] of [['body', pack.bodies], ['wheel', pack.wheels], ['decal', pack.decals]]) {
    for (const asset of list || []) {
      for (const key of assetKeys(asset)) if (key && !index[kind].has(key)) index[kind].set(key, asset);
    }
  }
  return index;
}

function hexColor(value, fallback) {
  const hex = String(value || '').replace(/^#/, '').trim();
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : fallback;
}

// In-match defaults (Blue / Orange) when the packet has no team colours.
const TEAM_DEFAULTS = [
  { primary: '#1873ff', accent: '#0a1d3d' },
  { primary: '#ff7a1a', accent: '#3d1a05' }
];

export function teamPaint(teamNum = 0, teams = []) {
  const side = Number(teamNum) === 1 ? 1 : 0;
  const team = (teams || []).find((item) => Number(item?.TeamNum ?? item?.teamNum) === side) || {};
  return {
    primary: hexColor(team.ColorPrimary ?? team.colorPrimary, TEAM_DEFAULTS[side].primary),
    accent: hexColor(team.ColorSecondary ?? team.colorSecondary, TEAM_DEFAULTS[side].accent)
  };
}

// Decals are body-specific (e.g. "Octane: Flames") unless universal.
function decalFitsBody(decal, body) {
  if (!decal) return false;
  if (decal.universal) return true;
  if (!decal.appliesToBodyId && !decal.appliesToBodyName) return true;
  return itemKey(decal.appliesToBodyId) === itemKey(body.id)
    || itemKey(decal.appliesToBodyName) === itemKey(body.displayName);
}

// Returns { body, decal, wheel, paint, missing[], notes[] } for one Stats API player.
export function composeCar(player = {}, teams = [], index = {}) {
  const loadout = Array.isArray(player.Loadout ?? player.loadout) ? (player.Loadout ?? player.loadout) : [];
  const slot = (n) => {
    const value = String(loadout[n] ?? '').trim();
    return value && value.toLowerCase() !== 'none' ? value : '';
  };
  const missing = [];
  const notes = [];
  const lookup = (kind, name) => (name ? index[kind]?.get(itemKey(name)) || null : null);

  const bodyName = slot(SLOT.body);
  const body = lookup('body', bodyName);
  if (bodyName && !body) missing.push({ slot: 'body', name: bodyName });

  const decalName = slot(SLOT.decal);
  let decal = lookup('decal', decalName);
  if (decalName && !decal) missing.push({ slot: 'decal', name: decalName });
  if (decal && body && !decalFitsBody(decal, body)) {
    notes.push(`Decal ${decal.displayName} is for ${decal.appliesToBodyName || 'another body'}, not ${body.displayName}; skipped.`);
    decal = null;
  }

  const wheelName = slot(SLOT.wheel);
  const wheel = lookup('wheel', wheelName);
  if (wheelName && !wheel) missing.push({ slot: 'wheel', name: wheelName });

  return {
    body,
    decal,
    wheel,
    paint: teamPaint(player.TeamNum ?? player.teamNum, teams),
    teamNum: Number(player.TeamNum ?? player.teamNum) === 1 ? 1 : 0,
    missing,
    notes
  };
}

export { SLOT };
