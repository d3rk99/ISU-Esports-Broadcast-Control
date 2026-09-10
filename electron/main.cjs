const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { RocketLeagueService } = require('./rocket-league-service.cjs');

const isDev = !app.isPackaged;
const OVERLAY_PORT = 3174;
const OVERLAY_HOST = '127.0.0.1';
const overlayClients = new Set();
let broadcastState = {};
const runtimeDiagnostics = [];
let overlayServer;
let rocketLeagueService;
const ROCKET_LEAGUE_CONNECTION_FIELDS = [
  'enabled', 'source', 'transport', 'host', 'tcpPort', 'webPort', 'bridgePort', 'bridgeToken', 'updateIntervalMs'
];
app.setAppUserModelId('edu.isu.esports.broadcastcontrol');
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};

function writeJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  response.end(JSON.stringify(value));
}

function recordDiagnostic(type, details) {
  runtimeDiagnostics.push({ at: new Date().toISOString(), type, details: String(details || '') });
  if (runtimeDiagnostics.length > 20) runtimeDiagnostics.shift();
}

function safeFilePath(root, requestPath) {
  const decoded = decodeURIComponent(requestPath);
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(root, `.${decoded}`);
  return resolvedFile.startsWith(`${resolvedRoot}${path.sep}`) ? resolvedFile : null;
}

function serveFile(response, filePath) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    writeJson(response, 404, { error: 'Not found' });
    return;
  }
  response.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  fs.createReadStream(filePath).pipe(response);
}

function publishBroadcastState(nextState) {
  if (!nextState || typeof nextState !== 'object') return;
  broadcastState = nextState;
  const message = `data: ${JSON.stringify(broadcastState)}\n\n`;
  for (const client of overlayClients) client.write(message);
}

function rocketLeagueSettingsPath() {
  return path.join(app.getPath('userData'), 'rocket-league-connection.json');
}

function sanitizeRocketLeagueConnection(saved) {
  if (!saved || typeof saved !== 'object') return null;
  return Object.fromEntries(ROCKET_LEAGUE_CONNECTION_FIELDS
    .filter((field) => Object.hasOwn(saved, field))
    .map((field) => [field, saved[field]]));
}

function readRocketLeagueConnection() {
  const recoveryPath = path.join(path.dirname(process.execPath), 'rocket-league-connection.import.json');
  try {
    const imported = sanitizeRocketLeagueConnection(JSON.parse(fs.readFileSync(recoveryPath, 'utf8')));
    if (imported) {
      saveRocketLeagueConnection(imported);
      fs.unlinkSync(recoveryPath);
      recordDiagnostic('rocket-league-connection-imported', 'One-time connection settings imported');
      return imported;
    }
  } catch {}
  try {
    return sanitizeRocketLeagueConnection(JSON.parse(fs.readFileSync(rocketLeagueSettingsPath(), 'utf8')));
  } catch {}
  return null;
}

function saveRocketLeagueConnection(settings = {}) {
  const saved = Object.fromEntries(ROCKET_LEAGUE_CONNECTION_FIELDS
    .filter((field) => Object.hasOwn(settings, field))
    .map((field) => [field, field === 'enabled' && Object.hasOwn(settings, 'savedEnabled')
      ? Boolean(settings.savedEnabled)
      : settings[field]]));
  fs.writeFileSync(rocketLeagueSettingsPath(), JSON.stringify(saved, null, 2), 'utf8');
}

function startOverlayServer() {
  const staticRoot = isDev
    ? path.join(__dirname, '..', 'public')
    : path.join(__dirname, '..', 'dist');
  const assetRoot = path.join(app.getPath('userData'), 'broadcast-assets');
  fs.mkdirSync(assetRoot, { recursive: true });

  overlayServer = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, `http://${OVERLAY_HOST}:${OVERLAY_PORT}`);
    if (request.method !== 'GET') {
      writeJson(response, 405, { error: 'Method not allowed' });
      return;
    }
    if (requestUrl.pathname === '/api/state') {
      writeJson(response, 200, broadcastState);
      return;
    }
    if (requestUrl.pathname === '/api/health') {
      const savedConnection = readRocketLeagueConnection();
      writeJson(response, 200, {
        ok: true,
        port: OVERLAY_PORT,
        clients: overlayClients.size,
        rocketLeagueBackup: savedConnection ? {
          enabled: Boolean(savedConnection.enabled),
          source: savedConnection.source,
          bridgePort: savedConnection.bridgePort,
          tokenPresent: Boolean(savedConnection.bridgeToken)
        } : null,
        diagnostics: runtimeDiagnostics
      });
      return;
    }
    if (requestUrl.pathname === '/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      response.write(`data: ${JSON.stringify(broadcastState)}\n\n`);
      overlayClients.add(response);
      request.on('close', () => overlayClients.delete(response));
      return;
    }
    if (requestUrl.pathname.startsWith('/user-assets/')) {
      const relativePath = requestUrl.pathname.slice('/user-assets'.length);
      serveFile(response, safeFilePath(assetRoot, relativePath));
      return;
    }
    if (requestUrl.pathname.startsWith('/overlays/')) {
      serveFile(response, safeFilePath(staticRoot, requestUrl.pathname));
      return;
    }
    writeJson(response, 404, { error: 'Not found' });
  });

  return new Promise((resolve, reject) => {
    overlayServer.once('error', reject);
    overlayServer.listen(OVERLAY_PORT, OVERLAY_HOST, resolve);
  });
}

function registerIpc() {
  ipcMain.on('broadcast:update-state', (_event, nextState) => publishBroadcastState(nextState));
  ipcMain.on('clipboard:write', (_event, text) => clipboard.writeText(String(text || '')));
  ipcMain.handle('broadcast:get-info', () => ({
    baseUrl: `http://${OVERLAY_HOST}:${OVERLAY_PORT}`,
    clients: overlayClients.size,
    ready: Boolean(overlayServer?.listening)
  }));
  ipcMain.handle('network:get-addresses', () => Object.values(os.networkInterfaces()).flat().filter((entry) => entry?.family === 'IPv4' && !entry.internal).map((entry) => entry.address));
  ipcMain.handle('rocket-league:configure', (_event, settings = {}) => {
    saveRocketLeagueConnection(settings);
    rocketLeagueService.configure(settings);
    return rocketLeagueService.status;
  });
  ipcMain.handle('rocket-league:get-saved-connection', () => readRocketLeagueConnection());
  ipcMain.on('rocket-league:get-saved-connection-sync', (event) => {
    event.returnValue = readRocketLeagueConnection();
  });
  ipcMain.handle('rocket-league:get-status', () => rocketLeagueService.status);
  ipcMain.handle('rocket-league:set-update-interval', (_event, value) => {
    const updateIntervalMs = rocketLeagueService.setUpdateInterval(value);
    saveRocketLeagueConnection({ ...(readRocketLeagueConnection() || {}), updateIntervalMs });
    return updateIntervalMs;
  });
  ipcMain.handle('rocket-league:start-simulator', () => {
    rocketLeagueService.startSimulator();
    return rocketLeagueService.status;
  });
  ipcMain.handle('rocket-league:stop-simulator', () => {
    rocketLeagueService.stopSimulator();
    return rocketLeagueService.status;
  });
  ipcMain.handle('assets:pick-image', async (event, details = {}) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(parent, {
      title: `Choose ${details.type === 'characterImage' ? 'character' : 'player'} PNG`,
      properties: ['openFile'],
      filters: [
        { name: 'Broadcast Images', extensions: ['png', 'webp', 'jpg', 'jpeg'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const source = result.filePaths[0];
    const extension = path.extname(source).toLowerCase();
    if (!['.png', '.webp', '.jpg', '.jpeg'].includes(extension)) return null;
    const filename = `${crypto.randomUUID()}${extension}`;
    const destination = path.join(app.getPath('userData'), 'broadcast-assets', filename);
    fs.copyFileSync(source, destination);
    return { name: path.basename(source), url: `http://${OVERLAY_HOST}:${OVERLAY_PORT}/user-assets/${filename}` };
  });
  ipcMain.handle('overlay:preview', (_event, details = {}) => {
    const allowed = new Set(['scoreboard', 'map-pool', 'roster']);
    if (!allowed.has(details.name)) return false;
    const preview = new BrowserWindow({
      width: 1120,
      height: 650,
      minWidth: 800,
      minHeight: 450,
      title: `${details.name} overlay preview`,
      backgroundColor: '#222222',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    const previewUrl = new URL(`http://${OVERLAY_HOST}:${OVERLAY_PORT}/overlays/${details.name}.html`);
    for (const [key, value] of Object.entries(details.query || {})) previewUrl.searchParams.set(key, value);
    const fitPreview = () => {
      const [width, height] = preview.getContentSize();
      preview.webContents.setZoomFactor(Math.min(width / 1920, height / 1080));
    };
    preview.webContents.once('did-finish-load', fitPreview);
    preview.on('resize', fitPreview);
    preview.loadURL(previewUrl.toString());
    return true;
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#0b0b0c',
    title: 'ISU Esports Broadcast Control',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  window.once('ready-to-show', () => window.show());
  window.webContents.on('preload-error', (_event, preloadPath, error) => recordDiagnostic('preload-error', `${preloadPath}: ${error?.message || error}`));
  window.webContents.on('did-fail-load', (_event, code, description) => recordDiagnostic('did-fail-load', `${code}: ${description}`));
  window.webContents.on('render-process-gone', (_event, details) => recordDiagnostic('render-process-gone', `${details.reason}: ${details.exitCode}`));
  window.webContents.on('console-message', (_event, details) => {
    if (details.level === 'error' || Number(details.level) >= 3) recordDiagnostic('renderer-console', details.message);
  });
  window.webContents.once('did-finish-load', () => {
    window.webContents.executeJavaScript(`JSON.stringify({
      desktopApi: Boolean(window.isuDesktop),
      savedConnection: window.isuDesktop?.savedRocketLeagueConnection ? {
        enabled: Boolean(window.isuDesktop.savedRocketLeagueConnection.enabled),
        source: window.isuDesktop.savedRocketLeagueConnection.source,
        tokenPresent: Boolean(window.isuDesktop.savedRocketLeagueConnection.bridgeToken)
      } : null
    })`).then((result) => recordDiagnostic('renderer-ready', result)).catch((error) => recordDiagnostic('renderer-probe-error', error.message));
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    window.loadURL('http://127.0.0.1:5173');
  } else {
    window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(async () => {
  rocketLeagueService = new RocketLeagueService({
    onEvent: (event) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('rocket-league:event', event);
    },
    onStatus: (status) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('rocket-league:status', status);
    }
  });
  registerIpc();
  try {
    await startOverlayServer();
  } catch (error) {
    dialog.showErrorBox('Overlay server could not start', `Port ${OVERLAY_PORT} is unavailable. Close any other copy of ISU Esports Broadcast Control and reopen the app.\n\n${error.message}`);
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});

app.on('window-all-closed', () => {
  rocketLeagueService?.stop();
  if (process.platform !== 'darwin') app.quit();
});
