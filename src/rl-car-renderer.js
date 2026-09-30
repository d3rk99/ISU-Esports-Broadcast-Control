import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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

function teamPaint(asset = {}) {
  if (asset.useTeamPaint === false) return null;
  if (asset.paintMode === 'custom' && asset.primaryColor && asset.secondaryColor) {
    return { primary: new THREE.Color(asset.primaryColor), secondary: new THREE.Color(asset.secondaryColor) };
  }
  return asset.teamNum === 1
    ? { primary: new THREE.Color('#f47920'), secondary: new THREE.Color('#ffd35a') }
    : { primary: new THREE.Color('#1597ff'), secondary: new THREE.Color('#82fff7') };
}

function decalTextureScore(materialName, texture) {
  const baseScore = textureScore(materialName, texture);
  const file = fileBase(texture.path);
  const decalBonus = /skin|decal|flame|stripe|lines|block|paint/i.test(file) ? 40 : 0;
  return baseScore + decalBonus;
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

function bindingTextureName(binding = {}) {
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

function bestPaintMask(textures = []) {
  return textures
    .filter((texture) => texture.role === 'mask')
    .map((texture) => {
      const file = fileBase(texture.path);
      let score = 0;
      if (/body|paint|skin|bevel|blank/.test(file)) score += 60;
      if (/rgb/.test(file)) score += 20;
      if (/part|chassis|chasis|trim|wheel/.test(file)) score -= 80;
      return { texture, score };
    })
    .sort((a, b) => b.score - a.score)[0]?.texture || null;
}

function boundOrBestTexture(asset, materialName, meshName, role, texturesByPath, scorer = textureScore) {
  const textures = Array.isArray(asset.textures) ? asset.textures : [];
  const binding = fallbackBindingForMaterial(asset, materialName, meshName);
  const bound = textureFromPath(texturesByPath, binding?.[role]);
  if (bound) return bound;
  return bestTexture(materialName, textures, role, scorer);
}

function isPaintableMaterial(asset, materialName, meshName, binding) {
  const hint = materialHint(materialName, meshName);
  const key = compactKey(`${materialName} ${meshName} ${bindingTextureName(binding)}`);
  if (/chassis|chasis|parts|trim|glass|window|wheel|tire|tyre/.test(key)) return false;
  return hint === 'body' || /body|paint|skin|premium|blankskin/.test(key);
}

function decalDiffuseFromBindings(decal = {}, materialName = '', meshName = '', texturesByPath) {
  const bindings = decal.materialBindings || {};
  const preferredBindings = [
    fallbackBindingForMaterial(decal, materialName, meshName),
    ...Object.values(bindings)
  ].filter(Boolean);
  for (const binding of preferredBindings) {
    const paths = [binding.decal, ...(binding.other || [])].filter(Boolean);
    for (const pathValue of paths) {
      const texture = textureFromPath(texturesByPath, pathValue);
      if (texture?.role === 'diffuse' && /skin|decal|flame|stripe|paint/i.test(texture.path)) return texture;
    }
  }
  return null;
}

function patchPaintShader(material, maskMap, paint) {
  material.userData.rlPaint = { maskMap, paint };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.rlMaskMap = { value: maskMap };
    shader.uniforms.rlPrimary = { value: paint.primary };
    shader.uniforms.rlSecondary = { value: paint.secondary };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_pars_fragment>', '#include <map_pars_fragment>\nuniform sampler2D rlMaskMap;\nuniform vec3 rlPrimary;\nuniform vec3 rlSecondary;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec4 rlMask = texture2D(rlMaskMap, vMapUv);
        diffuseColor.rgb = mix(diffuseColor.rgb, rlPrimary, clamp(rlMask.r * 0.72, 0.0, 1.0));
        diffuseColor.rgb = mix(diffuseColor.rgb, rlSecondary, clamp(rlMask.g * 0.58, 0.0, 1.0));
      `);
  };
}

async function applyAssetTextures(root, asset = {}) {
  const baseTextures = (Array.isArray(asset.textures) ? asset.textures : []).filter((texture) => texture?.url);
  const decalTextures = (Array.isArray(asset.decal?.textures) ? asset.decal.textures.map((texture) => ({ ...texture, decal: true })) : []).filter((texture) => texture?.url);
  if (!baseTextures.length && !decalTextures.length) return;
  const loader = new THREE.TextureLoader();
  const loaded = new Map();
  const loadTexture = async (texture) => {
    if (!loaded.has(texture.url)) {
      loaded.set(texture.url, loader.loadAsync(texture.url).then((map) => {
        map.flipY = false;
        if (texture.role === 'diffuse') map.colorSpace = THREE.SRGBColorSpace;
        return map;
      }));
    }
    return loaded.get(texture.url);
  };
  const baseTexturesByPath = textureMap(baseTextures);
  const decalTexturesByPath = textureMap(decalTextures);
  const paint = teamPaint(asset);
  const jobs = [];
  root.traverse((child) => {
    if (!child.isMesh) return;
    const materials = [child.material].flat().filter(Boolean);
    for (const material of materials) jobs.push({ meshName: child.name || '', material });
  });
  await Promise.all(jobs.map(async ({ meshName, material }) => {
    const binding = fallbackBindingForMaterial(asset, material.name, meshName);
    const boundDiffuse = textureFromPath(baseTexturesByPath, binding?.diffuse);
    const boundNormal = textureFromPath(baseTexturesByPath, binding?.normal);
    const boundMask = textureFromPath(baseTexturesByPath, binding?.mask);
    const paintable = isPaintableMaterial(asset, material.name, meshName, binding);
    const diffuse = boundDiffuse || boundOrBestTexture(asset, material.name, meshName, 'diffuse', baseTexturesByPath);
    const decalDiffuse = paintable && asset.decal
      ? (decalDiffuseFromBindings(asset.decal, material.name, meshName, decalTexturesByPath)
        || bestTexture(material.name, decalTextures, 'diffuse', decalTextureScore))
      : null;
    const normal = boundNormal || boundOrBestTexture(asset, material.name, meshName, 'normal', baseTexturesByPath);
    const mask = boundMask || (paintable ? bestPaintMask(baseTextures) : boundOrBestTexture(asset, material.name, meshName, 'mask', baseTexturesByPath));
    if (diffuse && (boundDiffuse || textureScore(material.name, diffuse) > 0)) {
      material.map = await loadTexture(diffuse);
      material.color?.set?.(0xffffff);
    }
    if (paintable && decalDiffuse && decalTextureScore(material.name, decalDiffuse) >= Math.max(20, textureScore(material.name, diffuse || {}))) {
      material.map = await loadTexture(decalDiffuse);
      material.color?.set?.(0xffffff);
    }
    if (normal && (boundNormal || textureScore(material.name, normal) > 0)) {
      material.normalMap = await loadTexture(normal);
      material.normalScale = new THREE.Vector2(1, -1);
    }
    if (paintable && paint && mask && (boundMask || textureScore(material.name, mask) > 0) && material.map) patchPaintShader(material, await loadTexture(mask), paint);
    material.needsUpdate = true;
  }));
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

async function addWheels(bodyScene, asset = {}) {
  const wheel = asset.wheel;
  const anchors = asset.wheelAnchors || {};
  if (!wheel?.meshUrl || !Object.keys(anchors).length) return;
  const wheelScene = await loadGltfScene(wheel.meshUrl);
  await applyAssetTextures(wheelScene, wheel);
  const wheelMaterials = new Set();
  wheelScene.traverse((child) => {
    for (const material of [child.material].flat().filter(Boolean)) wheelMaterials.add(material);
  });
  if (wheelMaterials.size <= 1) neutralizeSingleMaterialWheel(wheelScene);
  const wheelBox = new THREE.Box3().setFromObject(wheelScene);
  const wheelSize = wheelBox.getSize(new THREE.Vector3());
  const wheelDiameter = Math.max(wheelSize.y, wheelSize.z, wheelSize.x);
  const wheelScale = Number.isFinite(wheelDiameter) && wheelDiameter > 0 ? (0.34 / wheelDiameter) * 0.95 : 0.95;
  for (const [slot, position] of Object.entries(anchors)) {
    if (!Array.isArray(position) || position.length < 3) continue;
    const clone = wheelScene.clone(true);
    const side = slot.includes('R') ? -1 : 1;
    clone.scale.setScalar(wheelScale);
    clone.position.set((Number(position[0]) || 0) * 1.16 + side * 0.035, Number(position[1]) || 0, Number(position[2]) || 0);
    if (slot.includes('L')) clone.rotation.y = Math.PI;
    bodyScene.add(clone);
  }
}

export function createCarRenderer(container) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(800, 500);
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.domElement.style.cssText = 'width:100%;height:auto;display:block;touch-action:none';
  container.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1.6, 0.01, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enablePan = false;
  controls.minDistance = 2; controls.maxDistance = 12;
  scene.add(new THREE.HemisphereLight(0xddeeff, 0x303040, 2.6));
  for (const [x, y, z, strength] of [[4, 6, 3, 4], [-4, 3, -3, 3]]) {
    const light = new THREE.DirectionalLight(0xffffff, strength);
    light.position.set(x, y, z); scene.add(light);
  }
  let object = null;
  let disposed = false;
  let generation = 0;
  const render = () => { if (!disposed) renderer.render(scene, camera); };
  controls.addEventListener('change', render);
  const resetCamera = () => { camera.position.set(4, 2.4, 4); controls.target.set(0, 0, 0); controls.update(); render(); };
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
