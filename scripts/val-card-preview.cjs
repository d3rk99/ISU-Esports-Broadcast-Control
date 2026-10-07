// Headless preview of VALORANT player cards on the station page (agent art from the board reader).
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const outDir = process.env.OUT || 'val-card-preview'; fs.mkdirSync(outDir, { recursive: true });
const agents = ['Viper', 'Astra', 'Yoru', 'Jett', 'Sova', 'Neon', 'Viper', 'Astra', 'Tejo', 'Sova'];
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const characterArt = Object.fromEntries(fs.readdirSync(path.join(__dirname, '../public/assets/valorant/agents')).map((f) => { const n = f.replace('.webp', ''); const name = n === 'kay-o' ? 'KAY/O' : n[0].toUpperCase() + n.slice(1); return [name, { url: `/assets/valorant/agents/${f}` }]; }));
const names = ['Sn0wfal', 'BaldReaper', 'newx', 'Eagl3', 'Ishnarb', 'santi', 'glowstick', 'nyv', 'CWTJ', 'Mexican Sova'];
const live = (i) => ({ name: names[i], agent: slug(agents[i]), kills: 3, deaths: 0, assists: 0, credits: 2600, ultimate: '3/9', weapon: 'classic', shield: 'light' });
const roster = (from) => [0, 1, 2, 3, 4].map((k) => ({ handle: names[from + k], name: '', role: '', character: '', stageStation: from + k + 1 }));
const game = { teams: [{ name: 'IDAHO STATE', shortName: 'ISU', color: '#f47920' }, { name: 'BOISE STATE', shortName: 'BSU', color: '#2d6cdf' }], match: { event: 'COLLEGIATE VALORANT' }, characterArt,
  rosters: { varsity: roster(0) }, awayRosters: { varsity: roster(5) },
  lastGameStats: Object.fromEntries([0,1,2,3,4,5,6,7,8,9].map((i) => [i + 1, { game: 'valorant', handle: names[i], map: 'Ascent', character: slug(agents[i]), stats: { kills: 18 - i, deaths: 9 + (i % 4), assists: 3 + i } }])),
  valorantBoard: { live: { teams: { home: { players: [0, 1, 2, 3, 4].map(live) }, away: { players: [5, 6, 7, 8, 9].map(live) } } } } };
const state = { selectedGame: 'valorant', activeRoster: 'varsity', games: { valorant: game }, displays: { stations: Object.fromEntries(Array.from({ length: 10 }, (_v, i) => [i + 1, { preset: 'player', team: '' }])) } };
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/state')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state)); return; }
  if (req.url.startsWith('/events') || req.url.startsWith('/ws')) { res.writeHead(404); res.end(); return; }
  const file = path.join(__dirname, '../public', decodeURIComponent(req.url.split('?')[0]));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json' }[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  for (const station of [1, 2, 4, 6, 9]) {
    const win = new BrowserWindow({ show: false, width: 1920, height: 1080, webPreferences: { offscreen: true } });
    await win.loadURL(`http://127.0.0.1:${server.address().port}/displays/station.html?station=${station}`);
    await new Promise((r) => setTimeout(r, 400));
    await win.webContents.executeJavaScript(`window.__station.render(${JSON.stringify(state)})`);
    await new Promise((r) => setTimeout(r, 1800));
    const info = await win.webContents.executeJavaScript(`(() => { const i = document.getElementById('player-hero-img'); const r = i.getBoundingClientRect(); return { src: i.getAttribute('src'), on: i.classList.contains('on'), loaded: i.naturalWidth, box: [r.x, r.y, r.width, r.height].map(Math.round), opacity: getComputedStyle(i.parentElement).opacity, handle: document.getElementById('player-handle').textContent, meta: document.getElementById('player-meta').textContent }; })()`);
    console.log('S' + station, JSON.stringify(info));
    fs.writeFileSync(path.join(outDir, `val-player-s${station}.png`), (await win.webContents.capturePage()).toPNG());
  }
  app.exit(0);
});
