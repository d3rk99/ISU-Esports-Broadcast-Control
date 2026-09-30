const { app, BrowserWindow, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateCarGlb } = require('../electron/rl-car-assets.cjs');
// Isolated Vite origin + in-memory telemetry/IPC fixtures. Never touches the live controller.
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const server = await createServer({ root: path.resolve(__dirname, '..'), server: { port: 0 }, plugins: [{
    name: 'car-lab-test-page', configureServer(vite) {
      vite.middlewares.use('/car-lab-smoke', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html><body style="background:#090b10"><div id="app"></div></body></html>'); });
    }
  }] });
  await server.listen();
  const window = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: { offscreen: true } });
  await window.loadURL(`http://localhost:${server.httpServer.address().port}/car-lab-smoke`);
  const result = await window.webContents.executeJavaScript(`(async () => {
    const { demoCar, disposeObject } = await import('/src/rl-car-renderer.js');
    const { GLTFExporter } = await import('/node_modules/three/examples/jsm/exporters/GLTFExporter.js');
    const { openCarLab } = await import('/src/rl-car-lab.js');
    const sample = demoCar();
    const glb = await new GLTFExporter().parseAsync(sample, { binary: true });
    disposeObject(sample);
    const game = { rocketLeague: { live: { players: [{ id: 'fixture', name: 'TEST PLAYER', teamNum: 0, loadout: ['body_fixture', 'decal_fixture'] }] } } };
    const modelUrl = 'http://127.0.0.1:3174/user-assets/car-' + 'a'.repeat(64) + '.glb';
    const originalFetch = window.fetch;
    window.fetch = (url, options) => url === modelUrl ? Promise.resolve(new Response(glb)) : originalFetch(url, options);
    let png = '';
    window.isuDesktop = {
      pickCarModel: async () => ({ name: 'test-fixture.glb', url: modelUrl }),
      saveCarRender: async (data) => { png = data; return { url: '/assets/test-car.png' }; }
    };
    const waitFor = async (predicate) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 50)); } throw Error('Timed out: ' + document.querySelector('#car-status')?.textContent); };
    openCarLab(() => game, value => { game.rocketLeague.carRenderer = value; });
    document.querySelector('#car-demo').click();
    if (!document.querySelector('#car-save').disabled) throw Error('Demo can be saved to real player');
    document.querySelector('#car-import').click();
    await waitFor(() => !document.querySelector('#car-save').disabled);
    document.querySelector('#car-save').click();
    await waitFor(() => Boolean(game.rocketLeague.carRenderer?.renders));
    const image = png;
    document.querySelector('#car-enabled').click();
    if (!game.rocketLeague.carRenderer.enabled) throw Error('Enable setting not saved');
    document.querySelector('#car-scope').value = 'loadout';
    document.querySelector('#car-scope').dispatchEvent(new Event('change'));
    if (!document.querySelector('#car-save').disabled) throw Error('Stale model can be assigned to different scope');
    document.querySelector('#car-close').click();
    if (document.querySelector('#rl-car-lab')) throw Error('Dialog not disposed');
    openCarLab(() => game, value => { game.rocketLeague.carRenderer = value; });
    document.querySelector('#car-saved').click();
    await waitFor(() => !document.querySelector('#car-save').disabled);
    return { png: image, glb: Array.from(new Uint8Array(glb)), status: document.querySelector('#car-status').textContent };
  })()`);
  validateCarGlb(Buffer.from(result.glb));
  const image = nativeImage.createFromDataURL(result.png);
  assert.deepEqual(image.getSize(), { width: 800, height: 500 });
  const pixels = image.toBitmap();
  let transparent = 0; let opaque = 0;
  for (let i = 3; i < pixels.length; i += 4) { if (pixels[i] === 0) transparent++; if (pixels[i] > 200) opaque++; }
  assert.ok(transparent > 10000 && opaque > 1000, 'PNG should contain visible geometry and transparent background');
  const directory = path.join(__dirname, '../release/car-render-lab');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'demo-render.png'), image.toPNG());
  fs.writeFileSync(path.join(directory, 'lab-preview.png'), (await window.webContents.capturePage()).toPNG());
  console.log('PASS: real WebGL, embedded GLB import, transparent PNG, mapping save/reload, demo guard, stale-selection guard, and dialog disposal.');
  window.destroy(); await server.close(); app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
