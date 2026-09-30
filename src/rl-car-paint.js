import * as THREE from 'three';

// Rocket League body paint, implemented from what the extracted textures contain
// (checked channel by channel on Octane / Dominus / Fennec):
//
//   BlankSkin (body "RGB" / BlankSkin texture)
//     R = paintable body area (where the team primary colour goes)
//     B = small fixed accent regions
//   Decal texture (Skin_* "..._RGB")
//     R = the same paintable body area as BlankSkin R
//     A = the decal pattern (drawn in the team accent colour)
//     G = optional second decal layer (painted-decal colour; we use accent)
//     B = optional third layer (kept dark)
//   Body diffuse (…_Body_D): shading/detail baked on top of the paint.
//
// Stats API sends only team ColorPrimary/ColorSecondary, so primary = team primary
// and accent = team secondary, which is what the game shows in a standard match.

const PAINT_FRAGMENT = `
  vec4 rlSkin = texture2D(rlSkinMap, vMapUv);
  vec4 rlDecal = rlHasDecal > 0.5 ? texture2D(rlDecalMap, vMapUv) : vec4(0.0);
  float rlBody = rlHasDecal > 0.5 ? max(rlDecal.r, rlSkin.r) : rlSkin.r;
  // Base: team primary where paintable, the diffuse elsewhere.
  vec3 rlPaint = mix(diffuseColor.rgb, rlPrimary, rlBody);
  // Decal pattern in the accent colour.
  rlPaint = mix(rlPaint, rlAccent, rlDecal.a * rlBody);
  rlPaint = mix(rlPaint, rlAccent * 0.8 + rlPrimary * 0.2, rlDecal.g * rlBody);
  rlPaint = mix(rlPaint, vec3(0.06), rlDecal.b * rlBody);
  // Fixed accent areas from the blank skin.
  rlPaint = mix(rlPaint, rlAccent, rlSkin.b);
  // Keep the diffuse's baked shading (panel lines, AO) on top of the paint.
  // Only borrow the diffuse's darker detail (panel lines, AO); flat areas stay the true
  // team colour so orange stays orange and blue doesn't drift toward purple.
  float rlLuma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  float rlShade = clamp(rlLuma * rlShadeGain, 0.0, 1.0);
  rlShade = mix(1.0, rlShade, smoothstep(0.55, 0.15, rlShade));
  diffuseColor.rgb = mix(rlPaint, rlPaint * rlShade, rlBody * rlShadeAmount);
`;

export function applyBodyPaint(material, { skinMap, decalMap = null, primary, accent, shadeAmount = 0.8, shadeGain = 1.6 }) {
  if (!skinMap) return false;
  const uniforms = {
    rlSkinMap: { value: skinMap },
    rlDecalMap: { value: decalMap || skinMap },
    rlHasDecal: { value: decalMap ? 1 : 0 },
    // THREE.Color already converts hex/CSS input from sRGB to the linear working space.
    rlPrimary: { value: new THREE.Color(primary) },
    rlAccent: { value: new THREE.Color(accent) },
    rlShadeAmount: { value: shadeAmount },
    rlShadeGain: { value: shadeGain }
  };
  // A map is required so vMapUv exists in the shader; use the skin if there is no diffuse.
  if (!material.map) {
    material.map = skinMap;
    material.color?.set?.(0xffffff);
    uniforms.rlShadeAmount.value = 0;
  }
  material.userData.rlPaint = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_pars_fragment>', `#include <map_pars_fragment>
uniform sampler2D rlSkinMap;
uniform sampler2D rlDecalMap;
uniform float rlHasDecal;
uniform vec3 rlPrimary;
uniform vec3 rlAccent;
uniform float rlShadeAmount;
uniform float rlShadeGain;`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${PAINT_FRAGMENT}`);
  };
  material.customProgramCacheKey = () => `rl-paint-${decalMap ? 'd' : 'n'}`;
  material.needsUpdate = true;
  return true;
}
