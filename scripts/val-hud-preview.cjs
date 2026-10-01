// Offline VALORANT HUD preview: serves public/ with a fake match state, screenshots the
// scoreboard overlay at 1920x1080. Usage: npx electron scripts/val-hud-preview.cjs <outDir> [round] [growing 0|1]
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const [outDir, roundArg, growingArg] = process.argv.slice(2).filter((a) => !a.endsWith('.cjs'));
const round = Number(roundArg) || 9;
const growing = growingArg === '1';
const winners = ['attack', 'defense', 'attack', 'attack', 'defense', 'defense', 'attack', 'defense', 'attack', 'attack', 'defense', 'attack', 'defense', 'attack', 'defense', 'attack', 'attack', 'defense', 'defense', 'attack', 'attack', 'defense', 'attack'];
const rounds = Array.from({ length: 24 }, (_x, i) => i + 1 < round ? { round: i + 1, winnerRole: winners[i] } : i + 1 === round ? { round: i + 1, current: true } : { round: i + 1 });
const ults = [[7, 7], [3, 8], [0, 9], [5, 6], [8, 8], [2, 7], [6, 9], [7, 7], [1, 8], [4, 6]];
const names = ['BENGAL', 'TEMPEST_ISU', 'kayro', 'Nightfall', 'Z3RO', 'Vexx', 'Lumen', 'ByteWolf', 'shiv', 'AURORA_LONGNAME'];
const weapons = ['Vandal', 'Phantom', 'Operator', 'Spectre', 'Sheriff', 'Vandal', 'Phantom', 'Marshal', 'Classic', 'Odin'];
const player = (i) => ({
  name: names[i], kda: { kills: 3 + i, deaths: 2 + (i % 4), assists: i % 5 }, credits: 900 + i * 450,
  ultimateState: ults[i][0] >= ults[i][1] ? { status: 'ready', current: ults[i][0], required: ults[i][1], display: 'READY' } : { status: 'charging', current: ults[i][0], required: ults[i][1], display: `${ults[i][0]}/${ults[i][1]}` },
  loadout: { status: 'matched', weapon: weapons[i] }
});
const game = {
  teams: [{ name: 'IDAHO STATE', shortName: 'ISU', color: '#f47920', score: 1, detailScore: Math.floor((round - 1) / 2) }, { name: 'OPPONENT', shortName: 'OPP', color: '#ff4655', score: 0, detailScore: Math.ceil((round - 1) / 2) }],
  match: { format: 'BEST OF 3' }, mapRows: [{ map: 'Summit' }], activeMap: 0, seriesLength: 3,
  valorantGrowingRounds: growing,
  valorantOcr: { live: { status: 'running', observer3: { roundTimeline: { currentRound: round, rounds }, teams: { home: { players: [0, 1, 2, 3, 4].map(player) }, away: { players: [5, 6, 7, 8, 9].map(player) } } } } }
};
const state = { selectedGame: 'valorant', activeRoster: 'varsity', games: { valorant: game } };
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/state')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state)); return; }
  if (req.url.startsWith('/events')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); return; }
  const filename = path.join(__dirname, '../public', decodeURIComponent(req.url.split('?')[0]));
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) { res.writeHead(404); res.end(); return; }
  const ext = path.extname(filename);
  res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream');
  res.end(fs.readFileSync(filename));
});
app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: false, width: 1920, height: 1080, webPreferences: { offscreen: true } });
  await win.loadURL(`http://127.0.0.1:${server.address().port}/overlays/scoreboard.html?output=fill`);
  await new Promise((resolve) => setTimeout(resolve, 3200));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `hud-r${round}${growing ? '-grow' : ''}.png`), (await win.webContents.capturePage()).toPNG());
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
