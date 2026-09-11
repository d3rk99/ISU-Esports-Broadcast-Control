const { app, BrowserWindow, clipboard, dialog, ipcMain, screen, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { CompanionApiService, normalizeCompanionSettings } = require('./companion-api-service.cjs');
const { RocketLeagueService } = require('./rocket-league-service.cjs');

const isDev = !app.isPackaged;
const OVERLAY_PORT = 3174;
const OVERLAY_HOST = '127.0.0.1';
const overlayClients = new Set();
let broadcastState = {};
const runtimeDiagnostics = [];
let overlayServer;
let rocketLeagueService;
let companionApiService;
let companionRequestId = 0;
const pendingCompanionActions = new Map();
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
const OVERLAY_OUTPUTS = new Set(['scoreboard', 'map-pool', 'roster', 'program', 'clean']);
const PROGRAM_OUTPUTS = new Set(['scoreboard', 'map-pool', 'roster', 'clean']);
const overlayOutputWindows = new Set();
let programOutputWindows = { fill: null, key: null };
let programOutputName = 'scoreboard';

function overlayOutputSize(query = {}) {
  return query.output === 'pair' ? { width: 3840, height: 1080 } : { width: 1920, height: 1080 };
}

function normalizeOutputDisplaySettings(settings = {}) {
  return {
    fillDisplayId: settings.fillDisplayId === undefined || settings.fillDisplayId === null ? '' : String(settings.fillDisplayId),
    keyDisplayId: settings.keyDisplayId === undefined || settings.keyDisplayId === null ? '' : String(settings.keyDisplayId)
  };
}

function overlayOutputUrl(details = {}) {
  if (!OVERLAY_OUTPUTS.has(details.name)) return null;
  const url = new URL(`http://${OVERLAY_HOST}:${OVERLAY_PORT}/overlays/${details.name}.html`);
  for (const [key, value] of Object.entries(details.query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

function trackOverlayOutputWindow(window) {
  overlayOutputWindows.add(window);
  window.on('closed', () => {
    overlayOutputWindows.delete(window);
    if (programOutputWindows.fill === window) programOutputWindows.fill = null;
    if (programOutputWindows.key === window) programOutputWindows.key = null;
  });
}

function displayInfo(display) {
  const bounds = display.bounds;
  return {
    id: String(display.id),
    label: `${display.id}${display === screen.getPrimaryDisplay() ? ' - Primary' : ''} (${bounds.width}x${bounds.height} @ ${bounds.x},${bounds.y})`,
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    scaleFactor: display.scaleFactor,
    primary: display.id === screen.getPrimaryDisplay().id
  };
}

function availableOutputDisplays() {
  return screen.getAllDisplays().map(displayInfo);
}

function outputDisplaysPath() {
  return path.join(app.getPath('userData'), 'overlay-output-displays.json');
}

function saveOutputDisplaySettings(settings = {}) {
  const saved = normalizeOutputDisplaySettings(settings);
  fs.writeFileSync(outputDisplaysPath(), JSON.stringify(saved, null, 2), 'utf8');
  return saved;
}

function readOutputDisplaySettings() {
  try {
    return saveOutputDisplaySettings(JSON.parse(fs.readFileSync(outputDisplaysPath(), 'utf8')));
  } catch {
    return saveOutputDisplaySettings({});
  }
}

function displayBySavedId(displayId, fallbackIndex = 0) {
  const displays = orderedDisplays();
  const matched = displays.find((display) => String(display.id) === String(displayId || ''));
  return matched || displays[fallbackIndex] || displays[0] || null;
}

function createOverlayOutputWindow(details = {}, display = null) {
  const outputUrl = overlayOutputUrl(details);
  if (!outputUrl) return null;
  const size = overlayOutputSize(details.query || {});
  const outputMode = details.query?.output || 'fill';
  const bounds = display?.bounds;
  const options = {
    width: size.width,
    height: size.height,
    minWidth: 640,
    minHeight: 360,
    title: `${details.name} ${outputMode} output`,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    frame: false,
    useContentSize: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  };
  if (bounds) {
    options.x = bounds.x;
    options.y = bounds.y;
  }
  const output = new BrowserWindow(options);
  output.setAspectRatio(size.width / size.height);
  output.outputDisplayBounds = bounds || null;
  output.on('resize', () => fitOverlayOutputScale(output));
  trackOverlayOutputWindow(output);
  loadOverlayOutputWindow(output, details);
  return output;
}

function loadOverlayOutputWindow(window, details = {}) {
  const outputUrl = overlayOutputUrl(details);
  if (!outputUrl) return Promise.resolve(false);
  window.overlayReady = waitForOverlayWindow(window);
  window.loadURL(outputUrl.toString());
  return window.overlayReady;
}

function waitForOverlayWindow(window) {
  return new Promise((resolve) => {
    const done = () => resolve();
    window.webContents.once('did-finish-load', done);
    window.webContents.once('did-fail-load', done);
  });
}

function orderedDisplays() {
  const primary = screen.getPrimaryDisplay();
  return [primary, ...screen.getAllDisplays().filter((display) => display.id !== primary.id)];
}

function showOverlayOutputWindow(window) {
  if (window.outputDisplayBounds) window.setBounds(window.outputDisplayBounds);
  window.show();
  window.setFullScreen(true);
  setTimeout(() => fitOverlayOutputScale(window), 100);
}

function fitOverlayOutputScale(window) {
  const [width, height] = window.getContentSize();
  const zoom = Math.max(0.1, Math.min(width / 1920, height / 1080));
  window.webContents.setZoomFactor(zoom);
}

async function loadProgramOutput(name = programOutputName) {
  if (!PROGRAM_OUTPUTS.has(name)) return false;
  programOutputName = name;
  const windows = [programOutputWindows.fill, programOutputWindows.key].filter(Boolean);
  await Promise.all(windows.map((window) => window.webContents.executeJavaScript(
    `window.setProgramOutputOverlay && window.setProgramOutputOverlay(${JSON.stringify(name)})`,
    true
  ).catch(() => false)));
  windows.forEach(fitOverlayOutputScale);
  return Boolean(windows.length);
}

async function openProgramOutput(name = programOutputName) {
  if (!PROGRAM_OUTPUTS.has(name)) return false;
  const outputDisplaySettings = readOutputDisplaySettings();
  if (programOutputWindows.fill?.isDestroyed?.()) programOutputWindows.fill = null;
  if (programOutputWindows.key?.isDestroyed?.()) programOutputWindows.key = null;
  programOutputWindows.fill ||= createOverlayOutputWindow(
    { name: 'program', query: { output: 'fill' } },
    displayBySavedId(outputDisplaySettings.fillDisplayId, 0)
  );
  programOutputWindows.key ||= createOverlayOutputWindow(
    { name: 'program', query: { output: 'key' } },
    displayBySavedId(outputDisplaySettings.keyDisplayId, 1)
  );
  if (!programOutputWindows.fill || !programOutputWindows.key) return false;
  await loadProgramOutput(name);
  await Promise.all([programOutputWindows.fill.overlayReady, programOutputWindows.key.overlayReady]);
  showOverlayOutputWindow(programOutputWindows.fill);
  showOverlayOutputWindow(programOutputWindows.key);
  return true;
}

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
  companionApiService?.publish(broadcastState);
}

function companionSettingsPath() {
  return path.join(app.getPath('userData'), 'companion-api.json');
}

function saveCompanionSettings(settings = {}) {
  const saved = normalizeCompanionSettings(settings);
  fs.writeFileSync(companionSettingsPath(), JSON.stringify(saved, null, 2), 'utf8');
  return saved;
}

function readCompanionSettings() {
  try {
    const saved = normalizeCompanionSettings(JSON.parse(fs.readFileSync(companionSettingsPath(), 'utf8')));
    return saveCompanionSettings(saved);
  } catch {
    return saveCompanionSettings({ enabled: false });
  }
}

function dispatchCompanionAction(action) {
  const target = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
  if (!target) return Promise.reject(Object.assign(new Error('Controller window is not ready'), { statusCode: 503 }));
  const id = String(++companionRequestId);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCompanionActions.delete(id);
      reject(Object.assign(new Error('Controller did not acknowledge the action'), { statusCode: 504 }));
    }, 3000);
    pendingCompanionActions.set(id, { resolve, reject, timeout });
    target.webContents.send('companion:action', { id, action });
  });
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
    if (requestUrl.pathname.startsWith('/assets/')) {
      serveFile(response, safeFilePath(staticRoot, requestUrl.pathname));
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
  ipcMain.on('companion:get-settings-sync', (event) => {
    event.returnValue = readCompanionSettings();
  });
  ipcMain.on('overlay:get-output-display-settings-sync', (event) => {
    event.returnValue = readOutputDisplaySettings();
  });
  ipcMain.handle('overlay:get-output-displays', () => ({
    displays: availableOutputDisplays(),
    settings: readOutputDisplaySettings()
  }));
  ipcMain.handle('overlay:configure-output-displays', (_event, settings = {}) => ({
    displays: availableOutputDisplays(),
    settings: saveOutputDisplaySettings(settings)
  }));
  ipcMain.handle('overlay:open-program-output', (_event, details = {}) => openProgramOutput(details.name || programOutputName));
  ipcMain.handle('overlay:set-program-output', (_event, details = {}) => loadProgramOutput(details.name || programOutputName));
  ipcMain.handle('companion:configure', async (_event, settings = {}) => {
    const saved = saveCompanionSettings(settings);
    const status = await companionApiService.configure(saved);
    return { settings: saved, status };
  });
  ipcMain.handle('companion:get-status', () => companionApiService.getStatus());
  ipcMain.on('companion:action-result', (_event, result = {}) => {
    const pending = pendingCompanionActions.get(String(result.id));
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingCompanionActions.delete(String(result.id));
    if (result.ok) pending.resolve({ message: result.message || 'Action applied' });
    else pending.reject(Object.assign(new Error(result.error || 'Action failed'), { statusCode: Number(result.statusCode) || 400 }));
  });
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
    const previewUrl = overlayOutputUrl(details);
    if (!previewUrl) return false;
    const size = overlayOutputSize(details.query || {});
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
    const fitPreview = () => {
      const [width, height] = preview.getContentSize();
      preview.webContents.setZoomFactor(Math.min(width / size.width, height / size.height));
    };
    preview.webContents.once('did-finish-load', fitPreview);
    preview.on('resize', fitPreview);
    preview.loadURL(previewUrl.toString());
    return true;
  });
  ipcMain.handle('overlay:open-output', async (_event, details = {}) => {
    if (!OVERLAY_OUTPUTS.has(details.name)) return false;
    if (details.query?.output === 'pair') {
      return openProgramOutput(details.name);
    }
    const outputDisplaySettings = readOutputDisplaySettings();
    const outputMode = details.query?.output || 'fill';
    const targetDisplay = outputMode === 'key'
      ? displayBySavedId(outputDisplaySettings.keyDisplayId, 1)
      : displayBySavedId(outputDisplaySettings.fillDisplayId, 0);
    const output = createOverlayOutputWindow(details, targetDisplay);
    if (!output) return false;
    await output.overlayReady;
    showOverlayOutputWindow(output);
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
  companionApiService = new CompanionApiService({
    getState: () => broadcastState,
    dispatchAction: dispatchCompanionAction,
    onDiagnostic: recordDiagnostic
  });
  rocketLeagueService = new RocketLeagueService({
    onEvent: (event) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('rocket-league:event', event);
    },
    onStatus: (status) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('rocket-league:status', status);
    }
  });
  registerIpc();
  await companionApiService.configure(readCompanionSettings());
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
  companionApiService?.stop();
  if (process.platform !== 'darwin') app.quit();
});
