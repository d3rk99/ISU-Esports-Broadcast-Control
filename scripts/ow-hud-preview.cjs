// Offline Overwatch scoreboard + player stat card preview (fake OCR data) over a frame.
// Usage (headless only, never on a real screen):
//   env -u WAYLAND_DISPLAY xvfb-run -a npx electron --ozone-platform=x11 --no-sandbox scripts/ow-hud-preview.cjs <out.png> [background.png]
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2).filter((a) => !a.endsWith('.cjs') && a !== '.' && !a.startsWith('--'));
const [outFile, background = ''] = args;
const p = (name, ultimate, e, a, d, dmg, heal, mit) => ({ name, ultimate, elims: e, assists: a, deaths: d, damage: dmg, healing: heal, mitigation: mit });
const game = {
  teams: [
    { name: 'IDAHO STATE', shortName: 'ISU', color: '#f47920', score: 1, detailScore: 1 },
    { name: 'BOISE STATE', shortName: 'BSU', color: '#2d6cdf', score: 0, detailScore: 0 }
  ],
  match: { event: 'COLLEGIATE ESPORTS', round: 'REGULAR SEASON', format: 'First to 3' }, seriesLength: 5, activeMap: 1,
  mapRows: [{ map: 'Busan', mode: 'Control' }, { map: "King's Row", mode: 'Hybrid' }],
  overwatchShowStatCards: true,
  characterArt: { Hanzo: { url: '/assets/overwatch/heroes/hanzo.webp' }, Ana: { url: '/assets/overwatch/heroes/ana.webp' }, Reinhardt: { url: '/assets/overwatch/heroes/reinhardt.webp' } },
  rosters: { varsity: [{ handle: 'BENGAL', character: 'Hanzo' }, { handle: 'ROARANGE', character: 'Ana' }, { handle: 'TANKY', character: 'Reinhardt' }] },
  awayRosters: { varsity: [] },
  overwatchOcr: { live: { teams: {
    home: { players: [p('BENGAL', 'READY', 12, 4, 3, 8421, 0, 1210), p('ROARANGE', 64, 2, 15, 1, 1840, 9734, 0), p('TANKY', 38, 6, 7, 4, 5122, 0, 14210), p('SPARKY', 12, 9, 3, 5, 7301, 220, 0), p('NOVA', 87, 1, 18, 2, 990, 11402, 340)] },
    away: { players: [p('BRONCO1', 55, 7, 2, 6, 6120, 0, 0), p('BRONCO2', 'READY', 5, 9, 4, 3011, 8120, 0), p('BRONCO3', 22, 3, 5, 7, 4420, 0, 9870), p('BRONCO4', 71, 8, 1, 6, 7012, 0, 0), p('BRONCO5', 4, 0, 14, 3, 640, 10221, 0)] }
  } } }
};
const state = { selectedGame: 'overwatch', activeRoster: 'varsity', games: { overwatch: game } };
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/state')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state)); return; }
  if (req.url.startsWith('/events')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); return; }
  const filename = path.join(__dirname, '../public', decodeURIComponent(req.url.split('?')[0]));
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) { res.writeHead(404); res.end(); return; }
  const ext = path.extname(filename);
  res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.webp': 'image/webp' }[ext] || 'application/octet-stream');
  res.end(fs.readFileSync(filename));
});
app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: false, width: 1920, height: 1080, webPreferences: { offscreen: true } });
  await win.loadURL(`http://127.0.0.1:${server.address().port}/overlays/scoreboard.html?output=fill&preview=1`);
  if (background) {
    const data = fs.readFileSync(background).toString('base64');
    await win.webContents.executeJavaScript(`document.body.style.background = 'url(data:image/png;base64,${data}) center/1920px 1080px no-repeat'`);
  }
  if (process.env.ANIM) {
    // Frame strip of the stat-card slide: toggle on, capture at times; toggle off, capture again.
    const shot = async (tag) => fs.writeFileSync(outFile.replace(/\.png$/, `-${tag}.png`), (await win.webContents.capturePage()).toPNG());
    const setShow = (on) => win.webContents.executeJavaScript(`(() => { const s = ${JSON.stringify(state)}; s.games.overwatch.overwatchShowStatCards = ${on}; window.__owRender ? window.__owRender(s) : null; })()`);
    await new Promise((r) => setTimeout(r, 1500));
    await setShow(false); await new Promise((r) => setTimeout(r, 1500));
    await setShow(true);
    for (const ms of [150, 350, 600, 1100]) { await new Promise((r) => setTimeout(r, ms - (ms === 150 ? 0 : 0))); await shot(`in-${ms}`); }
    await setShow(false);
    for (const ms of [150, 400, 1100]) { await new Promise((r) => setTimeout(r, ms)); await shot(`out-${ms}`); }
    app.exit(0); return;
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
  fs.writeFileSync(outFile, (await win.webContents.capturePage()).toPNG());
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
