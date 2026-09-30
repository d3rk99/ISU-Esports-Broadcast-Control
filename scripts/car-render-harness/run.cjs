// Offline car render check: serves the repo + the loadout pack on 127.0.0.1:3174
// (same URLs the controller uses), builds a car purely from a Stats API style
// packet, and saves PNGs. Usage:
//   RL_PACK=/path/to/rl-loadout-assets npx electron scripts/car-render-harness/run.cjs <cases.json> <outDir>
// cases.json: [{ "name": "...", "player": {Loadout:[...], TeamNum:0}, "teams": [...] }]
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..', '..');
const packRoot = process.env.RL_PACK || path.join(repo, 'assests', 'rl-loadout-assets');
const [casesPath, outDir] = process.argv.slice(-2);
const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.glb': 'model/gltf-binary', '.json': 'application/json', '.mat': 'text/plain' };

function manifestSummary() {
  const manifest = JSON.parse(fs.readFileSync(path.join(packRoot, 'manifest.json'), 'utf8'));
  const csv = fs.readFileSync(path.join(repo, 'assests', 'rocket-league-items.csv'), 'latin1').split(/\r?\n/)
    .map((line) => line.match(/^([^,]*),([^,]*),([^,]*),(.*)$/)).filter(Boolean)
    .map((m) => ({ productId: m[1], type: m[2], internalName: m[3].split('.').pop(), displayName: m[4] }));
  const key = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const aliases = (asset, type) => {
    const out = new Set([asset.id, asset.productId, asset.displayName]);
    for (const item of csv) if (item.type === type && (key(item.internalName) === key(asset.id))) { out.add(item.productId); out.add(item.internalName); }
    return [...out].filter(Boolean);
  };
  return {
    available: true,
    bodies: manifest.bodies.map((b) => ({ ...b, aliases: aliases(b, 'Body') })),
    wheels: manifest.wheels.map((w) => ({ ...w, aliases: aliases(w, 'Wheels') })),
    decals: manifest.decals.map((d) => ({ ...d, aliases: aliases(d, 'Skin') }))
  };
}

function parseMat(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([A-Za-z]+)(?:\[(\d+)])?=(.+)$/);
    if (!m) continue;
    const k = m[1].toLowerCase();
    if (k === 'other') (out.other = out.other || []).push(m[3].trim()); else out[k] = m[3].trim();
  }
  return out;
}

// Same shape the controller's rl-car:get-asset-details returns.
function details(asset) {
  if (!asset) return null;
  const url = (p) => `http://127.0.0.1:3174/rl-loadout-assets/${p}`;
  const byName = new Map((asset.textures || []).map((t) => [path.basename(t.path, '.png').toLowerCase(), t.path]));
  const materialBindings = {};
  for (const mat of asset.materials || []) {
    const file = path.join(packRoot, asset.folder || '', `${mat}.mat`);
    if (!fs.existsSync(file)) continue;
    const parsed = parseMat(fs.readFileSync(file, 'utf8'));
    const b = {};
    for (const role of ['diffuse', 'normal', 'mask']) if (parsed[role] && byName.has(parsed[role].toLowerCase())) b[role] = byName.get(parsed[role].toLowerCase());
    for (const other of parsed.other || []) {
      const p = byName.get(other.toLowerCase());
      if (p) (b.other = b.other || []).push(p);
    }
    if (Object.keys(b).length) materialBindings[mat] = b;
  }
  return {
    ...asset,
    meshUrl: asset.mesh ? url(asset.mesh) : '',
    textures: (asset.textures || []).map((t) => ({ ...t, url: url(t.path) })),
    materialBindings
  };
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let file;
  if (u.pathname.startsWith('/rl-loadout-assets/')) file = path.join(packRoot, decodeURIComponent(u.pathname.slice('/rl-loadout-assets/'.length)));
  else file = path.join(repo, decodeURIComponent(u.pathname));
  if (!file.startsWith(repo) && !file.startsWith(packRoot)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    res.end(data);
  });
});

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(3174, '127.0.0.1', r));
  fs.mkdirSync(outDir, { recursive: true });
  const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
  const summary = manifestSummary();
  const win = new BrowserWindow({ width: 820, height: 540, show: false, webPreferences: { offscreen: true } });
  const logs = [];
  win.webContents.on('console-message', (_e, _l, message) => logs.push(message));
  await win.loadURL('http://127.0.0.1:3174/scripts/car-render-harness/harness.html');
  await win.webContents.executeJavaScript('new Promise(r => { const t = setInterval(() => { if (window.harness?.ready) { clearInterval(t); r(); } }, 50); })');
  const report = [];
  for (const c of cases) {
    const composed = await win.webContents.executeJavaScript(`(() => {
      const index = harness.buildAssetIndex(${JSON.stringify(summary)});
      const car = harness.composeCar(${JSON.stringify(c.player)}, ${JSON.stringify(c.teams || [])}, index);
      return { body: car.body?.id || null, decal: car.decal?.id || null, wheel: car.wheel?.id || null, paint: car.paint, teamNum: car.teamNum, missing: car.missing, notes: car.notes };
    })()`);
    const find = (list, id) => list.find((a) => a.id === id);
    const body = details(find(summary.bodies, composed.body));
    const decal = details(find(summary.decals, composed.decal));
    const wheel = details(find(summary.wheels, composed.wheel));
    let ok = false; let error = '';
    if (body) {
      const asset = { name: body.displayName, bodyId: body.id, url: body.meshUrl, textures: body.textures, materialBindings: body.materialBindings, wheelAnchors: body.wheelAnchors, decal, wheel, paint: composed.paint, teamNum: composed.teamNum };
      try {
        ok = await win.webContents.executeJavaScript(`(async () => {
          // One renderer for the whole run: creating/disposing WebGL contexts per car
          // made the first frame come back blank on software GL.
          window.r = window.r || harness.createCarRenderer(document.getElementById('stage'));
          return await window.r.load(${JSON.stringify(body.meshUrl)}, ${JSON.stringify(asset)});
        })()`);
        const png = await win.webContents.executeJavaScript('window.r.png()');
        fs.writeFileSync(path.join(outDir, `${c.name}.png`), Buffer.from(png.split(',')[1], 'base64'));
      } catch (e) { error = String(e.message || e); }
    }
    report.push({ name: c.name, ok, error, ...composed });
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ report, logs: logs.filter((l) => l.includes("rl-car-debug")) }, null, 2));
  console.log(JSON.stringify(report.map((r) => ({ n: r.name, ok: r.ok, b: r.body, d: r.decal, w: r.wheel, miss: r.missing.map((m) => m.slot + ':' + m.name), err: r.error }))));
  app.exit(0);
});
