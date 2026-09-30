// Rocket League garage colour palettes, indexed by the in-game colour ID.
// Values from the community palette (reddit r/RLFashionAdvice 9l1swx) as packaged in
// Longi94/rl-loadout-lib src/utils/color.ts (Apache-2.0). Replays and BakkesMod store a
// car's TeamPaint as these IDs (primary/accent colour + finish), so an ID -> hex table
// turns saved player data into render colours.

export const BLUE_PRIMARY = [
  '#507f39', '#397f3f', '#397f64', '#397d7f', '#396b7f', '#395d7f', '#394f7f', '#39427f', '#4c397f', '#51397f',
  '#65b23e', '#3eb248', '#3eb286', '#3eaeb2', '#3e91b2', '#3e7ab2', '#3e63b2', '#3e4db2', '#5d3eb2', '#673eb2',
  '#72e539', '#39e547', '#39e5a3', '#39dfe5', '#39b4e5', '#3992e5', '#396fe5', '#3950e5', '#6739e5', '#7539e5',
  '#5cfc0c', '#0cfc20', '#0cfca0', '#0cf4fc', '#0cb8fc', '#0c88fc', '#0c58fc', '#0c2cfc', '#4c0cfc', '#600cfc',
  '#4acc0a', '#0acc1a', '#0acc81', '#0ac5cc', '#0a95cc', '#0a6ecc', '#0a47cc', '#0a24cc', '#3d0acc', '#4e0acc',
  '#3ca508', '#08a515', '#08a569', '#08a0a5', '#0879a5', '#0859a5', '#083aa5', '#081da5', '#3208a5', '#3f08a5',
  '#2e7f06', '#067f10', '#067f51', '#067b7f', '#065d7f', '#06447f', '#062c7f', '#06167f', '#26067f', '#30067f'
];
export const ORANGE_PRIMARY = [
  '#7f7f39', '#7f7039', '#7f6339', '#7f5a39', '#7f5439', '#7f4e39', '#7f4739', '#7f3939', '#7f3951', '#7f395c',
  '#b2b23e', '#b2993e', '#b2843e', '#b2743e', '#b26a3e', '#b2613e', '#b2553e', '#b23e3e', '#b23e67', '#b23e78',
  '#e5e539', '#e5c039', '#e5a039', '#e58939', '#e57b39', '#e56d39', '#e55b39', '#e53939', '#e53975', '#e5398f',
  '#fcfc0c', '#fcc80c', '#fc9c0c', '#fc7c0c', '#fc680c', '#fc540c', '#fc3c0c', '#fc0c0c', '#fc0c60', '#fc0c84',
  '#cccc0a', '#cca20a', '#cc7e0a', '#cc640a', '#cc540a', '#cc440a', '#cc300a', '#cc0a0a', '#cc0a4e', '#cc0a6b',
  '#a5a508', '#a58308', '#a56608', '#a55108', '#a54408', '#a53708', '#a52708', '#a50808', '#a5083f', '#a50857',
  '#7f7f06', '#7f6506', '#7f4f06', '#7f3e06', '#7f3406', '#7f2a06', '#7f1e06', '#7f0606', '#7f0630', '#7f0642'
];
export const ACCENT = [
  '#e5e5e5', '#ff7f7f', '#ff9f7f', '#ffcf7f', '#efff7f', '#afff7f', '#7fff7f', '#7fffb2', '#7fe9ff', '#7fb0ff',
  '#7f88ff', '#ae7fff', '#e57fff', '#ff7fd0', '#ff7f94', '#bfbfbf', '#ff5959', '#ff8259', '#ffc059', '#eaff59',
  '#97ff59', '#59ff59', '#59ff9b', '#59e3ff', '#5998ff', '#5964ff', '#9659ff', '#dd59ff', '#ff59c2', '#ff5974',
  '#999999', '#ff3232', '#ff6532', '#ffb232', '#e5ff32', '#7fff32', '#32ff32', '#32ff84', '#32dcff', '#3281ff',
  '#3240ff', '#7d32ff', '#d632ff', '#ff32b4', '#ff3255', '#666666', '#ff0000', '#ff3f00', '#ff9f00', '#dfff00',
  '#5fff00', '#00ff00', '#00ff66', '#00d4ff', '#0061ff', '#0011ff', '#5d00ff', '#cc00ff', '#ff00a1', '#ff002a',
  '#3f3f3f', '#b20000', '#b22c00', '#b26f00', '#9cb200', '#42b200', '#00b200', '#00b247', '#0094b2', '#0044b2',
  '#000bb2', '#4100b2', '#8e00b2', '#b20071', '#b2001d', '#262626', '#660000', '#661900', '#663f00', '#596600',
  '#266600', '#006600', '#006628', '#005466', '#002766', '#000666', '#250066', '#510066', '#660040', '#660011',
  '#000000', '#330000', '#330c00', '#331f00', '#2c3300', '#133300', '#003300', '#003314', '#002a33', '#001333',
  '#000333', '#120033', '#280033', '#330020', '#330008'
];

// Stock in-match colours (garage IDs a player has if they never changed paint).
export const DEFAULT_BLUE_ID = 35;
export const DEFAULT_ORANGE_ID = 33;
export const DEFAULT_ACCENT_ID = 0;

// Painted-item colours (the standard paints), by in-game paint ID.
export const PAINTS = Object.freeze({
  1: { name: 'Crimson', hex: '#ff0000' }, 2: { name: 'Lime', hex: '#a9ff00' }, 3: { name: 'Black', hex: '#000000' },
  4: { name: 'Sky Blue', hex: '#00b5e8' }, 5: { name: 'Cobalt', hex: '#0048ed' }, 6: { name: 'Burnt Sienna', hex: '#843d00' },
  7: { name: 'Forest Green', hex: '#00ba09' }, 8: { name: 'Purple', hex: '#8800cc' }, 9: { name: 'Pink', hex: '#ff38f8' },
  10: { name: 'Orange', hex: '#ff5d00' }, 11: { name: 'Grey', hex: '#8f8f8f' }, 12: { name: 'Titanium White', hex: '#ffffff' },
  13: { name: 'Saffron', hex: '#e3e300' }
});

function pick(list, id, fallbackId) {
  const n = Number(id);
  const value = id !== undefined && id !== null && id !== '' && Number.isInteger(n) ? list[n] : undefined;
  return (value || list[fallbackId]).toLowerCase();
}

// { teamNum, primaryId, accentId } -> { primary, accent } hex, as the garage shows it.
export function garagePaint({ teamNum = 0, primaryId, accentId } = {}) {
  const orange = Number(teamNum) === 1;
  return {
    primary: pick(orange ? ORANGE_PRIMARY : BLUE_PRIMARY, primaryId, orange ? DEFAULT_ORANGE_ID : DEFAULT_BLUE_ID),
    accent: pick(ACCENT, accentId, DEFAULT_ACCENT_ID)
  };
}
