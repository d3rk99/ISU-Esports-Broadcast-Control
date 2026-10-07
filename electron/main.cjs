const { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, nativeImage, screen, shell } = require('electron');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const { MAX_MODEL_BYTES, validateCarGlb } = require('./rl-car-assets.cjs');
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
const { OverwatchOcrService, normalizeSettings: normalizeOverwatchOcrSettings } = require('./overwatch-ocr-service.cjs');
const { ValorantBoardService, normalizeSettings: normalizeValorantBoardSettings } = require('./valorant-board-service.cjs');
const { WebSocketServer } = require('ws');
const { DisplayManager } = require('./displays/display-manager.cjs');
const { ObsClient, setupStageScenes, stageStatus: obsStageStatus } = require('./displays/obs-displays.cjs');

const isDev = !app.isPackaged;
const OVERLAY_PORT = 3174;
const OVERLAY_HOST = '127.0.0.1';
const { OverlayEventHub } = require('./overlay-events.cjs');
// Declared before recordDiagnostic is defined; onDrop only fires at runtime, after startup.
const overlayClients = new OverlayEventHub({
  onDrop: ({ buffered }) => recordDiagnostic('overlay-client-dropped', `Dropped a stalled overlay viewer with ${Math.round(buffered / 1024)} KB unsent; it will reconnect`)
});
let broadcastState = {};
// Who the player-POV spectator is watching (from the Game Bridge's spectate tracker).
let spectatedPlayer = { name: '', station: null, side: '', team: '', score: 0, since: 0, receivedAt: 0, game: '' };
const runtimeDiagnostics = [];
let overlayServer;
let rocketLeagueService;
let valorantOcrService;
let overwatchOcrService;
let valorantBoardService;
let companionApiService;
let displayManager;
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

// Display key: display clients must send the same key (blank = open).
function displayKeyPath() { return path.join(app.getPath('userData'), 'display-key.json'); }
function readDisplayKey() { try { return String(JSON.parse(fs.readFileSync(displayKeyPath(), 'utf8')).key || '').trim(); } catch { return ''; } }
function saveDisplayKey(key = '') { fs.writeFileSync(displayKeyPath(), JSON.stringify({ key: String(key || '').trim() }, null, 2), { encoding: 'utf8', mode: 0o600 }); }

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
  '.glb': 'model/gltf-binary',
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

function closeProgramOutput() {
  const windows = [programOutputWindows.fill, programOutputWindows.key];
  programOutputWindows = { fill: null, key: null };
  for (const window of new Set(windows)) {
    if (window && !window.isDestroyed()) window.destroy();
  }
}

async function openProgramOutput(name = programOutputName) {
  if (!PROGRAM_OUTPUTS.has(name) || !getControllerWindow()) return false;
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
  if (!getControllerWindow() || !programOutputWindows.fill || !programOutputWindows.key) return false;
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

let rocketLeagueLoadoutPackCache = null;

function rocketLeagueLoadoutPackLocations() {
  const names = ['rl-loadout-assets', 'rl-loadout-assets.zip'];
  const roots = [
    path.join(__dirname, '..', 'assests'),
    path.join(process.cwd(), 'assests'),
    ...(process.env.PORTABLE_EXECUTABLE_DIR ? [
      path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'assests'),
      path.join(process.env.PORTABLE_EXECUTABLE_DIR, '..', '..', 'assests')
    ] : []),
    path.join(path.dirname(process.execPath || ''), 'assests'),
    path.join(path.dirname(process.execPath || ''), '..', '..', '..', 'assests'),
    path.join(path.dirname(process.execPath || ''), '..', '..', 'assests')
  ];
  const uniqueRoots = [...new Set(roots.map((item) => path.resolve(item)))];
  return uniqueRoots.flatMap((root) => names.map((name) => path.join(root, name)));
}

function rocketLeagueItemsCsvLocations() {
  return [
    path.join(__dirname, '..', 'assests', 'rocket-league-items.csv'),
    path.join(process.cwd(), 'assests', 'rocket-league-items.csv'),
    path.join(path.dirname(process.execPath || ''), 'assests', 'rocket-league-items.csv'),
    path.join(path.dirname(process.execPath || ''), '..', '..', 'assests', 'rocket-league-items.csv'),
    'E:\\Steam\\steamapps\\common\\rocketleague\\Binaries\\Win64\\items.csv'
  ];
}

function rocketLeagueItemKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function parseRocketLeagueItemsCsv() {
  for (const candidate of rocketLeagueItemsCsvLocations()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const records = [];
      for (const line of fs.readFileSync(candidate, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^([^,]*),([^,]*),([^,]*),(.*)$/);
        if (!match) continue;
        const productId = match[1].trim();
        const type = match[2].trim();
        const objectPath = match[3].trim();
        const displayName = match[4].trim();
        const internalName = objectPath.split('.').pop() || '';
        if (!productId || !type || !internalName) continue;
        records.push({ productId, type, objectPath, internalName, displayName });
      }
      return { path: candidate, records };
    } catch (error) {
      recordDiagnostic('rl-items-csv', `${candidate}: ${error.message}`);
    }
  }
  return { path: '', records: [] };
}

function aliasesForRocketLeagueBody(body, items) {
  const aliases = new Set([body.id, body.productId, body.displayName]);
  const bodyIdKey = rocketLeagueItemKey(body.id);
  const displayKey = rocketLeagueItemKey(body.displayName);
  for (const item of items) {
    if (item.type !== 'Body') continue;
    const internalKey = rocketLeagueItemKey(item.internalName);
    const itemDisplayKey = rocketLeagueItemKey(item.displayName);
    if (internalKey === bodyIdKey || itemDisplayKey === displayKey || (displayKey && itemDisplayKey === displayKey)) {
      aliases.add(item.productId);
      aliases.add(item.internalName);
      aliases.add(item.displayName);
      aliases.add(item.objectPath);
    }
  }
  return [...aliases].filter(Boolean);
}

function aliasesForRocketLeagueItem(asset, items, type) {
  const aliases = new Set([asset.id, asset.productId, asset.displayName]);
  const idKey = rocketLeagueItemKey(asset.id);
  const displayKey = rocketLeagueItemKey(asset.displayName);
  for (const item of items) {
    if (item.type !== type) continue;
    const internalKey = rocketLeagueItemKey(item.internalName);
    const itemDisplayKey = rocketLeagueItemKey(item.displayName);
    if (internalKey === idKey || itemDisplayKey === displayKey || (displayKey && itemDisplayKey === displayKey)) {
      aliases.add(item.productId);
      aliases.add(item.internalName);
      aliases.add(item.displayName);
      aliases.add(item.objectPath);
    }
  }
  return [...aliases].filter(Boolean);
}

function findRocketLeagueLoadoutPack() {
  for (const candidate of rocketLeagueLoadoutPackLocations()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const stats = fs.statSync(candidate);
      if (stats.isDirectory() && fs.existsSync(path.join(candidate, 'manifest.json'))) return { type: 'directory', root: candidate };
      if (stats.isFile() && candidate.toLowerCase().endsWith('.zip')) return { type: 'zip', root: candidate };
    } catch {}
  }
  return null;
}

function readRocketLeaguePackFile(pack, relativePath) {
  if (pack.type === 'directory') return fs.readFileSync(path.join(pack.root, relativePath));
  return childProcess.execFileSync('tar', ['-xOf', pack.root, `rl-loadout-assets/${relativePath}`], { maxBuffer: 96 * 1024 * 1024 });
}

function normalizeRocketLeaguePackPath(relativePath) {
  const clean = decodeURIComponent(String(relativePath || '')).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.includes('\0') || clean.split('/').some((part) => part === '..') || path.isAbsolute(clean)) return '';
  return clean;
}

function listRocketLeaguePackPaths(pack) {
  if (pack.type === 'directory') {
    const output = [];
    const walk = (directory, prefix = '') => {
      for (const name of fs.readdirSync(directory)) {
        const fullPath = path.join(directory, name);
        const relative = prefix ? `${prefix}/${name}` : name;
        const stats = fs.statSync(fullPath);
        if (stats.isDirectory()) walk(fullPath, relative);
        else output.push(relative);
      }
    };
    walk(pack.root);
    return output;
  }
  return childProcess.execFileSync('tar', ['-tf', pack.root], { maxBuffer: 160 * 1024 * 1024 })
    .toString('utf8')
    .split(/\r?\n/)
    .map((line) => line.replace(/^rl-loadout-assets\//, '').trim())
    .filter(Boolean);
}

function rocketLeagueTextureName(pathValue = '') {
  return String(pathValue).split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();
}

function parseRocketLeagueMaterialText(text = '') {
  const result = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^([A-Za-z]+)(?:\[(\d+)])?=(.+)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[3].trim();
    if (!value) continue;
    if (key === 'diffuse') result.diffuse = value;
    else if (key === 'normal') result.normal = value;
    else if (key === 'mask' || key === 'rgb') result.mask = value;
    else if (key === 'other') {
      result.other = result.other || [];
      result.other.push(value);
    }
  }
  return result;
}

function materialBindingsForAsset(pack, asset, paths = null) {
  const bindings = {};
  const textureByName = new Map((asset.textures || []).map((texture) => [rocketLeagueTextureName(texture.path), texture.path]));
  for (const material of asset.materials || []) {
    const matPath = `${asset.folder}/${material}.mat`;
    if (paths && !paths.has(matPath)) continue;
    try {
      const parsed = parseRocketLeagueMaterialText(readRocketLeaguePackFile(pack, matPath).toString('utf8'));
      const binding = {};
      for (const [role, textureName] of Object.entries(parsed)) {
        if (role === 'other') continue;
        const texturePath = textureByName.get(rocketLeagueTextureName(textureName));
        if (texturePath) binding[role] = texturePath;
      }
      for (const other of parsed.other || []) {
        const texturePath = textureByName.get(rocketLeagueTextureName(other));
        if (!texturePath) continue;
        binding.other = binding.other || [];
        binding.other.push(texturePath);
        const texture = (asset.textures || []).find((item) => item.path === texturePath);
        if (texture?.role === 'mask' && !binding.mask) binding.mask = texturePath;
        if (texture?.role === 'blankskin' && !binding.blankskin) binding.blankskin = texturePath;
        if (texture?.role === 'diffuse' && /skin|decal|flame|stripe|paint/i.test(texturePath) && !binding.decal) binding.decal = texturePath;
      }
      if (Object.keys(binding).length) bindings[material] = binding;
    } catch (error) {
      if (paths) recordDiagnostic('rl-loadout-material', `${matPath}: ${error.message}`);
    }
  }
  return bindings;
}

function rocketLeagueLoadoutPack() {
  const pack = findRocketLeagueLoadoutPack();
  if (!pack) return { available: false, bodies: [], wheels: [], decals: [], finishes: [], error: 'rl-loadout-assets.zip was not found in the assests folder.' };
  if (rocketLeagueLoadoutPackCache?.root === pack.root && rocketLeagueLoadoutPackCache?.type === pack.type) return rocketLeagueLoadoutPackCache.value;
  try {
    const manifest = JSON.parse(readRocketLeaguePackFile(pack, 'manifest.json').toString('utf8'));
    const itemDb = parseRocketLeagueItemsCsv();
    const knownPaths = new Set(['manifest.json']);
    const assetUrl = (relativePath) => relativePath ? `http://${OVERLAY_HOST}:${OVERLAY_PORT}/rl-loadout-assets/${relativePath}` : '';
    const remember = (relativePath) => { if (relativePath) knownPaths.add(normalizeRocketLeaguePackPath(relativePath)); };
    const bodySummaries = (manifest.bodies || []).map((body) => {
      remember(body.mesh); remember(body.thumbnail);
      for (const mesh of body.meshes || []) remember(mesh);
      for (const texture of body.textures || []) remember(texture.path);
      return {
        id: body.id,
        productId: body.productId,
        displayName: body.displayName || body.id,
        folder: body.folder || '',
        mesh: body.mesh,
        meshUrl: assetUrl(body.mesh),
        thumbnail: body.thumbnail || '',
        thumbnailUrl: assetUrl(body.thumbnail),
        textureCount: (body.textures || []).length,
        wheelAnchors: body.wheelAnchors || {},
        materials: body.materials || [],
        aliases: aliasesForRocketLeagueBody(body, itemDb.records)
      };
    });
    const wheelSummaries = (manifest.wheels || []).map((wheel) => {
      remember(wheel.mesh); remember(wheel.thumbnail);
      for (const mesh of wheel.meshes || []) remember(mesh);
      for (const texture of wheel.textures || []) remember(texture.path);
      return {
        id: wheel.id,
        productId: wheel.productId,
        displayName: wheel.displayName || wheel.id,
        folder: wheel.folder || '',
        mesh: wheel.mesh,
        meshUrl: assetUrl(wheel.mesh),
        thumbnail: wheel.thumbnail || '',
        thumbnailUrl: assetUrl(wheel.thumbnail),
        textureCount: (wheel.textures || []).length,
        materials: wheel.materials || [],
        aliases: aliasesForRocketLeagueItem(wheel, itemDb.records, 'Wheel')
      };
    });
    const decalSummaries = (manifest.decals || []).map((decal) => {
      remember(decal.thumbnail);
      for (const texture of decal.textures || []) remember(texture.path);
      return {
        id: decal.id,
        productId: decal.productId,
        displayName: decal.displayName || decal.id,
        folder: decal.folder || '',
        appliesToBodyId: decal.appliesToBodyId || '',
        appliesToBodyName: decal.appliesToBodyName || '',
        universal: Boolean(decal.universal),
        thumbnail: decal.thumbnail || '',
        thumbnailUrl: assetUrl(decal.thumbnail),
        textureCount: (decal.textures || []).length,
        materials: decal.materials || [],
        aliases: aliasesForRocketLeagueItem(decal, itemDb.records, 'Skin')
      };
    });
    const finishSummaries = (manifest.finishes || []).map((finish) => {
      remember(finish.thumbnail); remember(finish.detailNormal);
      return {
        id: finish.id,
        productId: finish.productId,
        displayName: finish.displayName || finish.id,
        thumbnailUrl: assetUrl(finish.thumbnail),
        detailNormalUrl: assetUrl(finish.detailNormal),
        lightCurve: finish.lightCurve || '',
        specularStrength: Number(finish.specularStrength) || 0,
        specularTint: Number(finish.specularTint) || 0,
        environmentStrength: Number(finish.environmentStrength) || 0,
        rimLightTint: Number(finish.rimLightTint) || 0,
        sparkleStrength: Number(finish.sparkleStrength) || 0,
        pearlescentStrength: Number(finish.pearlescentStrength) || 0,
        diffuseDetailNormalStrength: Number(finish.diffuseDetailNormalStrength) || 0,
        specularDetailNormalStrength: Number(finish.specularDetailNormalStrength) || 0,
        aliases: aliasesForRocketLeagueItem(finish, itemDb.records, 'PaintFinish')
      };
    });
    const value = {
      available: true,
      source: pack.type,
      root: pack.root,
      itemsCsv: itemDb.path,
      itemCount: itemDb.records.length,
      bodies: bodySummaries.sort((a, b) => a.displayName.localeCompare(b.displayName)),
      wheels: wheelSummaries.sort((a, b) => a.displayName.localeCompare(b.displayName)),
      decals: decalSummaries.sort((a, b) => a.displayName.localeCompare(b.displayName)),
      finishes: finishSummaries.sort((a, b) => a.displayName.localeCompare(b.displayName)),
      knownPaths: [...knownPaths]
    };
    rocketLeagueLoadoutPackCache = { type: pack.type, root: pack.root, value };
    return value;
  } catch (error) {
    rocketLeagueLoadoutPackCache = null;
    return { available: false, bodies: [], wheels: [], decals: [], finishes: [], error: error.message };
  }
}

function rocketLeagueLoadoutAssetDetails(kind, id) {
  const info = rocketLeagueLoadoutPack();
  if (!info.available) return { available: false, error: info.error || 'Rocket League asset pack is unavailable.' };
  const pack = findRocketLeagueLoadoutPack();
  if (!pack) return { available: false, error: 'Rocket League asset pack is unavailable.' };
  const groups = {
    body: ['bodies', info.bodies],
    wheel: ['wheels', info.wheels],
    decal: ['decals', info.decals]
  };
  const group = groups[String(kind || '')];
  if (!group) return { available: false, error: 'Unknown Rocket League asset type.' };
  try {
    const manifest = JSON.parse(readRocketLeaguePackFile(pack, 'manifest.json').toString('utf8'));
    const raw = (manifest[group[0]] || []).find((asset) => String(asset.id) === String(id));
    const summary = (group[1] || []).find((asset) => String(asset.id) === String(id));
    if (!raw || !summary) return { available: false, error: 'Rocket League asset was not found.' };
    return {
      available: true,
      asset: {
        ...summary,
        textures: (raw.textures || []).map((texture) => ({ ...texture, url: `http://${OVERLAY_HOST}:${OVERLAY_PORT}/rl-loadout-assets/${texture.path}` })),
        materials: raw.materials || [],
        wheelAnchors: raw.wheelAnchors || summary.wheelAnchors || {},
        materialBindings: materialBindingsForAsset(pack, raw)
      }
    };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

function serveRocketLeagueLoadoutAsset(response, requestPath) {
  const relativePath = normalizeRocketLeaguePackPath(requestPath);
  const packInfo = rocketLeagueLoadoutPack();
  if (!packInfo.available || !relativePath || !packInfo.knownPaths.includes(relativePath)) {
    writeJson(response, 404, { error: 'Rocket League loadout asset not found' });
    return;
  }
  const pack = { type: packInfo.source, root: packInfo.root };
  if (pack.type === 'directory') {
    serveFile(response, safeFilePath(pack.root, `/${relativePath}`));
    return;
  }
  const tar = childProcess.spawn('tar', ['-xOf', pack.root, `rl-loadout-assets/${relativePath}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  tar.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  tar.once('error', (error) => {
    if (!response.headersSent) writeJson(response, 500, { error: error.message });
    else response.destroy(error);
  });
  response.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(relativePath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  tar.stdout.pipe(response);
  tar.once('close', (code) => {
    if (code !== 0) {
      recordDiagnostic('rl-loadout-asset-pack', stderr || `tar exited ${code}`);
      if (!response.destroyed) response.destroy();
    }
  });
}

function publishBroadcastState(nextState) {
  if (!nextState || typeof nextState !== 'object') return;
  broadcastState = nextState;
  valorantOcrService?.setSpectateCandidates(spectateCandidatesFrom(nextState));
  overlayClients.publish(broadcastState);
  companionApiService?.publish(broadcastState);
}

// Every gamertag the spectate tracker may report: both teams' Varsity + JV rosters (with their
// stage station) plus names the scoreboard reader saw this map.
function spectateCandidatesFrom(state = {}) {
  const game = state.games?.[state.selectedGame] || {};
  const out = [];
  for (const [side, rosters, team] of [['home', game.rosters, game.teams?.[0]], ['away', game.awayRosters, game.teams?.[1]]]) {
    for (const key of ['varsity', 'jv']) for (const p of rosters?.[key] || []) {
      const name = String(p?.handle || p?.name || '').trim();
      if (name) out.push({ name, station: Math.round(Number(p.stageStation) || 0) || null, side, team: team?.name || '' });
    }
  }
  const live = state.selectedGame === 'valorant' ? game.valorantBoard?.live?.teams : state.selectedGame === 'overwatch' ? game.overwatchOcr?.live?.teams : null;
  for (const side of ['home', 'away']) for (const p of live?.[side]?.players || []) if (p?.name) out.push({ name: p.name, station: null, side, team: '' });
  return out;
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

function valorantBoardSettingsPath() { return path.join(app.getPath('userData'), 'valorant-board-settings.json'); }
function readValorantBoardSettings() {
  try { return normalizeValorantBoardSettings(JSON.parse(fs.readFileSync(valorantBoardSettingsPath(), 'utf8'))); } catch {}
  return normalizeValorantBoardSettings();
}
function saveValorantBoardSettings(settings = {}) {
  const saved = normalizeValorantBoardSettings({ ...readValorantBoardSettings(), ...settings });
  fs.writeFileSync(valorantBoardSettingsPath(), JSON.stringify(saved, null, 2), 'utf8');
  return saved;
}

function overwatchOcrSettingsPath() {
  return path.join(app.getPath('userData'), 'overwatch-ocr-settings.json');
}

function readOverwatchOcrSettings() {
  try { return normalizeOverwatchOcrSettings(JSON.parse(fs.readFileSync(overwatchOcrSettingsPath(), 'utf8'))); } catch {}
  return normalizeOverwatchOcrSettings();
}

function saveOverwatchOcrSettings(settings = {}) {
  const saved = normalizeOverwatchOcrSettings({ ...readOverwatchOcrSettings(), ...settings });
  fs.writeFileSync(overwatchOcrSettingsPath(), JSON.stringify(saved, null, 2), 'utf8');
  return saved;
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
      overlayClients.add(request, response, broadcastState);
      return;
    }
    if (requestUrl.pathname.startsWith('/user-assets/')) {
      const relativePath = requestUrl.pathname.slice('/user-assets'.length);
      serveFile(response, safeFilePath(assetRoot, relativePath));
      return;
    }
    if (requestUrl.pathname.startsWith('/rl-loadout-assets/')) {
      serveRocketLeagueLoadoutAsset(response, requestUrl.pathname.slice('/rl-loadout-assets/'.length));
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
    // Audience display preset pages (OBS browser sources -> NDI "ISU Stage NN").
    if (requestUrl.pathname.startsWith('/displays/') || requestUrl.pathname.startsWith('/shared/')) {
      serveFile(response, safeFilePath(staticRoot, requestUrl.pathname));
      return;
    }
    writeJson(response, 404, { error: 'Not found' });
  });

  // Live state over WebSocket too (see overlay-events.cjs: OBS allows only 6 SSE pages).
  const overlaySockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  overlayServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, `http://${OVERLAY_HOST}:${OVERLAY_PORT}`).pathname;
    if (pathname !== '/ws') { socket.destroy(); return; }
    overlaySockets.handleUpgrade(request, socket, head, (ws) => overlayClients.addSocket(ws, broadcastState));
  });

  return new Promise((resolve, reject) => {
    overlayServer.once('error', reject);
    overlayServer.listen(OVERLAY_PORT, '0.0.0.0', resolve);
  });
}

// Companion "stage.*" actions drive the display clients (game mirror / NDI).
async function dispatchCompanionStageAction(action = {}) {
  const actionId = String(action.action || '');
  if (!displayManager) throw Object.assign(new Error('Display manager is not ready'), { statusCode: 503 });
  if (actionId === 'stage.display.mode') {
    const result = displayManager.setMode(action.station === undefined || action.station === '' ? 'all' : action.station, String(action.mode || ''), action.source || '');
    if (!result.ok) throw Object.assign(new Error(result.error), { statusCode: 400 });
    return { message: `Displays ${action.station || 'all'}: ${result.mode}` };
  }
  if (actionId === 'stage.display.noise') {
    const raw = String(action.on ?? action.state ?? 'toggle').toLowerCase();
    const on = raw === 'toggle' || raw === 'keep' ? raw : ['on', 'true', '1', 'start', 'play'].includes(raw);
    const result = displayManager.setNoise(action.station === undefined || action.station === '' ? 'all' : action.station, on, action.volume);
    if (!result.ok) throw Object.assign(new Error(result.error), { statusCode: 400 });
    return { message: `Pink noise ${action.station || 'all'}: ${result.on ? 'on' : 'off'}` };
  }
  throw Object.assign(new Error(`Unknown display action: ${actionId}`), { statusCode: 404 });
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
  // Display clients (game mirror / NDI) + OBS display presets.
  ipcMain.handle('displays:status', () => displayManager.status());
  ipcMain.handle('displays:set-mode', (_event, d = {}) => displayManager.setMode(d.station ?? 'all', d.mode, d.source || ''));
  ipcMain.handle('displays:set-noise', (_event, d = {}) => displayManager.setNoise(d.station ?? 'all', d.on, d.volume));
  ipcMain.handle('displays:get-key', () => ({ key: displayManager.key || '' }));
  ipcMain.handle('displays:set-key', (_event, d = {}) => { saveDisplayKey(d.key); return displayManager.setKey(d.key); });
  const obsPath = () => path.join(app.getPath('userData'), 'obs-displays.json');
  const readObs = () => { try { return JSON.parse(fs.readFileSync(obsPath(), 'utf8')); } catch { return {}; } };
  const publicObs = (c = readObs()) => ({ host: c.host || '127.0.0.1', port: Number(c.port) || 4455, hasPassword: Boolean(c.password), resolution: c.resolution || '1280x720', fps: Number(c.fps) || 30, controllerUrl: c.controllerUrl || '' });
  const withObs = async (fn) => {
    const c = readObs(); const client = new ObsClient();
    try { await client.connect({ host: c.host || '127.0.0.1', port: Number(c.port) || 4455, password: c.password || '' }); return await fn(client, c); }
    finally { client.close(); }
  };
  ipcMain.handle('obs-displays:get', () => publicObs());
  ipcMain.handle('obs-displays:save', (_event, d = {}) => {
    const prev = readObs();
    const next = {
      host: String(d.host || '127.0.0.1').trim().slice(0, 255),
      port: Math.max(1, Math.min(65535, Math.round(Number(d.port) || 4455))),
      password: d.clearPassword ? '' : (String(d.password || '') || prev.password || ''),
      resolution: ['1280x720', '1920x1080'].includes(d.resolution) ? d.resolution : '1280x720',
      fps: [30, 60].includes(Number(d.fps)) ? Number(d.fps) : 30,
      controllerUrl: String(d.controllerUrl || '').trim().slice(0, 255)
    };
    fs.writeFileSync(obsPath(), JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
    return publicObs(next);
  });
  ipcMain.handle('obs-displays:setup', async () => {
    try {
      return { ok: true, ...(await withObs((client, c) => {
        const [width, height] = (c.resolution || '1280x720').split('x').map(Number);
        const lan = Object.values(os.networkInterfaces()).flat().find((e) => e?.family === 'IPv4' && !e.internal)?.address || '127.0.0.1';
        return setupStageScenes(client, { controllerUrl: c.controllerUrl || `http://${lan}:${OVERLAY_PORT}`, width, height, fps: Number(c.fps) || 30 });
      })) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('obs-displays:status', async () => {
    try { return { ok: true, ...(await withObs((client) => obsStageStatus(client))) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
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
  ipcMain.handle('valorant-board:get-settings', () => ({ settings: readValorantBoardSettings(), status: valorantBoardService.getStatus() }));
  ipcMain.handle('valorant-board:configure', (_event, settings = {}) => { const saved = saveValorantBoardSettings(settings); return { settings: saved, status: valorantBoardService.configure(saved) }; });
  ipcMain.handle('valorant-board:clear', () => { valorantBoardService.clear(); return valorantBoardService.snapshot(); });
  ipcMain.handle('valorant-board:set-name', (_event, details = {}) => valorantBoardService.setPlayerName(details));
  ipcMain.handle('valorant-board:test-read', async () => { await valorantBoardService.sweep(); return valorantBoardService.snapshot(); });
  ipcMain.handle('overwatch-ocr:get-settings', () => ({ settings: readOverwatchOcrSettings(), status: overwatchOcrService.getStatus() }));
  ipcMain.handle('overwatch-ocr:configure', (_event, settings = {}) => {
    const saved = saveOverwatchOcrSettings(settings);
    return { settings: saved, status: overwatchOcrService.configure(saved) };
  });
  ipcMain.handle('overwatch-ocr:clear', () => { overwatchOcrService.clear(); return overwatchOcrService.snapshot(); });
  ipcMain.handle('overwatch-ocr:set-name', (_event, details = {}) => overwatchOcrService.setPlayerName(details));
  ipcMain.handle('overwatch-ocr:debug-capture', () => overwatchOcrService.debugCapture());
  ipcMain.handle('overwatch-ocr:test-read', async () => { await overwatchOcrService.sweep(); return overwatchOcrService.snapshot(); });
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
  ipcMain.handle('rl-car:pick-model', async (event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Import self-contained car GLB (models you have permission to use)',
      properties: ['openFile'], filters: [{ name: 'Embedded glTF model', extensions: ['glb'] }]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const source = result.filePaths[0];
    if (fs.statSync(source).size > MAX_MODEL_BYTES) throw Error('Model exceeds 32 MB.');
    const bytes = await fs.promises.readFile(source);
    validateCarGlb(bytes);
    const filename = `car-${crypto.createHash('sha256').update(bytes).digest('hex')}.glb`;
    const directory = path.join(app.getPath('userData'), 'broadcast-assets');
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(path.join(directory, filename), bytes);
    return { name: path.basename(source), url: `http://${OVERLAY_HOST}:${OVERLAY_PORT}/user-assets/${filename}` };
  });
  ipcMain.handle('rl-car:get-asset-pack', () => {
    const info = rocketLeagueLoadoutPack();
    return {
      available: info.available,
      source: info.source,
      root: info.root,
      itemsCsv: info.itemsCsv,
      itemCount: info.itemCount,
      error: info.error,
      bodies: info.bodies,
      wheels: info.wheels,
      decals: info.decals
    };
  });
  ipcMain.handle('rl-car:get-asset-details', (_event, details = {}) => rocketLeagueLoadoutAssetDetails(details.kind, details.id));
  ipcMain.handle('rl-car:save-render', async (_event, dataUrl) => {
    if (typeof dataUrl !== 'string' || dataUrl.length > 6 * 1024 * 1024 || !dataUrl.startsWith('data:image/png;base64,')) throw Error('Expected a PNG render under 6 MB.');
    const raw = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
    if (raw.length < 24 || raw.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || raw.readUInt32BE(16) > 2048 || raw.readUInt32BE(20) > 2048) throw Error('Invalid PNG dimensions.');
    const image = nativeImage.createFromDataURL(dataUrl);
    const size = image.getSize();
    if (image.isEmpty() || size.width > 2048 || size.height > 2048) throw Error('Invalid render dimensions.');
    const bytes = image.toPNG();
    const filename = `car-render-${crypto.createHash('sha256').update(bytes).digest('hex')}.png`;
    const directory = path.join(app.getPath('userData'), 'broadcast-assets');
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(path.join(directory, filename), bytes);
    return { url: `http://${OVERLAY_HOST}:${OVERLAY_PORT}/user-assets/${filename}` };
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
    if (controllerWindow === window) {
      controllerWindow = null;
      closeProgramOutput();
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
    getStageStatus: () => ({ ...(displayManager?.status() || {}), spectated: spectatedPlayer }),
    dispatchAction: dispatchCompanionAction,
    dispatchStageAction: dispatchCompanionStageAction,
    onDiagnostic: recordDiagnostic
  });
  let displayStatusTimer = null;
  displayManager = new DisplayManager({
    key: readDisplayKey(),
    onStatus: (status) => {
      if (displayStatusTimer) return;
      displayStatusTimer = setTimeout(() => {
        displayStatusTimer = null;
        const controller = getControllerWindow();
        if (controller && !controller.isDestroyed()) controller.webContents.send('displays:status', displayManager.status());
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
    },
    onSpectated: (spectated) => {
      spectatedPlayer = { ...spectatedPlayer, ...spectated };
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('spectated:update', spectatedPlayer);
      companionApiService?.publish(broadcastState);
    }
  });
  // Spectated name goes stale if the bridge stops sending: re-publish so Companion clears it.
  setInterval(() => { if (spectatedPlayer.name && Date.now() - spectatedPlayer.receivedAt > 10000) { spectatedPlayer = { ...spectatedPlayer, name: '', station: null }; companionApiService?.publish(broadcastState); } }, 3000).unref?.();
  // Overwatch scoreboard OCR shares the window-capture stack and Tesseract engine design with
  // VALORANT but has its own engine instance (its own worker pool) and its own window.
  overwatchOcrService = new OverwatchOcrService({
    capture: new HybridValorantWindowCapture({
      nativeCapture: new NativeValorantWindowCapture({ nativeImage }),
      fallbackCapture: new ValorantWindowCapture({ desktopCapturer, nativeImage })
    }),
    ocr: new TesseractOcrEngine(),
    onState: (state) => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('overwatch-ocr:state', state); },
    onStatus: (status) => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('overwatch-ocr:status', status); }
  });
  overwatchOcrService.configure(readOverwatchOcrSettings());
  // VALORANT scoreboard (Tab) reader, rebuilt like the Overwatch one: own capture + OCR pool.
  valorantBoardService = new ValorantBoardService({
    capture: new HybridValorantWindowCapture({
      nativeCapture: new NativeValorantWindowCapture({ nativeImage }),
      fallbackCapture: new ValorantWindowCapture({ desktopCapturer, nativeImage })
    }),
    ocr: new TesseractOcrEngine(),
    onState: (state) => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('valorant-board:state', state); },
    onStatus: (status) => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('valorant-board:status', status); }
  });
  valorantBoardService.configure(readValorantBoardSettings());
  registerIpc();
  await companionApiService.configure(readCompanionSettings());
  await displayManager.start();
  if (displayManager.error) recordDiagnostic('displays', displayManager.error);
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
  overwatchOcrService?.shutdown();
  valorantBoardService?.shutdown();
  displayManager?.stop();
  companionApiService?.stop();
  if (process.platform !== 'darwin') app.quit();
});
