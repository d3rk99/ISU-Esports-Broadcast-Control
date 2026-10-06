'use strict';
// ISU Display Client: runs on each station PC, full screen on the audience-facing monitor.
// Two modes, chosen by the controller:
//   mirror  - show this PC's player monitor (game mirror)
//   ndi     - show an NDI source (normally "ISU Stage NN" sent by OBS)
// Settings: Ctrl+Alt+S (or tray). Cursor lock to the player monitor: Ctrl+Alt+L.
const { app, BrowserWindow, Menu, Tray, desktopCapturer, globalShortcut, ipcMain, nativeImage, screen } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { NdiReceiver } = require('./ndi-receiver.cjs');
const { CursorLock } = require('./cursor-lock.cjs');

const VERSION = require('../../package.json').version;
// Own name + own settings folder, so it never shares the controller's single-instance lock
// (run from source, both apps would otherwise be "isu-esports-broadcast-control").
app.setName('ISU Display Client');
app.setPath('userData', process.env.DISPLAY_CLIENT_USER_DATA ? path.resolve(process.env.DISPLAY_CLIENT_USER_DATA) : path.join(app.getPath('appData'), 'ISU Display Client'));

// Crash log: <userData>/display-client.log (Windows: %APPDATA%\ISU Display Client\display-client.log).
const logPath = () => path.join(app.getPath('userData'), 'display-client.log');
function logLine(text) {
  try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.appendFileSync(logPath(), `[${new Date().toISOString()}] ${text}\n`); } catch {}
}
process.on('uncaughtException', (error) => {
  logLine(`CRASH ${error?.stack || error}`);
  try { require('electron').dialog.showErrorBox('ISU Display Client error', `${error?.stack || error}\n\nLog: ${logPath()}`); } catch {}
});
process.on('unhandledRejection', (error) => logLine(`unhandled rejection ${error?.stack || error}`));
app.on('render-process-gone', (_e, _wc, details) => logLine(`renderer gone: ${details.reason} (${details.exitCode})`));
app.on('child-process-gone', (_e, details) => logLine(`child gone: ${details.type} ${details.reason} (${details.exitCode})`));
logLine(`start v${VERSION} ${process.platform} electron ${process.versions.electron}`);

let config; let win = null; let settingsWin = null; let tray = null;
let socket = null; let reconnectTimer = null; let reconnectDelay = 1000; let statusTimer = null;
let mode = { mode: 'ndi', source: '' };
let link = { state: 'disconnected', error: '' };
let ndiState = { state: 'idle', error: '', source: '', fps: 0 };
const cursorLock = new CursorLock();

// ---- config ------------------------------------------------------------------------------
const configPath = () => process.env.DISPLAY_CLIENT_CONFIG || path.join(app.getPath('userData'), 'display-client.json');
function normalize(raw = {}) {
  const station = Math.max(1, Math.min(10, Math.round(Number(raw.station) || 1)));
  return {
    station,
    controller: String(raw.controller || '127.0.0.1').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').slice(0, 255) || '127.0.0.1',
    port: Math.max(1, Math.min(65535, Math.round(Number(raw.port) || 3178))),
    key: String(raw.key || '').trim().slice(0, 200),
    // extra IP to look for NDI on, when mDNS is blocked (usually the OBS PC)
    ndiHost: String(raw.ndiHost || '').trim().slice(0, 255),
    playerDisplay: Math.max(1, Math.round(Number(raw.playerDisplay) || 1)),
    stageDisplay: Math.max(1, Math.round(Number(raw.stageDisplay) || 2)),
    cursorLock: raw.cursorLock === true,
    startWithWindows: raw.startWithWindows !== false // on unless turned off in settings
  };
}
function cliConfig() {
  const out = {};
  for (const arg of process.argv.slice(1)) { const m = /^--([a-zA-Z]+)=(.*)$/.exec(arg); if (m) out[m[1]] = m[2]; }
  return out;
}
function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch {}
  return normalize({ ...saved, ...cliConfig() });
}
function saveConfig(next) {
  config = normalize({ ...config, ...next });
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(`${configPath()}.tmp`, JSON.stringify(config, null, 2));
  fs.renameSync(`${configPath()}.tmp`, configPath());
  applyStartWithWindows();
  return config;
}

// Start with Windows (on by default). A portable exe runs from a temp copy, so register the
// real exe (PORTABLE_EXECUTABLE_FILE); --startup tells us we were started by Windows.
function applyStartWithWindows() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  try {
    app.setLoginItemSettings({ openAtLogin: config.startWithWindows, path: exe, args: ['--startup'], name: 'ISU Display Client' });
    logLine(`start with Windows: ${config.startWithWindows ? 'on' : 'off'} (${exe})`);
  } catch (error) { logLine(`start with Windows failed: ${error.message}`); }
}

// ---- displays ----------------------------------------------------------------------------
function displays() {
  return screen.getAllDisplays().slice().sort((a, b) => (a.bounds.y - b.bounds.y) || (a.bounds.x - b.bounds.x));
}
function displayAt(index, fallback = 0) { const all = displays(); return all[index - 1] || all[fallback] || screen.getPrimaryDisplay(); }
function applyCursorLock() {
  if (!config.cursorLock) return cursorLock.unlock();
  const d = displayAt(config.playerDisplay, 0); const s = d.scaleFactor || 1; const { x, y, width, height } = d.bounds;
  cursorLock.lock({ left: x * s + 2, top: y * s + 2, right: (x + width) * s - 2, bottom: (y + height) * s - 2 });
}

// ---- NDI ---------------------------------------------------------------------------------
let frameBusy = false;
const ndi = new NdiReceiver({
  onFrame: (frame) => {
    if (!win || win.isDestroyed() || frameBusy) return;
    frameBusy = true;
    win.webContents.send('display:frame', frame);
    setImmediate(() => { frameBusy = false; });
  },
  onStatus: (status) => { if (status.error && status.error !== ndiState.error) logLine(`ndi: ${status.error}`); ndiState = { ...ndiState, ...status }; win?.webContents.send('display:ndi-status', ndiState); reportStatus(); }
});

function applyMode(next) {
  mode = { mode: next.mode === 'mirror' ? 'mirror' : 'ndi', source: String(next.source || '') };
  if (mode.mode === 'ndi') {
    ndi.start({ source: mode.source || `ISU Stage ${String(config.station).padStart(2, '0')}`, hosts: [config.ndiHost, config.controller].filter(Boolean) }).catch(() => {});
  } else {
    ndi.stop();
    ndiState = { state: 'idle', error: '', source: '', fps: 0 };
  }
  win?.webContents.send('display:mode', mode);
  reportStatus();
  updateTray();
}

// ---- controller link ---------------------------------------------------------------------
function setLink(state, error = '') { link = { state, error }; win?.webContents.send('display:link', link); updateTray(); }
function reportStatus() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const state = mode.mode === 'mirror' ? 'mirror' : ndiState.state;
  socket.send(JSON.stringify({ type: 'status', mode: mode.mode, source: mode.source, state, error: ndiState.error || '', fps: ndiState.fps || 0 }));
}
function connect() {
  clearTimeout(reconnectTimer);
  try { socket?.terminate(); } catch {}
  const url = `ws://${config.controller}:${config.port}/display`;
  setLink('connecting');
  const s = new WebSocket(url, { handshakeTimeout: 5000 });
  socket = s;
  s.on('open', () => {
    reconnectDelay = 1000;
    s.send(JSON.stringify({ type: 'hello', station: config.station, hostname: os.hostname(), version: VERSION, key: config.key, mode: mode.mode, source: mode.source }));
  });
  s.on('message', (raw) => {
    let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.type === 'welcome') setLink('connected');
    if (msg.type === 'mode') applyMode(msg);
  });
  s.on('close', (code, reason) => {
    if (socket !== s) return;
    const why = String(reason || '');
    setLink('disconnected', code === 4003 ? 'Display key rejected: check the key in settings' : code === 4009 ? why : '');
    // Keep showing whatever we had (an NDI feed keeps running without the controller).
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(10000, reconnectDelay * 2);
  });
  s.on('error', () => {});
}

// ---- windows -----------------------------------------------------------------------------
function createWindow() {
  const d = displayAt(config.stageDisplay, displays().length > 1 ? 1 : 0);
  win = new BrowserWindow({
    ...d.bounds, frame: false, fullscreen: true, autoHideMenuBar: true, backgroundColor: '#000000',
    skipTaskbar: true, // lives in the tray (hidden icons) only
    title: `ISU Display ${config.station}`,
    webPreferences: { preload: path.join(__dirname, 'display-client-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  win.loadFile(path.join(__dirname, 'client', 'index.html'));
  win.webContents.on('did-finish-load', () => { win.webContents.send('display:mode', mode); win.webContents.send('display:link', link); win.webContents.send('display:ndi-status', ndiState); });
  win.on('closed', () => { win = null; });
  // Windows can re-add a taskbar button after fullscreen/display changes: keep it off.
  win.on('show', () => win?.setSkipTaskbar(true));
  win.on('enter-full-screen', () => win?.setSkipTaskbar(true));
}
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 560, height: 720, title: 'ISU Display Client - Settings', autoHideMenuBar: true, backgroundColor: '#0b0d10',
    icon: trayIcon(), // shows on the taskbar only while settings are open
    webPreferences: { preload: path.join(__dirname, 'display-client-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  settingsWin.loadFile(path.join(__dirname, 'client', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}
function trayIcon() {
  // 32x32 ISU-orange rounded tile with a white monitor glyph (readable in the hidden-icons tray).
  const N = 32; const px = Buffer.alloc(N * N * 4);
  for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) {
    const o = (y * N + x) * 4;
    const corner = Math.max(0, Math.abs(x - 15.5) - 11.5) ** 2 + Math.max(0, Math.abs(y - 15.5) - 11.5) ** 2;
    if (corner > 16) continue; // transparent rounded corners
    const screenEdge = x >= 7 && x <= 24 && y >= 8 && y <= 19 && !(x >= 9 && x <= 22 && y >= 10 && y <= 17);
    const stand = (x >= 14 && x <= 17 && y >= 20 && y <= 22) || (x >= 11 && x <= 20 && y >= 23 && y <= 24);
    const white = screenEdge || stand;
    px[o] = white ? 255 : 32; px[o + 1] = white ? 255 : 121; px[o + 2] = white ? 255 : 244; px[o + 3] = 255; // BGRA
  }
  return nativeImage.createFromBitmap(px, { width: N, height: N });
}
function updateTray() {
  if (!tray) return;
  const label = `Station ${String(config.station).padStart(2, '0')} · ${mode.mode === 'mirror' ? 'Game mirror' : `NDI ${ndiState.source || mode.source || ''}`} · ${link.state}`;
  tray.setToolTip(`ISU Display Client\n${label}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label, enabled: false },
    { label: 'Settings… (Ctrl+Alt+S)', click: openSettings },
    { label: 'Reconnect', click: connect },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]));
}

// ---- IPC (renderer + settings) -----------------------------------------------------------
ipcMain.handle('display:get-config', () => ({ ...config, version: VERSION, hostname: os.hostname(), displays: displays().map((d, i) => ({ index: i + 1, width: d.bounds.width, height: d.bounds.height, primary: d.id === screen.getPrimaryDisplay().id })) }));
ipcMain.handle('display:save-config', (_e, next = {}) => {
  const before = { ...config };
  saveConfig(next);
  if (before.stageDisplay !== config.stageDisplay && win) { win.setBounds(displayAt(config.stageDisplay, 1).bounds); win.setFullScreen(true); }
  applyCursorLock();
  if (before.controller !== config.controller || before.port !== config.port || before.key !== config.key || before.station !== config.station) connect();
  else if (mode.mode === 'ndi') applyMode(mode); // ndiHost may have changed
  return config;
});
ipcMain.handle('display:get-mirror-source', async () => {
  const target = displayAt(config.playerDisplay, 0);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
  const match = sources.find((s) => String(s.display_id) === String(target.id)) || sources[config.playerDisplay - 1] || sources[0];
  return match ? { id: match.id, name: match.name } : null;
});
ipcMain.on('display:mirror-status', (_e, status = {}) => {
  if (mode.mode !== 'mirror') return;
  ndiState = { state: status.error ? 'error' : 'mirror', error: String(status.error || ''), source: '', fps: Number(status.fps) || 0 };
  reportStatus();
});
ipcMain.on('display:open-settings', openSettings);

// ---- lifecycle ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) { logLine('another Display Client is already running: quitting'); app.quit(); }
else {
  app.on('second-instance', openSettings);
  app.whenReady().then(() => {
    config = loadConfig();
    logLine(`config ${JSON.stringify({ ...config, key: config.key ? '(set)' : '' })} displays ${screen.getAllDisplays().length}`);
    createWindow();
    applyStartWithWindows();
    try { tray = new Tray(trayIcon()); tray.on('double-click', openSettings); updateTray(); } catch (error) { logLine(`tray failed: ${error.message}`); }
    try {
      if (!globalShortcut.register('Control+Alt+S', openSettings)) logLine('Ctrl+Alt+S is taken by another app');
      if (!globalShortcut.register('Control+Alt+L', () => { saveConfig({ cursorLock: !config.cursorLock }); applyCursorLock(); })) logLine('Ctrl+Alt+L is taken by another app');
    } catch (error) { logLine(`shortcuts failed: ${error.message}`); }
    applyCursorLock();
    applyMode(mode); // NDI by default, before the controller even answers
    connect();
    statusTimer = setInterval(reportStatus, 2000);
    logLine('ready');
  }).catch((error) => { logLine(`STARTUP FAILED ${error?.stack || error}`); try { require('electron').dialog.showErrorBox('ISU Display Client could not start', `${error?.stack || error}\n\nLog: ${logPath()}`); } catch {} });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    clearInterval(statusTimer); clearTimeout(reconnectTimer);
    try { socket?.terminate(); } catch {}
    cursorLock.unlock();
    ndi.stop();
  });
  app.on('window-all-closed', () => {});
}
