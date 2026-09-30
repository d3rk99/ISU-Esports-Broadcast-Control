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
    async load(url) {
      const version = ++generation;
      clear();
      // Only our imported content-addressed models, never arbitrary web models.
      if (!/^http:\/\/127\.0\.0\.1:3174\/user-assets\/car-[a-f0-9]{64}\.glb$/.test(url)) throw Error('Import a local GLB first.');
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw Error('Saved model is unavailable. Reimport the GLB.');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 32 * 1024 * 1024) throw Error('Model exceeds 32 MB.');
      const manager = new THREE.LoadingManager();
      manager.setURLModifier((resource) => {
        if (!resource.startsWith('blob:') && !/^data:(image\/(png|jpeg|webp)|application\/(octet-stream|gltf-buffer));base64,/.test(resource)) throw Error('External model resources are blocked.');
        return resource;
      });
      const gltf = await new GLTFLoader(manager).parseAsync(bytes, '');
      if (disposed || version !== generation) { disposeObject(gltf.scene); return false; }
      setObject(gltf.scene); return true;
    },
    resetCamera,
    png() { if (!object || disposed) throw Error('Load a model before saving.'); render(); return renderer.domElement.toDataURL('image/png'); },
    dispose() { generation++; clear(); disposed = true; controls.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); }
  };
}
