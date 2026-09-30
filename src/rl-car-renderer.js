import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { applyBodyPaint } from './rl-car-paint.js';

export function disposeObject(object) {
  object?.traverse((child) => {
    child.geometry?.dispose();
    for (const material of [child.material].flat().filter(Boolean)) {
      for (const value of Object.values(material)) if (value?.isTexture) { value.source?.data?.close?.(); value.dispose(); }
      material.dispose();
    }
  });
}

// Original, deliberately generic test geometry. Not an Octane or any licensed RL model.
export function demoCar() {
  const car = new THREE.Group();
  const part = (geometry, color, x, y, z) => {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.3 }));
    mesh.position.set(x, y, z); car.add(mesh); return mesh;
  };
  part(new THREE.BoxGeometry(2.8, 0.45, 1.35), '#f47920', 0, 0.55, 0);
  part(new THREE.BoxGeometry(1.25, 0.55, 1.12), '#24354d', -0.15, 1, 0);
  part(new THREE.BoxGeometry(0.3, 0.12, 1.7), '#f47920', -1.3, 1.05, 0);
  for (const x of [-0.9, 0.9]) for (const z of [-0.72, 0.72]) {
    const wheel = part(new THREE.CylinderGeometry(0.4, 0.4, 0.26, 28), '#17191f', x, 0.4, z);
    wheel.rotation.x = Math.PI / 2;
  }
  for (const z of [-0.43, 0.43]) part(new THREE.BoxGeometry(0.03, 0.13, 0.3), '#eeeeff', 1.41, 0.6, z);
  return car;
}

function textureBase(path = '') {
  return String(path).split('/').pop().replace(/\.[^.]+$/, '').replace(/_(D|N|RGB|Diffuse|Normal|BlankSkin|Curvature)$/i, '').toLowerCase();
}

function fileBase(path = '') {
  return String(path).split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();
}

function materialBase(name = '') {
  return String(name).replace(/_(MIC|MAT|MI)$/i, '').toLowerCase();
}

function compactKey(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function textureScore(materialName, texture) {
  const material = materialBase(materialName);
  const textureName = textureBase(texture.path);
  if (!material || !textureName) return 0;
  if (material === textureName) return 100;
  if (material.includes(textureName) || textureName.includes(material)) return 80;
  const materialParts = material.split(/[_-]+/).filter(Boolean);
  const textureParts = textureName.split(/[_-]+/).filter(Boolean);
  return textureParts.reduce((score, part) => score + (materialParts.some((materialPart) => materialPart === part || materialPart.includes(part) || part.includes(materialPart)) ? 8 : 0), 0);
}

function texturePathKey(path = '') {
  return String(path).replace(/\\/g, '/').toLowerCase();
}

function textureMap(textures = []) {
  return new Map(textures.map((texture) => [texturePathKey(texture.path), texture]));
}

function bindingForMaterial(asset = {}, materialName = '') {
  const bindings = asset.materialBindings || {};
  if (bindings[materialName]) return bindings[materialName];
  const material = materialBase(materialName);
  const match = Object.entries(bindings).find(([key]) => materialBase(key) === material);
  return match?.[1] || null;
}

function bindingTextureName(binding) {
  if (!binding) return '';
  return compactKey([binding.diffuse, binding.normal, binding.mask, ...(binding.other || [])].join(' '));
}

function materialHint(materialName = '', meshName = '') {
  const key = compactKey(`${meshName} ${materialName}`);
  if (/chassis|chasis|parts|trim|glass|window|wheel|tire|tyre/.test(key)) return 'chassis';
  if (/body|paint|skin|premium|car/.test(key)) return 'body';
  return '';
}

function fallbackBindingForMaterial(asset = {}, materialName = '', meshName = '') {
  const exact = bindingForMaterial(asset, materialName);
  if (exact) return exact;
  const bindings = Object.entries(asset.materialBindings || {});
  if (!bindings.length) return null;
  const hint = materialHint(materialName, meshName);
  const scored = bindings.map(([name, binding], index) => {
    const key = compactKey(`${name} ${bindingTextureName(binding)}`);
    let score = Math.max(0, 20 - index);
    if (hint === 'chassis' && /chassis|chasis|parts|trim|glass|window/.test(key)) score += 100;
    if (hint === 'body' && /body|paint|skin|premium|blankskin/.test(key) && !/chassis|chasis/.test(key)) score += 100;
    if (!hint && /body|paint|skin|premium/.test(key) && !/chassis|chasis/.test(key)) score += 60;
    return { binding, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.binding || null;
}

function textureFromPath(texturesByPath, pathValue) {
  if (!pathValue) return null;
  return texturesByPath.get(texturePathKey(pathValue)) || null;
}

function bestTexture(materialName, textures, role, scorer = textureScore) {
  return textures
    .filter((texture) => texture.role === role)
    .sort((a, b) => scorer(materialName, b) - scorer(materialName, a))[0] || null;
}

function boundOrBestTexture(asset, materialName, meshName, role, texturesByPath, scorer = textureScore) {
  const textures = Array.isArray(asset.textures) ? asset.textures : [];
  const binding = fallbackBindingForMaterial(asset, materialName, meshName);
  const bound = textureFromPath(texturesByPath, binding?.[role]);
  if (bound) return bound;
  return bestTexture(materialName, textures, role, scorer);
}

// ---- Paint & decal composition -------------------------------------------------
// Texture roles, verified channel-by-channel on the extracted pack (see rl-car-paint.js):
// body BlankSkin R = paintable area; decal *_RGB: R = paintable area, A = pattern.

function materialSlot(name = '') {
  const match = String(name).match(/(\d+)$/);
  return match ? Number(match[1]) : -1;
}

function isChassisName(value = '') {
  return /chassis|chasis|parts|trim|glass|window|lens|headlight|wheel|tire|tyre/.test(compactKey(value));
}

function findTexture(textures, predicate) {
  return textures.find((texture) => predicate(fileBase(texture.path), texture)) || null;
}

// The body's paint-area map: BlankSkin role first, then *_BlankSkin*_RGB-ish masks.
function bodySkinTexture(textures, binding) {
  const bound = (binding?.other || []).map((pathValue) => textures.find((t) => texturePathKey(t.path) === texturePathKey(pathValue))).find((t) => t?.role === 'blankskin');
  if (bound) return bound;
  return findTexture(textures, (name, t) => t.role === 'blankskin')
    || findTexture(textures, (name, t) => t.role === 'mask' && /blankskin/.test(name))
    || findTexture(textures, (name, t) => t.role === 'mask' && /body/.test(name) && !/chassis|chasis|part|fx|grad|sphere/.test(name));
}

// The decal's pattern map: its *_RGB texture that isn't a shared body/chassis mask.
function decalPatternTexture(decal) {
  const textures = Array.isArray(decal?.textures) ? decal.textures : [];
  const bound = Object.values(decal?.materialBindings || {})
    .flatMap((binding) => [binding.mask, ...(binding.other || [])])
    .filter(Boolean)
    .map((pathValue) => textures.find((t) => texturePathKey(t.path) === texturePathKey(pathValue)))
    .find((t) => t && /_rgb$/.test(fileBase(t.path)) && !/blankskin|chassis|chasis/.test(fileBase(t.path)));
  if (bound) return bound;
  return findTexture(textures, (name) => /_rgb$/.test(name) && !/blankskin|chassis|chasis|curv/.test(name));
}

// Some decals ship their own diffuse (e.g. printed liveries); use it when present.
function decalDiffuseTexture(decal, body) {
  const textures = Array.isArray(decal?.textures) ? decal.textures : [];
  const bodyFiles = new Set((body?.textures || []).map((t) => fileBase(t.path)));
  return findTexture(textures, (name, t) => t.role === 'diffuse' && !bodyFiles.has(name) && !/thumb|curv/.test(name));
}

async function applyAssetTextures(root, asset = {}, { isWheel = false } = {}) {
  const textures = (Array.isArray(asset.textures) ? asset.textures : []).filter((texture) => texture?.url);
  const decal = isWheel ? null : asset.decal;
  const paint = isWheel ? null : paintColors(asset);
  if (!textures.length && !decal) return { painted: 0 };
  // RL mask textures keep their channel data in pixels whose alpha is 0. An <img>
  // load premultiplies alpha and wipes that RGB, so masks are decoded as raw bitmaps.
  const loader = new THREE.ImageBitmapLoader();
  loader.setOptions({ imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const loaded = new Map();
  const loadTexture = async (texture, color = false) => {
    if (!texture?.url) return null;
    if (!loaded.has(texture.url)) {
      loaded.set(texture.url, loader.loadAsync(texture.url).then((bitmap) => {
        const map = new THREE.Texture(bitmap);
        map.flipY = false;
        map.premultiplyAlpha = false;
        map.anisotropy = 4;
        map.needsUpdate = true;
        return map;
      }).catch(() => null));
    }
    const map = await loaded.get(texture.url);
    if (map && color) map.colorSpace = THREE.SRGBColorSpace;
    return map;
  };
  const texturesByPath = textureMap(textures);
  const skinTextureFor = (binding) => bodySkinTexture(textures, binding);
  const patternTexture = decalPatternTexture(decal);
  const decalDiffuse = decalDiffuseTexture(decal, asset);
  let painted = 0;
  const jobs = [];
  let namedChassisExists = false;
  root.traverse((child) => {
    for (const material of [child.material].flat().filter(Boolean)) if (isChassisName(material.name || '')) namedChassisExists = true;
  });
  root.traverse((child) => {
    if (!child.isMesh) return;
    for (const material of [child.material].flat().filter(Boolean)) jobs.push({ mesh: child, meshName: child.name || '', material });
  });
  await Promise.all(jobs.map(async ({ mesh, meshName, material }) => {
    const binding = fallbackBindingForMaterial(asset, material.name, meshName);
    const nameText = `${material.name} ${meshName}`;
    let chassis = isChassisName(`${nameText} ${bindingTextureName(binding)}`);
    // Generic names (material_0, ...) say nothing. Across the extracted pack, the chassis
    // is material slot 0 on 67 of 70 bodies with named materials, so slot 0 = chassis.
    const genericName = /^material_?\d+$/i.test(material.name || '') || !material.name;
    if (!isWheel && genericName) chassis = materialSlot(material.name) === 0 && !namedChassisExists;
    // Generic chassis slots have no binding; take the chassis diffuse/normal by name instead of the body's.
    // For generic names the fallback binding is a guess (usually the body's), so for a
    // chassis slot prefer the binding whose name says chassis, then chassis-named textures.
    const chassisBinding = chassis && genericName
      ? Object.entries(asset.materialBindings || {}).find(([name]) => isChassisName(name))?.[1] || null
      : null;
    const chassisDiffuse = chassis && genericName
      ? textureFromPath(texturesByPath, chassisBinding?.diffuse) || findTexture(textures, (name, t) => t.role === 'diffuse' && /chassis|chasis/.test(name))
      : null;
    const chassisNormal = chassis && genericName
      ? textureFromPath(texturesByPath, chassisBinding?.normal) || findTexture(textures, (name, t) => t.role === 'normal' && /chassis|chasis/.test(name))
      : null;
    const diffuse = chassisDiffuse || textureFromPath(texturesByPath, binding?.diffuse) || boundOrBestTexture(asset, material.name, meshName, 'diffuse', texturesByPath);
    const normal = chassisNormal || textureFromPath(texturesByPath, binding?.normal) || boundOrBestTexture(asset, material.name, meshName, 'normal', texturesByPath);
    const useDiffuse = diffuse && !(/^blank_n$/.test(fileBase(diffuse.path)));
    const map = await loadTexture(!chassis && decalDiffuse ? decalDiffuse : (useDiffuse ? diffuse : null), true);
    if (map) { material.map = map; material.color?.set?.(0xffffff); }
    // Generic shared normals (fur / sparkle / blank) belong to paint finishes, not the body shape.
    if (normal && !/^(fur_n|sparkle_n|blank_n|matte_n|brushedmetal_normal)$/.test(fileBase(normal.path))) {
      const normalMap = await loadTexture(normal);
      if (normalMap) { material.normalMap = normalMap; material.normalScale = new THREE.Vector2(1, -1); }
    }
    material.roughness = chassis ? 0.55 : 0.34;
    material.metalness = chassis ? 0.25 : 0.12;
    if (!chassis && paint) {
      const skin = skinTextureFor(binding);
      const skinMap = await loadTexture(skin);
      const decalMap = patternTexture ? await loadTexture(patternTexture) : null;
      if (applyBodyPaint(material, { skinMap, decalMap, primary: paint.primary, accent: paint.accent })) painted += 1;
      else if (!material.map) material.color?.set?.(paint.primary); // no paint maps at all: flat team colour
    }
    if (globalThis.RL_CAR_DEBUG) console.log('[rl-car-debug]', JSON.stringify({ mat: material.name, mesh: meshName, chassis, generic: genericName, diffuse: diffuse?.path?.split('/').pop(), painted: Boolean(material.userData.rlPaint), skin: skinTextureFor(binding)?.path?.split('/').pop() }));
    material.needsUpdate = true;
  }));
  return { painted };
}

function paintColors(asset = {}) {
  if (asset.useTeamPaint === false || asset.paintMode === 'off') return null;
  if (asset.paintMode === 'custom' && asset.primaryColor && asset.secondaryColor) return { primary: asset.primaryColor, accent: asset.secondaryColor };
  if (asset.paint?.primary) return { primary: asset.paint.primary, accent: asset.paint.accent || '#111111' };
  return asset.teamNum === 1 ? { primary: '#ff7a1a', accent: '#3d1a05' } : { primary: '#1873ff', accent: '#0a1d3d' };
}

function neutralizeSingleMaterialWheel(root) {
  root.traverse((child) => {
    for (const material of [child.material].flat().filter(Boolean)) {
      material.map = null;
      material.normalMap = null;
      material.color?.set?.('#1f2328');
      material.metalness = 0.35;
      material.roughness = 0.46;
      material.needsUpdate = true;
    }
  });
}

function isAllowedModelUrl(url) {
  return /^http:\/\/127\.0\.0\.1:3174\/user-assets\/car-[a-f0-9]{64}\.glb$/.test(url)
    || /^http:\/\/127\.0\.0\.1:3174\/rl-loadout-assets\/[A-Za-z0-9._~/%-]+\.glb$/.test(url);
}

async function loadGltfScene(url) {
  if (!isAllowedModelUrl(url)) throw Error('Import a local GLB first.');
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error('Saved model is unavailable. Reimport the GLB.');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 32 * 1024 * 1024) throw Error('Model exceeds 32 MB.');
  const packAsset = url.startsWith('http://127.0.0.1:3174/rl-loadout-assets/');
  const baseUrl = url.slice(0, url.lastIndexOf('/') + 1);
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((resource) => {
    if (resource.startsWith('blob:') || /^data:(image\/(png|jpeg|webp)|application\/(octet-stream|gltf-buffer));base64,/.test(resource)) return resource;
    const resolved = new URL(resource, baseUrl).href;
    if (packAsset && resolved.startsWith('http://127.0.0.1:3174/rl-loadout-assets/')) return resolved;
    throw Error('External model resources are blocked.');
  });
  const gltf = await new GLTFLoader(manager).parseAsync(bytes, baseUrl);
  return gltf.scene;
}

// Wheel hubs come from the car skeleton (manifest wheelAnchors, glTF meters: +Y up,
// +Z nose, +X = car's left). Radius: the car's own geometry tells us how far the
// hub sits above the lowest point of the body, so the tyre reaches the ground plane.
function wheelRadiusFor(bodyScene, anchors) {
  const box = new THREE.Box3().setFromObject(bodyScene);
  const hubY = Object.values(anchors).map((p) => Number(p?.[1])).filter(Number.isFinite);
  if (!hubY.length || !Number.isFinite(box.min.y)) return 0.17;
  const averageHub = hubY.reduce((a, b) => a + b, 0) / hubY.length;
  // Tyre bottom a little below the body's lowest point (the body floats over the tyres).
  const radius = averageHub - box.min.y + 0.035;
  return Math.max(0.12, Math.min(0.26, radius));
}

async function addWheels(bodyScene, asset = {}) {
  const wheel = asset.wheel;
  const anchors = asset.wheelAnchors || {};
  if (!wheel?.meshUrl || !Object.keys(anchors).length) return;
  const wheelScene = await loadGltfScene(wheel.meshUrl);
  await applyAssetTextures(wheelScene, wheel, { isWheel: true });
  const wheelMaterials = new Set();
  wheelScene.traverse((child) => {
    for (const material of [child.material].flat().filter(Boolean)) wheelMaterials.add(material);
  });
  if (wheelMaterials.size <= 1) neutralizeSingleMaterialWheel(wheelScene);
  // Wheel meshes are centred on the hub with the axle along X.
  const wheelBox = new THREE.Box3().setFromObject(wheelScene);
  const wheelSize = wheelBox.getSize(new THREE.Vector3());
  const meshRadius = Math.max(wheelSize.y, wheelSize.z) / 2;
  const scale = meshRadius > 0 ? wheelRadiusFor(bodyScene, anchors) / meshRadius : 1;
  // Which X side of the wheel mesh is the rim face: the side whose vertices spread
  // furthest from the axle in the outer slice (spokes/rim) vs. the plain tyre sidewall.
  const outwardSign = rimFaceSign(wheelScene);
  for (const [slot, position] of Object.entries(anchors)) {
    if (!Array.isArray(position) || position.length < 3) continue;
    const clone = wheelScene.clone(true);
    clone.scale.setScalar(scale);
    clone.position.set(Number(position[0]) || 0, Number(position[1]) || 0, Number(position[2]) || 0);
    // +X is the car's left. Face the rim away from the car on both sides.
    const carSide = slot.toUpperCase().includes('L') ? 1 : -1;
    if (outwardSign !== carSide) clone.rotation.y = Math.PI;
    clone.name = `wheel-${slot}`;
    bodyScene.add(clone);
  }
}

function rimFaceSign(wheelScene) {
  let pos = 0; let neg = 0;
  const v = new THREE.Vector3();
  wheelScene.updateMatrixWorld(true);
  wheelScene.traverse((child) => {
    const attribute = child.geometry?.attributes?.position;
    if (!attribute) return;
    for (let i = 0; i < attribute.count; i += 3) {
      v.fromBufferAttribute(attribute, i).applyMatrix4(child.matrixWorld);
      // Spokes/rim detail: vertices near the hub face, not on the tread.
      const r = Math.hypot(v.y, v.z);
      if (v.x > 0) pos += 1 / (1 + r * 20); else neg += 1 / (1 + r * 20);
    }
  });
  return pos >= neg ? 1 : -1;
}

export function createCarRenderer(container) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(800, 500);
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Neutral keeps team colours true (ACES pushes saturated blue toward purple).
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.domElement.style.cssText = 'width:100%;height:auto;display:block;touch-action:none';
  container.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1.6, 0.01, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enablePan = false;
  controls.minDistance = 2; controls.maxDistance = 12;
  // Studio-style lighting: soft sky/ground fill, a key light front-left, rim from behind.
  scene.add(new THREE.HemisphereLight(0xe8f0ff, 0x2a2c33, 1.6));
  for (const [x, y, z, strength] of [[5, 7, 6, 3.2], [-6, 4, -2, 1.6], [0, 3, -7, 2.2]]) {
    const light = new THREE.DirectionalLight(0xffffff, strength);
    light.position.set(x, y, z); scene.add(light);
  }
  let object = null;
  let disposed = false;
  let generation = 0;
  const render = () => { if (!disposed) renderer.render(scene, camera); };
  controls.addEventListener('change', render);
  const resetCamera = () => { camera.position.set(3.6, 1.45, 4.0); controls.target.set(0, -0.05, 0); controls.update(); render(); };
  const clear = () => { if (object) { scene.remove(object); disposeObject(object); object = null; } render(); };
  const setObject = (next) => {
    clear();
    const box = new THREE.Box3().setFromObject(next);
    const size = box.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(extent) || extent <= 0) { disposeObject(next); throw Error('Model has no visible geometry.'); }
    const group = new THREE.Group();
    next.position.sub(box.getCenter(new THREE.Vector3()));
    group.add(next); group.scale.setScalar(3 / extent);
    object = group; scene.add(group); resetCamera();
  };
  return {
    demo() { generation++; setObject(demoCar()); },
    async load(url, asset = {}) {
      const version = ++generation;
      clear();
      const scene = await loadGltfScene(url);
      try {
        await applyAssetTextures(scene, asset);
        await addWheels(scene, asset);
      } catch (error) {
        console.warn('[rl-car-lab] Partial asset composition failed:', error);
      }
      if (disposed || version !== generation) { disposeObject(scene); return false; }
      setObject(scene); return true;
    },
    resetCamera,
    png() { if (!object || disposed) throw Error('Load a model before saving.'); render(); return renderer.domElement.toDataURL('image/png'); },
    dispose() { generation++; clear(); disposed = true; controls.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); }
  };
}
