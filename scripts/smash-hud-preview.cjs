// Offline Smash scorecard preview over a gameplay frame.
// Usage: npx electron scripts/smash-hud-preview.cjs <out.png> [background.png] [homeStocks] [awayStocks]
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2).filter((a) => !a.endsWith('.cjs') && a !== '.');
const [outFile, background = '', homeStocks = '7', awayStocks = '4'] = args;
const game = {
  teams: [
    { name: 'IDAHO STATE', shortName: 'ISU', color: '#f47920', score: 1, detailScore: Number(homeStocks) },
    { name: 'BOISE STATE', shortName: 'BSU', color: '#2d6cdf', score: 0, detailScore: Number(awayStocks) }
  ],
  match: { event: 'COLLEGIATE ESPORTS', round: 'REGULAR SEASON', format: 'Best of 3' }, seriesLength: 3, activeMap: 1, mapRows: [{}, {}, {}]
};
const state = { selectedGame: 'smash', activeRoster: 'varsity', games: { smash: game } };
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
  await win.loadURL(`http://127.0.0.1:${server.address().port}/overlays/scoreboard.html?output=fill`);
  if (background) {
    const data = fs.readFileSync(background).toString('base64');
    await win.webContents.executeJavaScript(`document.body.style.background = 'url(data:image/png;base64,${data}) center/1920px 1080px no-repeat'`);
  }
  await new Promise((resolve) => setTimeout(resolve, 2500));
  fs.writeFileSync(outFile, (await win.webContents.capturePage()).toPNG());
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
