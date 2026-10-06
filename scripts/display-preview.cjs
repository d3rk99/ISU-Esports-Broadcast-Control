// Offline preview of the audience display presets (/displays/station.html) with fake data.
// Usage (headless only): env -u WAYLAND_DISPLAY xvfb-run -a npx electron --ozone-platform=x11 --no-sandbox scripts/display-preview.cjs <outdir>
// Writes <outdir>/<preset>-s<station>.png (1280x720).
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const outDir = process.argv.slice(2).find((a) => !a.endsWith('.cjs') && a !== '.' && !a.startsWith('--')) || 'display-preview';
fs.mkdirSync(outDir, { recursive: true });

const home = [['BENGAL', 'DPS', 'Hanzo', 1], ['ROARANGE', 'Support', 'Ana', 2], ['TANKY', 'Tank', 'Reinhardt', 3], ['SPARKY', 'DPS', 'Tracer', 4], ['NOVA', 'Support', 'Mercy', 5]];
const away = [['BRONCO1', 'DPS', 'Reaper', 6], ['BRONCO2', 'Support', 'Kiriko', 7], ['BRONCO3', 'Tank', 'Winston', 8], ['BRONCO4', 'DPS', 'Sojourn', 9], ['BRONCO5', 'Support', 'Lucio', 10]];
const roster = (list) => list.map(([handle, role, character, stageStation]) => ({ handle, name: '', role, character, stageStation }));
const game = {
  teams: [
    { name: 'IDAHO STATE', shortName: 'ISU', color: '#f47920', score: 2 },
    { name: 'BOISE STATE', shortName: 'BSU', color: '#2d6cdf', score: 1 }
  ],
  match: { event: 'COLLEGIATE ESPORTS', round: 'WEEK 4' }, activeMap: 1,
  mapRows: [{ map: 'Busan' }, { map: "King's Row" }],
  characterArt: { Hanzo: { url: '/assets/overwatch/heroes/hanzo.webp' }, Reaper: { url: '/assets/overwatch/heroes/reaper.webp' } },
  overwatchLastMapStats: { 1: { map: 'Busan', hero: 'Hanzo', stats: { elims: 18, deaths: 5, assists: 4, damage: 11240, healing: 0, mitigation: 820 } } },
  rosters: { varsity: roster(home) }, awayRosters: { varsity: roster(away) }
};
const state = { selectedGame: 'overwatch', activeRoster: 'varsity', games: { overwatch: game }, displays: { stations: {} } };

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/state')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state)); return; }
  if (req.url.startsWith('/events')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); return; }
  const file = path.join(__dirname, '../public', decodeURIComponent(req.url.split('?')[0]));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

const SHOTS = [['idle', 1], ['intro', 1], ['player', 1], ['player', 6], ['banner', 1], ['banner', 3], ['banner', 5], ['banner', 8], ['score', 1]];
app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const errors = [];
  // One window per station; presets switch live through the page's render() (same path as SSE).
  const wins = new Map();
  for (const [preset, station] of SHOTS) {
    state.displays.stations = { [station]: { preset, team: '' } };
    if (!wins.has(station)) {
      const win = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { offscreen: true } });
      win.webContents.on('console-message', (event) => { if (['error'].includes(event.level) && !/Security Warning/.test(event.message)) errors.push(`s${station}: ${event.message}`); });
      await win.loadURL(`http://127.0.0.1:${server.address().port}/displays/station.html?station=${station}`).catch((e) => errors.push(String(e)));
      wins.set(station, win);
    }
    const win = wins.get(station);
    await new Promise((r) => setTimeout(r, 300));
    await win.webContents.executeJavaScript(`window.__station.render(${JSON.stringify(state)})`);
    await new Promise((r) => setTimeout(r, 1400));
    fs.writeFileSync(path.join(outDir, `${preset}-s${station}.png`), (await win.webContents.capturePage()).toPNG());
  }
  console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'no console errors');
  app.exit(0);
});
