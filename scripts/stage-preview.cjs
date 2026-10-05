// Offline preview of the OBS stage page (public/overlays/stage.html) at 1280x720, one PNG per mode.
// Usage: npx electron scripts/stage-preview.cjs <outDir>
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const outDir = process.env.STAGE_OUT || process.argv.slice(2).filter((a) => !a.endsWith('.cjs') && a !== '.' && !a.startsWith('--'))[0] || '/tmp/stage-preview';
console.log('outDir', outDir);
const icon = '/assets/overwatch/hero-portraits/tracer.png';
const state = {
  selectedGame: 'overwatch', activeRoster: 'varsity',
  stageObs: { stations: { 3: { mode: 'hold' } } },
  games: { overwatch: {
    teams: [{ name: 'IDAHO STATE', shortName: 'ISU', color: '#f47920', score: 2 }, { name: 'BOISE STATE', shortName: 'BSU', color: '#2d6cdf', score: 1 }],
    match: { event: 'COLLEGIATE ESPORTS' }, activeMap: 0, mapRows: [{ map: 'Busan' }],
    rosters: { varsity: [{ handle: 'SPARKY', name: 'Sam Rivers', role: 'Damage', character: 'Tracer', stageStation: 3 }] }, awayRosters: { varsity: [] },
    characterArt: { Tracer: { url: icon } },
    overwatchLastMapStats: { 3: { stats: { elims: 24, deaths: 6, assists: 9, damage: 11840, healing: 0, mitigation: 420 }, hero: 'Tracer' } }
  } }
};
let streams = [];
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/state')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state)); return; }
  if (req.url.startsWith('/events')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); streams.push(res); return; }
  const file = path.join(__dirname, '../public', decodeURIComponent(req.url.split('?')[0]));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fs.mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { offscreen: true } });
  win.webContents.setFrameRate(30);
  await win.loadURL(`http://127.0.0.1:${server.address().port}/overlays/stage.html?station=3`);
  await new Promise((r) => setTimeout(r, 800));
  // Count painted frames over 2 s on the hold scene: proves the page keeps moving on its own.
  let frames = 0; win.webContents.on('paint', () => { frames += 1; });
  win.webContents.startPainting?.();
  await new Promise((r) => setTimeout(r, 2000));
  const fps = frames / 2;
  for (const mode of ['hold', 'intro', 'player', 'score', 'blackout']) {
    state.stageObs.stations[3].mode = mode;
    for (const s of streams) s.write(`data: ${JSON.stringify(state)}\n\n`);
    await new Promise((r) => setTimeout(r, 1300));
    fs.writeFileSync(path.join(outDir, `${mode}.png`), (await win.webContents.capturePage()).toPNG());
  }
  console.log(JSON.stringify({ paintFps: fps, modes: 5 }));
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
