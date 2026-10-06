const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

// Serve a station from a different port than the URL saved in its roster.
// The old implementation tries to fetch the portrait from the saved host.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1kAAAAASUVORK5CYII=', 'base64');
const state = {
  selectedGame: 'overwatch', activeRoster: 'varsity',
  displays: { stations: { 1: { preset: 'player' } } },
  games: { overwatch: { teams: [{ name: 'Home' }], rosters: { varsity: [
    { handle: 'TEST', stageStation: 1, playerImage: 'http://127.0.0.1:1/user-assets/portrait.png' }
  ] } } }
};
let win;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/state') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state)); return; }
  if (url.pathname === '/user-assets/portrait.png') { res.setHeader('Content-Type', 'image/png'); res.end(png); return; }
  if (url.pathname === '/shared/live-state.js') { res.end('window.isuLiveState = () => {};'); return; }
  const files = { '/displays/station.html': 'text/html', '/displays/station.js': 'text/javascript', '/displays/station.css': 'text/css' };
  if (files[url.pathname]) {
    res.setHeader('Content-Type', files[url.pathname]);
    res.end(fs.readFileSync(path.join(__dirname, '../public', url.pathname))); return;
  }
  res.writeHead(404); res.end();
});
app.whenReady().then(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  win = new BrowserWindow({ show: false });
  await win.loadURL(`http://127.0.0.1:${server.address().port}/displays/station.html?station=1`);
  const result = await win.webContents.executeJavaScript(`(async () => {
    const state = ${JSON.stringify(state)};
    window.__station.render(state);
    const portrait = document.getElementById('player-portrait');
    const url = portrait.style.backgroundImage.slice(5, -2);
    const image = new Image(); image.src = url; await image.decode();
    return { url, width: image.naturalWidth, hasImage: portrait.classList.contains('has-image') };
  })()`);
  assert.equal(result.url, '/user-assets/portrait.png');
  assert.equal(result.width, 1);
  assert.equal(result.hasImage, true);
  console.log('DISPLAY_PORTRAIT_OK: uploaded roster image loads from the display page origin');
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  win?.destroy(); server.close(); app.exit(process.exitCode || 0);
});
