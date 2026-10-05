// End-to-end NDI player card: serves the real overlays + a fake controller state, starts the
// controller's NdiPlayerCards for station 3 inside Electron (offscreen), then receives
// "ISU Player Card 03" with an independent NDI receiver and checks the frames.
// Run headless: env -u WAYLAND_DISPLAY DISPLAY=:97 npx electron --ozone-platform=x11 --no-sandbox --disable-gpu test/media-ndi/ndi-player-card.e2e.cjs <out.png>
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { NdiPlayerCards } = require('../../electron/ndi-player-cards.cjs');
const { NdiCardReceiver } = require('../../electron/stage-displays/ndi-receiver.cjs');
const ndi = require('@stagetimerio/grandiose');

const outFile = process.argv.filter((a) => a.endsWith('.png'))[0] || '/tmp/ndi-card.png';
const game = {
  teams: [{ name: 'IDAHO STATE', shortName: 'ISU', color: '#f47920' }, { name: 'BOISE STATE', shortName: 'BSU', color: '#2d6cdf' }],
  match: { event: 'COLLEGIATE ESPORTS' }, activeMap: 1, mapRows: [{ map: 'Busan' }, { map: "King's Row" }],
  characterArt: { Hanzo: { url: '/assets/overwatch/heroes/hanzo.webp' } },
  rosters: { varsity: [{ handle: 'BENGAL', name: 'Ben Gallo', role: 'Damage', character: 'Hanzo', stageStation: 3 }] },
  awayRosters: { varsity: [] },
  overwatchLastMapStats: { 3: { handle: 'BENGAL', map: 'Busan', stats: { elims: 21, assists: 6, deaths: 4, damage: 11240, healing: 0, mitigation: 1830 } } }
};
const state = { selectedGame: 'overwatch', activeRoster: 'varsity', games: { overwatch: game } };
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/state')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(state)); }
  if (req.url.startsWith('/events')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.flushHeaders(); }
  const file = path.join(__dirname, '../../public', decodeURIComponent(req.url.split('?')[0]));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.webp': 'image/webp', '.png': 'image/png' }[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

function writePng(file, width, height, bgra, stride) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) { const s = y * stride + x * 4; const o = y * (width * 3 + 1) + 1 + x * 3; raw[o] = bgra[s + 2]; raw[o + 1] = bgra[s + 1]; raw[o + 2] = bgra[s]; }
  }
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const cards = new NdiPlayerCards({ BrowserWindow, baseUrl: `http://127.0.0.1:${server.address().port}` });
  const status = await cards.configure({ enabled: true, stations: [3] });
  const sourceName = status.outputs[0]?.source;
  await new Promise((r) => setTimeout(r, 2500));
  const finder = await ndi.find({ showLocalSources: true, extraIPs: ['127.0.0.1'] });
  let source = null;
  for (let i = 0; i < 6 && !source; i += 1) { await finder.wait(500); source = finder.sources().find((s) => s.name === sourceName); }
  await finder.destroy();
  if (!source) source = { name: sourceName, urlAddress: '127.0.0.1:5961' };
  const rx = await ndi.receive({ source, colorFormat: ndi.COLOR_FORMAT_BGRX_BGRA });
  let frames = 0; let last = null; const t0 = Date.now();
  while (Date.now() - t0 < 3000) { try { const f = await rx.video(1000); if (f?.data) { frames += 1; last = f; } } catch {} }
  // The stage display client's own receiver, as station 3 would run it.
  let clientFrames = 0; let clientSize = '';
  const client = new NdiCardReceiver({ onFrame: (f) => { clientFrames += 1; clientSize = `${f.width}x${f.height}`; } });
  await client.start({ station: 3, controllerHost: '127.0.0.1' }).catch((e) => { clientSize = `error: ${e.message}`; });
  await new Promise((r) => setTimeout(r, 2000));
  await client.stop();
  const result = { clientFrames, clientSize, source: sourceName, ndi: status.ndiVersion, frames, width: last?.xres, height: last?.yres, senderFrames: cards.status().outputs[0]?.frames, error: cards.status().outputs[0]?.error };
  if (last) writePng(outFile, last.xres, last.yres, last.data, last.lineStrideBytes);
  await cards.shutdown();
  console.log(JSON.stringify(result));
  const pass = frames >= 1 && last?.xres === 1920 && last?.yres === 1080 && !result.error && clientFrames >= 1 && clientSize === '1920x1080';
  console.log(pass ? 'NDI CARD PASS' : 'NDI CARD FAIL');
  app.exit(pass ? 0 : 1);
}).catch((e) => { console.error(e); app.exit(1); });
