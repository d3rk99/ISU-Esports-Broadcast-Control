// Rocket League paint finishes -> three.js MeshPhysicalMaterial numbers. Pure, node-testable.
//
// Each finish in the game is a ProductAsset_PaintFinish_TA with these values (read straight
// from the cooked packages by tools/extract_finishes.py):
//   lightCurve           Glossy | Matte | Metallic | Plastic | Toon  (the shading model)
//   specularStrength     highlight intensity (0.06 matte .. 12 brushed metal)
//   specularTint         how much the highlight takes the paint colour (metals ~0.75-1)
//   environmentStrength  reflection strength (0.03 matte .. 10 anodized/obsidian)
//   rimLightTint         fresnel rim intensity
//   sparkleStrength      metal flake amount
//   pearlescentStrength  present on pearl finishes: hue shift with view angle
//   detailNormal + diffuse/specularDetailNormalStrength: tiling surface texture
//   (brushed lines, carbon weave, fur, wood, camo...).

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, Number(v) || 0));
// The game's strengths are roughly logarithmic (1/32 .. 12): squash to 0..1.
const logUnit = (v, lo, hi) => clamp((Math.log2(Math.max(lo, Number(v) || lo)) - Math.log2(lo)) / (Math.log2(hi) - Math.log2(lo)));

export function finishMaterialParams(finish = null) {
  if (!finish) return null;
  const curve = String(finish.lightCurve || 'Glossy');
  const spec = logUnit(finish.specularStrength, 1 / 32, 12);
  const env = logUnit(finish.environmentStrength, 1 / 32, 10);
  const metal = curve === 'Metallic';
  const tint = clamp(finish.specularTint);
  const name = String(finish.displayName || '');
  const params = {
    curve,
    metalness: metal ? clamp(0.35 + 0.6 * tint * Math.max(spec, env)) : 0,
    roughness: 0.5,
    clearcoat: 0,
    clearcoatRoughness: 0.08,
    envMapIntensity: 0.25 + 1.6 * env,
    specularIntensity: 0.2 + 0.8 * spec,
    sheen: 0,
    iridescence: 0,
    iridescenceIOR: 1.6,
    sparkle: clamp((Number(finish.sparkleStrength) || 0) / 32),
    rim: clamp(finish.rimLightTint),
    detailNormalScale: clamp(Math.max(Number(finish.diffuseDetailNormalStrength) || 0, Number(finish.specularDetailNormalStrength) || 0), 0, 3),
    toon: curve === 'Toon'
  };
  if (curve === 'Matte') {
    params.roughness = 0.62 + 0.33 * (1 - spec);
    params.envMapIntensity = 0.1 + 0.6 * env;
    params.specularIntensity = 0.05 + 0.5 * spec;
  } else if (curve === 'Plastic') {
    params.roughness = 0.42;
  } else if (curve === 'Glossy') {
    params.roughness = 0.28 - 0.18 * spec;
    params.clearcoat = 0.4 + 0.6 * spec;
  } else if (metal) {
    // Brushed / rough metals keep a broad highlight; smooth metal & anodized go mirror-like.
    params.roughness = clamp(0.42 - 0.3 * env - 0.08 * spec, 0.06, 0.5);
    params.clearcoat = 0.5 * spec;
  }
  // A strong detail normal (fur, weave, cracks) scatters light: rougher.
  if (params.detailNormalScale > 0.9 && !metal) params.roughness = clamp(params.roughness + 0.12);
  // pearlescentStrength is the game's 0..1 pearl amount (Furry 0.19, Obsidian 0.8, Pearlescent 1).
  const pearl = Math.min(1, Math.max(0, Number(finish.pearlescentStrength) || 0));
  if (pearl > 0 || /pearl/i.test(name)) params.iridescence = 0.85 * (pearl || 1) ** 2;
  if (/fur|yarn|knit|burlap|canvas|zebra|felt/i.test(name)) params.sheen = 0.12;
  return params;
}

// The game's Loadout array sometimes carries finish slots; match by id/name/alias.
export function findFinish(finishes = [], value = '') {
  const key = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!key || key === 'none') return null;
  return finishes.find((f) => [f.id, f.productId, f.displayName, ...(f.aliases || [])]
    .some((v) => v !== undefined && v !== null && String(v).toLowerCase().replace(/[^a-z0-9]/g, '') === key)) || null;
}
