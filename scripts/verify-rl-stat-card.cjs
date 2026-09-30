const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const game = {
  teams: [{ name: 'IDAHO STATE', shortName: 'ISU', color: '#f47920' }, { name: 'OPPONENT', shortName: 'OPP', color: '#2d8cff' }],
  match: {}, mapRows: [{}], rosters: { varsity: [{ handle: 'BENGAL', playerImage: 'http://127.0.0.1:1/missing.png' }] },
  rocketLeague: { blueTeam: 0, live: { status: 'connected', players: [{ name: 'BENGAL', teamNum: 0, spectated: true, shots: 7, goals: 2, assists: 1, saves: 3, demos: 4 }] } }
};
const state = { selectedGame: 'rocketleague', activeRoster: 'varsity', games: { rocketleague: game } };
let stream;
const server = http.createServer((req, res) => {
  if (req.url === '/api/state') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state)); return; }
  if (req.url === '/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); stream = res; return; }
  const filename = path.join(__dirname, '../public', req.url.split('?')[0]);
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(fs.readFileSync(filename));
});
app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const window = new BrowserWindow({ show: false, width: 1920, height: 1080, webPreferences: { offscreen: true } });
  await window.loadURL(`http://127.0.0.1:${server.address().port}/overlays/scoreboard.html`);
  await new Promise((resolve) => setTimeout(resolve, 800));
  const result = await window.webContents.executeJavaScript(`({ hidden: document.querySelector('#rl-player-stats').hidden, name: document.querySelector('#rl-player-name').textContent, shots: document.querySelector('#rl-player-shots').textContent, art: document.querySelector('#rl-player-art').textContent })`);
  assert.deepEqual(result, { hidden: false, name: 'BENGAL', shots: '7', art: 'ISU' });
  const screenshot = await window.webContents.capturePage();
  fs.mkdirSync(path.join(__dirname, '../release/rl-player-cards'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '../release/rl-player-cards/preview.png'), screenshot.toPNG());
  game.rocketLeague.live.replay = true;
  stream.write(`data: ${JSON.stringify(state)}\n\n`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#rl-player-stats').hidden`), true);
  console.log('Stat card browser smoke passed: live stats, broken portrait fallback, replay hiding.');
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
