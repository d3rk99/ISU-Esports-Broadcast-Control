const { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, nativeImage, screen, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { CompanionApiService, normalizeCompanionSettings } = require('./companion-api-service.cjs');
const { RocketLeagueService } = require('./rocket-league-service.cjs');
const { ValorantWindowCapture } = require('./valorant-capture.cjs');
const { HybridValorantWindowCapture, NativeValorantWindowCapture } = require('./valorant-native-capture.cjs');
const { TesseractOcrEngine, isRecoverableWorkerPipeError } = require('./valorant-ocr-engine.cjs');
const { ValorantOcrService } = require('./valorant-ocr-service.cjs');
const { StageDisplayManager } = require('./stage-displays/stage-display-manager.cjs');

const isDev = !app.isPackaged;
const OVERLAY_PORT = 3174;
const OVERLAY_HOST = '127.0.0.1';
const overlayClients = new Set();
let broadcastState = {};
const runtimeDiagnostics = [];
let overlayServer;
let rocketLeagueService;
let valorantOcrService;
let companionApiService;
let stageDisplayManager;
let companionRequestId = 0;
let controllerWindow = null;
const pendingCompanionActions = new Map();
const ROCKET_LEAGUE_CONNECTION_FIELDS = [
  'enabled', 'source', 'transport', 'host', 'tcpPort', 'webPort', 'bridgePort', 'bridgeToken', 'updateIntervalMs'
];
const VALORANT_OCR_SETTINGS_FIELDS = [
  'enabled', 'source', 'windowName', 'captureBackend', 'captureFps', 'profileId', 'language', 'scoreboardMode', 'recordedVideoMode', 'debugRois', 'bridgePort', 'bridgeToken', 'roiOverrides', 'scoreboardTableOverrides', 'observerScanIntervalMs', 'observerConcurrency'
];
app.setAppUserModelId('edu.isu.esports.broadcastcontrol');
process.on('uncaughtException', (error) => {
  if (isRecoverableWorkerPipeError(error)) {
    console.warn('[valorant-ocr] Ignored recoverable OCR worker pipe error:', error?.message || error);
    return;
  }
  throw error;
});
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

function findSharedValorantLoadoutTemplateRoot() {
  const candidates = [
    path.join(process.cwd(), 'public', 'assets', 'valorant', 'weapons', 'trained'),
    path.join(path.dirname(app.getPath('exe')), '..', '..', 'public', 'assets', 'valorant', 'weapons', 'trained'),
    path.join(app.getAppPath(), '..', 'public', 'assets', 'valorant', 'weapons', 'trained')
  ];
  for (const candidate of candidates) {
    try {
      const root = path.resolve(candidate);
      const projectRoot = path.resolve(root, '..', '..', '..', '..', '..');
      if (fs.existsSync(path.join(projectRoot, 'package.json')) && fs.existsSync(path.join(projectRoot, 'public'))) return root;
    } catch {}
  }
  return '';
}

function writableStageAssetRoot() {
  return path.join(app.getPath('userData'), 'stage-assets');
}

function writableStageClientUpdateRoot() {
  return path.join(app.getPath('userData'), 'stage-client-updates');
}

function bundledStageAssetRoot() {
  return path.join(__dirname, '..', 'stage-assets');
}

function findSharedValorantScoreTemplateRoot() {
  const candidates = [
    path.join(process.cwd(), 'public', 'assets', 'valorant', 'scoreboard', 'trained', 'scores'),
    path.join(path.dirname(app.getPath('exe')), '..', '..', 'public', 'assets', 'valorant', 'scoreboard', 'trained', 'scores'),
    path.join(app.getAppPath(), '..', 'public', 'assets', 'valorant', 'scoreboard', 'trained', 'scores')
  ];
  for (const candidate of candidates) {
    try {
      const root = path.resolve(candidate);
      const projectRoot = path.resolve(root, '..', '..', '..', '..', '..', '..');
      if (fs.existsSync(path.join(projectRoot, 'package.json')) && fs.existsSync(path.join(projectRoot, 'public'))) return root;
    } catch {}
  }
  return '';
}

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
let gameSetupOutputWindow = null;

function overlayOutputSize(query = {}) {
  if (query.setup === 'game' && query.resolution === '1440') return { width: 2560, height: 1440 };
  return query.output === 'pair' ? { width: 3840, height: 1080 } : { width: 1920, height: 1080 };
}

function normalizeOutputDisplaySettings(settings = {}) {
  const gameOverlayResolution = String(settings.gameOverlayResolution || '1080') === '1440' ? '1440' : '1080';
  return {
    fillDisplayId: settings.fillDisplayId === undefined || settings.fillDisplayId === null ? '' : String(settings.fillDisplayId),
    keyDisplayId: settings.keyDisplayId === undefined || settings.keyDisplayId === null ? '' : String(settings.keyDisplayId),
    gameOverlayDisplayId: settings.gameOverlayDisplayId === undefined || settings.gameOverlayDisplayId === null ? '' : String(settings.gameOverlayDisplayId),
    gameOverlayResolution,
    autoOpenProgramOutput: settings.autoOpenProgramOutput !== false
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
    if (gameSetupOutputWindow === window) gameSetupOutputWindow = null;
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
  const gameSetupMode = details.query?.setup === 'game';
  const bounds = display?.bounds;
  const options = {
    width: size.width,
    height: size.height,
    minWidth: 640,
    minHeight: 360,
    title: gameSetupMode ? 'Valorant game alignment overlay' : `${details.name} ${outputMode} output`,
    backgroundColor: gameSetupMode ? '#00000000' : '#000000',
    autoHideMenuBar: true,
    frame: false,
    transparent: gameSetupMode,
    alwaysOnTop: gameSetupMode,
    skipTaskbar: gameSetupMode,
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
  output.gameSetupMode = gameSetupMode;
  if (gameSetupMode) gameSetupOutputWindow = output;
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
  if (window.gameSetupMode) {
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setIgnoreMouseEvents(true, { forward: true });
  }
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
  await Promise.all([programOutputWindows.fill.overlayReady, programOutputWindows.key.overlayReady]);
  await loadProgramOutput(name);
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

function getControllerWindow() {
  if (controllerWindow && !controllerWindow.isDestroyed()) return controllerWindow;
  controllerWindow = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.isControllerWindow) || null;
  return controllerWindow;
}

function dispatchCompanionAction(action) {
  const target = getControllerWindow();
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

function valorantOcrSettingsPath() {
  return path.join(app.getPath('userData'), 'valorant-ocr-settings.json');
}

function sanitizeValorantOcrSettings(saved) {
  if (!saved || typeof saved !== 'object') return null;
  return Object.fromEntries(VALORANT_OCR_SETTINGS_FIELDS
    .filter((field) => Object.hasOwn(saved, field))
    .map((field) => [field, saved[field]]));
}

function readValorantOcrSettings() {
  try {
    return sanitizeValorantOcrSettings(JSON.parse(fs.readFileSync(valorantOcrSettingsPath(), 'utf8')));
  } catch {}
  return null;
}

function saveValorantOcrSettings(settings = {}) {
  const saved = Object.fromEntries(VALORANT_OCR_SETTINGS_FIELDS
    .filter((field) => Object.hasOwn(settings, field))
    .map((field) => [field, field === 'enabled' && Object.hasOwn(settings, 'savedEnabled')
      ? Boolean(settings.savedEnabled)
      : settings[field]]));
  fs.writeFileSync(valorantOcrSettingsPath(), JSON.stringify(saved, null, 2), 'utf8');
  return saved;
}

function startOverlayServer() {
  const staticRoot = isDev
    ? path.join(__dirname, '..', 'public')
    : path.join(__dirname, '..', 'dist');
  const assetRoot = path.join(app.getPath('userData'), 'broadcast-assets');
  fs.mkdirSync(assetRoot, { recursive: true });

  overlayServer = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, `http://${OVERLAY_HOST}:${OVERLAY_PORT}`);
    if (requestUrl.pathname.startsWith('/api/stage')) {
      stageDisplayManager?.handleHttp(request, response, requestUrl);
      return;
    }
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
    if (requestUrl.pathname.startsWith('/stage-assets/')) {
      const relativePath = requestUrl.pathname.slice('/stage-assets'.length);
      const stageAssetPath = stageDisplayManager?.resolveAssetPath(relativePath);
      if (stageAssetPath) serveFile(response, stageAssetPath);
      else writeJson(response, 404, { error: 'Stage asset not found' });
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
    overlayServer.listen(OVERLAY_PORT, '0.0.0.0', resolve);
  });
}

async function dispatchCompanionStageAction(action = {}) {
  const actionId = String(action.action || '');
  if (!stageDisplayManager) throw Object.assign(new Error('Stage Display Manager is not ready'), { statusCode: 503 });
  if (actionId === 'stage.mode.set') {
    const result = stageDisplayManager.setGlobalMode(action.mode, action);
    if (!result.ok) throw Object.assign(new Error(result.error || 'Stage mode failed'), { statusCode: 400 });
    return { message: `Stage mode: ${result.mode}` };
  }
  if (actionId === 'stage.station.mode.set') {
    const result = stageDisplayManager.setStationMode(action.station, action.mode, action);
    if (!result.ok) throw Object.assign(new Error(result.error || 'Station mode failed'), { statusCode: 400 });
    return { message: `Station ${String(result.station).padStart(2, '0')}: ${result.mode}` };
  }
  if (actionId === 'stage.preset.prepare') {
    const result = stageDisplayManager.preparePreset(action.preset, action);
    if (!result.ok) throw Object.assign(new Error(result.error || 'Stage preset prepare failed'), { statusCode: 400 });
    return { message: `Prepared stage preset: ${result.title || result.preset}` };
  }
  if (actionId === 'stage.prepared.play') {
    const delay = Math.max(0.2, Number(action.executeDelaySeconds) || 1);
    const result = await stageDisplayManager.playPreparedPreset({
      ...action,
      executeAt: (Date.now() / 1000) + delay,
      prepareTimeoutMs: Number(action.prepareTimeoutMs) || 3500
    });
    if (!result.ok) throw Object.assign(new Error(result.error || 'Stage prepared cue failed'), { statusCode: 409 });
    return { message: `Fired prepared stage preset: ${result.preset}` };
  }
  if (actionId === 'stage.preset.play') {
    const delay = Math.max(0.2, Number(action.executeDelaySeconds) || 1.5);
    const result = await stageDisplayManager.playPreset(action.preset, {
      ...action,
      executeAt: (Date.now() / 1000) + delay
    });
    if (!result.ok) throw Object.assign(new Error(result.error || 'Stage preset failed'), { statusCode: 400 });
    return { message: `Stage preset: ${result.preset}` };
  }
  if (actionId === 'stage.client.update') {
    const result = stageDisplayManager.sendClientUpdate(action.target || 'outdated', action.station || null);
    if (!result.ok) throw Object.assign(new Error(result.error || 'Stage client update failed'), { statusCode: 400 });
    return { message: `Stage client update sent to ${result.sent || 0} station${Number(result.sent || 0) === 1 ? '' : 's'}` };
  }
  throw Object.assign(new Error(`Unknown stage action: ${actionId}`), { statusCode: 404 });
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
  ipcMain.handle('stage-displays:get-status', () => stageDisplayManager.status());
  ipcMain.handle('stage-displays:list-presets', () => stageDisplayManager.listPresets());
  ipcMain.handle('stage-displays:import-preset', async (event, details = {}) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(parent, {
      title: 'Import Stage Preset',
      properties: ['openFile'],
      filters: [
        { name: 'Stage graphics', extensions: ['html', 'htm', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm', 'mov'] }
      ]
    });
    if (result.canceled || !result.filePaths?.[0]) return null;
    const layoutChoice = await dialog.showMessageBox(parent, {
      type: 'question',
      title: 'Stage Preset Layout',
      message: 'What screen layout is this preset designed for?',
      detail: 'This controls the buttons shown for the preset in Stage Displays.',
      buttons: ['5-screen span', '10-screen span', 'Mirror / single screen', 'Cancel'],
      cancelId: 3,
      defaultId: 0,
      noLink: true
    });
    if (layoutChoice.response === 3) return null;
    const layout = layoutChoice.response === 0 ? 'wall-5'
      : layoutChoice.response === 1 ? 'wall-10'
        : 'mirror';
    return stageDisplayManager.importPresetFromFile(result.filePaths[0], { ...details, layout });
  });
  ipcMain.handle('stage-displays:delete-preset', (_event, details = {}) => stageDisplayManager.deletePreset(details.name || details.preset));
  ipcMain.handle('stage-displays:update-preset', (_event, details = {}) => stageDisplayManager.updatePreset(details.name || details.preset, details));
  ipcMain.handle('stage-displays:replace-preset', async (event, details = {}) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(parent, {
      title: 'Replace Stage Preset Media',
      properties: ['openFile'],
      filters: [
        { name: 'Stage graphics', extensions: ['html', 'htm', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm', 'mov'] }
      ]
    });
    if (result.canceled || !result.filePaths?.[0]) return null;
    return stageDisplayManager.replacePresetFromFile(details.name || details.preset, result.filePaths[0], details);
  });
  ipcMain.handle('stage-displays:publish-client-update', async (event, details = {}) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(parent, {
      title: 'Publish Stage Display Client Update',
      properties: ['openFile'],
      filters: [
        { name: 'Stage Display Client build', extensions: ['exe'] }
      ]
    });
    if (result.canceled || !result.filePaths?.[0]) return null;
    return stageDisplayManager.publishClientUpdateFromFile(result.filePaths[0], details);
  });
  ipcMain.handle('stage-displays:send-client-update', (_event, details = {}) => stageDisplayManager.sendClientUpdate(details.target || 'outdated', details.station || null));
  ipcMain.handle('stage-displays:clear-previews', () => stageDisplayManager.clearStationPreviews());
  ipcMain.handle('stage-displays:set-global-mode', (_event, details = {}) => stageDisplayManager.setGlobalMode(details.mode, details));
  ipcMain.handle('stage-displays:set-station-mode', (_event, details = {}) => stageDisplayManager.setStationMode(details.station, details.mode, details));
  ipcMain.handle('stage-displays:prepare-preset', (_event, details = {}) => stageDisplayManager.preparePreset(details.preset, details));
  ipcMain.handle('stage-displays:play-prepared', (_event, details = {}) => stageDisplayManager.playPreparedPreset(details));
  ipcMain.handle('stage-displays:play-preset', (_event, details = {}) => stageDisplayManager.playPreset(details.preset, details));
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
  ipcMain.on('valorant-ocr:get-settings-sync', (event) => {
    event.returnValue = readValorantOcrSettings();
  });
  ipcMain.handle('valorant-ocr:configure', (_event, settings = {}) => {
    const saved = saveValorantOcrSettings(settings);
    const status = valorantOcrService.configure(settings);
    return { settings: saved, status };
  });
  ipcMain.handle('valorant-ocr:get-info', () => valorantOcrService.getInfo());
  ipcMain.handle('valorant-ocr:list-windows', () => valorantOcrService.listWindows());
  ipcMain.handle('valorant-ocr:capture-snapshot', () => valorantOcrService.captureSnapshot());
  ipcMain.handle('valorant-ocr:save-loadout-template', (_event, details = {}) => valorantOcrService.saveLoadoutTemplate(details));
  ipcMain.handle('valorant-ocr:save-score-template', (_event, details = {}) => valorantOcrService.saveScoreTemplate(details));
  ipcMain.handle('valorant-ocr:start-timer-dataset', (_event, details = {}) => valorantOcrService.startTimerDatasetCapture(details));
  ipcMain.handle('valorant-ocr:pause-timer-dataset', () => valorantOcrService.pauseTimerDatasetCapture());
  ipcMain.handle('valorant-ocr:stop-timer-dataset', () => valorantOcrService.stopTimerDatasetCapture());
  ipcMain.handle('valorant-ocr:review-timer-dataset', () => valorantOcrService.reviewTimerDataset());
  ipcMain.handle('valorant-ocr:clear', () => valorantOcrService.clearState());
  ipcMain.handle('valorant-ocr:set-observer-name', (_event, details = {}) => valorantOcrService.setObserverPlayerName(details));
  ipcMain.handle('valorant-ocr:set-timeline-round', (_event, details = {}) => valorantOcrService.setObserverTimelineRound(details));
  ipcMain.handle('valorant-ocr:start-simulator', () => valorantOcrService.startSimulator());
  ipcMain.handle('valorant-ocr:stop-simulator', () => valorantOcrService.stopSimulator());
  ipcMain.handle('assets:pick-image', async (event, details = {}) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const imageType = details.type === 'teamLogo' ? 'team logo' : details.type === 'characterImage' ? 'character' : 'player';
    const result = await dialog.showOpenDialog(parent, {
      title: `Choose ${imageType} image`,
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
    if (details.query?.setup === 'game') {
      if (gameSetupOutputWindow && !gameSetupOutputWindow.isDestroyed()) {
        gameSetupOutputWindow.close();
        gameSetupOutputWindow = null;
        return { opened: false, closed: true };
      }
      details = {
        ...details,
        query: {
          ...(details.query || {}),
          output: details.query?.output || 'fill',
          resolution: outputDisplaySettings.gameOverlayResolution || '1080'
        }
      };
    }
    const outputMode = details.query?.output || 'fill';
    const targetDisplay = details.query?.setup === 'game'
      ? displayBySavedId(outputDisplaySettings.gameOverlayDisplayId, 0)
      : outputMode === 'key'
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

  controllerWindow = window;
  window.isControllerWindow = true;
  window.on('closed', () => {
    if (controllerWindow === window) controllerWindow = null;
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
    getStageStatus: () => stageDisplayManager?.status() || {},
    dispatchAction: dispatchCompanionAction,
    dispatchStageAction: dispatchCompanionStageAction,
    onDiagnostic: recordDiagnostic
  });
  let stageStatusTimer = null;
  let latestStageStatus = null;
  let previewRecipient = null;
  const sentStagePreviews = new Map();
  stageDisplayManager = new StageDisplayManager({
    assetRoot: writableStageAssetRoot(),
    bundledAssetRoot: bundledStageAssetRoot(),
    updateRoot: writableStageClientUpdateRoot(),
    onStatus: (status) => {
      latestStageStatus = status;
      if (stageStatusTimer) return;
      stageStatusTimer = setTimeout(() => {
        stageStatusTimer = null;
        const controller = getControllerWindow();
        if (controller && !controller.isDestroyed()) {
          if (previewRecipient !== controller.webContents) {
            sentStagePreviews.clear();
            previewRecipient = controller.webContents;
          }
          const stations = latestStageStatus.stations.map((station) => {
            const { preview, ...metadata } = station;
            if (sentStagePreviews.get(station.station) === preview) return metadata;
            sentStagePreviews.set(station.station, preview);
            return { ...metadata, preview };
          });
          controller.webContents.send('stage-displays:status', { ...latestStageStatus, stations });
        }
        companionApiService?.publish(broadcastState);
      }, 100);
    }
  });
  rocketLeagueService = new RocketLeagueService({
    onEvent: (event) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('rocket-league:event', event);
    },
    onStatus: (status) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('rocket-league:status', status);
    }
  });
  valorantOcrService = new ValorantOcrService({
    capture: new HybridValorantWindowCapture({
      nativeCapture: new NativeValorantWindowCapture({ nativeImage }),
      fallbackCapture: new ValorantWindowCapture({ desktopCapturer, nativeImage })
    }),
    ocr: new TesseractOcrEngine(),
    templateRoot: path.join(app.getPath('userData'), 'valorant-loadout-templates'),
    sharedTemplateRoot: findSharedValorantLoadoutTemplateRoot(),
    scoreTemplateRoot: path.join(app.getPath('userData'), 'valorant-score-templates'),
    sharedScoreTemplateRoot: findSharedValorantScoreTemplateRoot(),
    onState: (state) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('valorant-ocr:state', state);
    },
    onStatus: (status) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('valorant-ocr:status', status);
    }
  });
  registerIpc();
  await companionApiService.configure(readCompanionSettings());
  await stageDisplayManager.start();
  try {
    await startOverlayServer();
  } catch (error) {
    dialog.showErrorBox('Overlay server could not start', `Port ${OVERLAY_PORT} is unavailable. Close any other copy of ISU Esports Broadcast Control and reopen the app.\n\n${error.message}`);
  }
  createWindow();
  app.on('activate', () => {
    if (!getControllerWindow()) createWindow();
  });
});

app.on('second-instance', () => {
  const window = getControllerWindow();
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});

app.on('window-all-closed', () => {
  rocketLeagueService?.stop();
  valorantOcrService?.shutdown();
  stageDisplayManager?.shutdown();
  companionApiService?.stop();
  if (process.platform !== 'darwin') app.quit();
});
