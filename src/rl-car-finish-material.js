import * as THREE from 'three';
import { finishMaterialParams } from './rl-car-finish.js';

// A small procedural studio so reflective finishes have something to reflect.
export function createStudioEnvironment(renderer) {
  const scene = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.BoxGeometry(20, 10, 20), new THREE.MeshBasicMaterial({ color: 0x2a2d35, side: THREE.BackSide }));
  room.position.y = 4; scene.add(room);
  const panel = (w, h, color, intensity, pos, rot = [0, 0, 0]) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }));
    mesh.position.set(...pos); mesh.rotation.set(...rot); scene.add(mesh);
  };
  panel(12, 3, 0xffffff, 6, [0, 8.9, 0], [Math.PI / 2, 0, 0]);      // overhead softbox
  panel(6, 4, 0xfff4e8, 4, [-9.9, 4, 2], [0, Math.PI / 2, 0]);        // warm key
  panel(6, 4, 0xe8f0ff, 3, [9.9, 4, -2], [0, -Math.PI / 2, 0]);       // cool fill
  panel(10, 1.2, 0xffffff, 3, [0, 3.5, -9.9]);                       // back strip (rim)
  panel(20, 20, 0x15161a, 1, [0, -0.99, 0], [-Math.PI / 2, 0, 0]);   // dark floor
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0.035);
  pmrem.dispose();
  scene.traverse((child) => { child.geometry?.dispose(); child.material?.dispose(); });
  return target.texture;
}

const FINISH_PARS = `
uniform float rlSparkle;
uniform float rlRim;
uniform vec3 rlRimColor;
uniform float rlToon;
float rlHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
`;

// After lighting: metal flakes glint, a fresnel rim, and toon finishes band the light.
const FINISH_OUTPUT = `
#ifdef USE_MAP
  vec2 rlFlakeUv = vMapUv * 900.0;
#else
  vec2 rlFlakeUv = gl_FragCoord.xy * 0.5;
#endif
  float rlNdV = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
  if (rlSparkle > 0.0) {
    vec2 rlCell = floor(rlFlakeUv);
    float rlGlint = step(0.92, rlHash(rlCell)) * pow(max(0.0, sin((rlNdV + rlHash(rlCell + 17.0)) * 18.0)), 24.0);
    outgoingLight += vec3(rlGlint * rlSparkle * 0.9) * (0.4 + 0.6 * diffuseColor.rgb);
  }
  if (rlRim > 0.0) outgoingLight += rlRimColor * pow(1.0 - rlNdV, 3.0) * rlRim * 0.35;
  if (rlToon > 0.5) {
    float rlL = dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722));
    float rlBand = rlL < 0.12 ? 0.45 : (rlL < 0.45 ? 0.8 : 1.05);
    outgoingLight = diffuseColor.rgb * rlBand + vec3(step(0.92, rlL) * 0.25);
  }
`;

// Swap a mesh's material for a MeshPhysicalMaterial carrying the finish. Keeps every map and
// chains the paint shader hook (applyBodyPaint) so team colours still work.
export function applyFinish(mesh, material, finish, { detailNormal = null, envMap = null } = {}) {
  const params = finishMaterialParams(finish);
  if (!params) return material;
  const physical = new THREE.MeshPhysicalMaterial();
  // flatShading matters: the pack's GLBs carry no NORMAL attribute, so GLTFLoader turns flat
  // shading on. Without it the shader reads a zero normal and every pixel comes out black.
  for (const key of ['name', 'map', 'normalMap', 'side', 'transparent', 'opacity', 'alphaMap', 'aoMap', 'flatShading', 'vertexColors', 'alphaTest', 'depthWrite']) {
    if (material[key] !== undefined) physical[key] = material[key];
  }
  if (material.normalScale) physical.normalScale = material.normalScale.clone();
  if (material.color) physical.color = material.color.clone();
  physical.userData = { ...(material.userData || {}) };
  Object.assign(physical, {
    metalness: params.metalness, roughness: params.roughness, clearcoat: params.clearcoat,
    clearcoatRoughness: params.clearcoatRoughness, specularIntensity: params.specularIntensity,
    envMapIntensity: params.envMapIntensity
  });
  if (envMap) physical.envMap = envMap;
  // Rainbow film and fuzz are paint effects: chassis/trim get only the base finish.
  const isBody = (material.userData?.rlPart || 'body') === 'body';
  if (!isBody) { params.iridescence = 0; params.sheen = 0; }
  if (params.sheen) { physical.sheen = params.sheen; physical.sheenRoughness = 0.8; physical.sheenColor = new THREE.Color(0xffffff).multiplyScalar(0.6); }
  if (params.iridescence) { physical.iridescence = params.iridescence; physical.iridescenceIOR = params.iridescenceIOR; physical.iridescenceThicknessRange = [200, 600]; }
  // Tiling detail normal. The body's own normal keeps the panel shape, so when it has one the
  // detail rides on the clearcoat layer instead of replacing it.
  if (detailNormal && params.detailNormalScale > 0) {
    detailNormal.wrapS = detailNormal.wrapT = THREE.RepeatWrapping;
    detailNormal.repeat.set(8, 8);
    const scale = new THREE.Vector2(params.detailNormalScale, -params.detailNormalScale).multiplyScalar(0.6);
    if (physical.normalMap) { physical.clearcoat = Math.max(physical.clearcoat, 0.35); physical.clearcoatNormalMap = detailNormal; physical.clearcoatNormalScale = scale; }
    else { physical.normalMap = detailNormal; physical.normalScale = scale; }
  }
  const uniforms = {
    rlSparkle: { value: params.sparkle },
    rlRim: { value: params.rim },
    rlRimColor: { value: new THREE.Color(0xdfe8ff) },
    rlToon: { value: params.toon ? 1 : 0 }
  };
  const paintHook = material.onBeforeCompile;
  const hasSkin = Boolean(material.userData?.rlPaint?.rlSkinMap?.value);
  const paintKey = material.customProgramCacheKey?.() || '';
  physical.onBeforeCompile = (shader, renderer) => {
    if (paintHook && paintHook !== THREE.Material.prototype.onBeforeCompile) paintHook.call(physical, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FINISH_PARS}`)
      .replace('#include <opaque_fragment>', `${FINISH_OUTPUT}\n#include <opaque_fragment>`);
    // Painted bodies: BlankSkin B marks the windows. The finish (detail bumps, flakes, metal)
    // is paint, so glass gets its plain normal back and stays smooth glossy glass.
    if (hasSkin) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n  float rlGlass = clamp(rlSkin.b, 0.0, 1.0);\n  normal = normalize(mix(normal, nonPerturbedNormal, rlGlass));`)
        .replace('#include <clearcoat_normal_fragment_maps>', `#include <clearcoat_normal_fragment_maps>\n#ifdef USE_CLEARCOAT\n  clearcoatNormal = normalize(mix(clearcoatNormal, nonPerturbedNormal, rlGlass));\n#endif`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.08, clamp(texture2D(rlSkinMap, vMapUv).b, 0.0, 1.0));`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n  metalnessFactor = mix(metalnessFactor, 0.0, clamp(texture2D(rlSkinMap, vMapUv).b, 0.0, 1.0));`)
        .replace('if (rlSparkle > 0.0) {', 'if (rlSparkle > 0.0 && rlGlass < 0.5) {')
        .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
#ifdef USE_IRIDESCENCE
  material.iridescence *= 1.0 - rlGlass;
#endif
#ifdef USE_SHEEN
  material.sheenColor *= diffuseColor.rgb * (1.0 - rlGlass);
#endif`);
    }
  };
  physical.customProgramCacheKey = () => `${paintKey}|${hasSkin ? 'glass' : ''}|finish-${params.curve}-${params.sparkle > 0 ? 's' : ''}${params.toon ? 't' : ''}`;
  physical.userData.rlFinish = { id: finish.id, displayName: finish.displayName };
  physical.needsUpdate = true;
  if (Array.isArray(mesh.material)) {
    const index = mesh.material.indexOf(material);
    if (index >= 0) mesh.material[index] = physical;
  } else if (mesh.material === material) mesh.material = physical;
  // Don't dispose the old material: its maps are shared with the new one, and disposing the
  // material can release the GPU program/textures they still use (rendered all black).
  return physical;
}
