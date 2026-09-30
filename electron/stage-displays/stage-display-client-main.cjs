const { app, BrowserWindow, Menu, Tray, desktopCapturer, globalShortcut, nativeImage, ipcMain, screen, dialog } = require('electron');
const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const { CLIENT_VERSION } = require('./client-version.cjs');
const { createUpdaterScript } = require('./client-updater.cjs');
const { ClockSync } = require('./clock-sync.cjs');
let clientWindow = null;
let timeSyncTimer = null;
const clockSync = new ClockSync();
let settingsWindow = null;
let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let previewTimer = null;
let currentMode = 'hold';
let currentPreset = '';
let lastError = '';
let config = null;
let tray = null;
let cursorLockActive = false;
let cursorLockProcess = null;
let cursorLockBoundsKey = '';
let updateInProgress = false;

if (process.env.STAGE_DISPLAY_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.STAGE_DISPLAY_USER_DATA));
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function clientConfigPath() {
  return process.env.STAGE_DISPLAY_CONFIG
    || path.join(app.getPath('userData'), 'stage-display-client.json');
}

function normalizeClientConfig(saved = {}) {
  const stationId = Math.max(1, Math.min(11, Math.round(Number(saved.stationId) || 1)));
  const playerDisplay = Math.max(1, Math.round(Number(saved.playerDisplay) || 1));
  const stageDisplay = Math.max(1, Math.round(Number(saved.stageDisplay) || 2));
  return {
    stationId,
    controller: String(saved.controller || 'http://127.0.0.1:3174'),
    managerWs: String(saved.managerWs || ''),
    playerDisplay,
    stageDisplay,
    wallPosition: Math.max(1, Math.min(10, Math.round(Number(saved.wallPosition) || (stationId === 11 ? 1 : stationId)))),
    cursorLockEnabled: saved.cursorLockEnabled === true || String(saved.cursorLockEnabled).toLowerCase() === 'true',
    startWithWindows: saved.startWithWindows === true,
    // Shared stage key; must match the controller's. Empty = connect without a key.
    stageKey: String(saved.stageKey || '').trim()
  };
}

function readCliConfig() {
  const config = {};
  for (const argument of process.argv.slice(2)) {
    const match = String(argument).match(/^--([^=]+)=(.*)$/);
    if (!match) continue;
    const key = match[1].replace(/-([a-z])/g, (_full, letter) => letter.toUpperCase());
    config[key] = match[2];
  }
  return config;
}

function loadConfig() {
  const userPath = clientConfigPath();
  const localPath = path.join(process.cwd(), 'stage-display-client.config.json');
  const saved = { ...(readJson(userPath) || readJson(localPath) || {}), ...readCliConfig() };
  const normalized = normalizeClientConfig(saved);
  fs.mkdirSync(path.dirname(userPath), { recursive: true });
  fs.writeFileSync(userPath, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

function saveConfig(nextConfig = {}) {
  const normalized = normalizeClientConfig({ ...config, ...nextConfig });
  const userPath = clientConfigPath();
  fs.mkdirSync(path.dirname(userPath), { recursive: true });
  fs.writeFileSync(userPath, JSON.stringify(normalized, null, 2), 'utf8');
  config = normalized;
  return config;
}

function orderedDisplays() {
  return screen.getAllDisplays().slice().sort((left, right) => {
    if (left.bounds.y !== right.bounds.y) return left.bounds.y - right.bounds.y;
    return left.bounds.x - right.bounds.x;
  });
}

function displayByIndex(index, fallbackIndex = 0) {
  const displays = orderedDisplays();
  return displays[Math.max(0, index - 1)] || displays[fallbackIndex] || displays[0] || screen.getPrimaryDisplay();
}

function playerDisplayCursorBounds() {
  const display = displayByIndex(config.playerDisplay, 0);
  const scale = Number(display.scaleFactor) || 1;
  const { x, y, width, height } = display.bounds;
  const inset = 2;
  return {
    left: Math.round(x * scale) + inset,
    top: Math.round(y * scale) + inset,
    right: Math.round((x + width) * scale) - inset,
    bottom: Math.round((y + height) * scale) - inset
  };
}

function clipCursor(rect = null) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  const code = rect
    ? `$code = @'
using System;
using System.Runtime.InteropServices;
public static class NativeMethods {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll", SetLastError=true)] public static extern bool ClipCursor(ref RECT rect);
}
'@
Add-Type $code
$rect = New-Object NativeMethods+RECT
$rect.Left = ${Math.round(rect.left)}
$rect.Top = ${Math.round(rect.top)}
$rect.Right = ${Math.round(rect.right)}
$rect.Bottom = ${Math.round(rect.bottom)}
[NativeMethods]::ClipCursor([ref]$rect) | Out-Null`
    : `$code = @'
using System;
using System.Runtime.InteropServices;
public static class NativeMethods {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool ClipCursor(IntPtr rect);
}
'@
Add-Type $code
[NativeMethods]::ClipCursor([IntPtr]::Zero) | Out-Null`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', code], { windowsHide: true }, (error) => {
      if (error) {
        lastError = error.message || String(error);
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

function stopCursorLockHelper() {
  if (cursorLockProcess) {
    try { cursorLockProcess.kill(); } catch {}
    cursorLockProcess = null;
  }
  cursorLockBoundsKey = '';
}

function startCursorLockHelper(rect) {
  if (process.platform !== 'win32') return false;
  const boundsKey = `${rect.left},${rect.top},${rect.right},${rect.bottom}`;
  if (cursorLockProcess && cursorLockBoundsKey === boundsKey) return true;
  stopCursorLockHelper();
  const code = `$code = @'
using System;
using System.Runtime.InteropServices;
public static class NativeMethods {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll", SetLastError=true)] public static extern bool ClipCursor(ref RECT rect);
}
'@
Add-Type $code
$rect = New-Object NativeMethods+RECT
$rect.Left = ${Math.round(rect.left)}
$rect.Top = ${Math.round(rect.top)}
$rect.Right = ${Math.round(rect.right)}
$rect.Bottom = ${Math.round(rect.bottom)}
while ($true) {
  [NativeMethods]::ClipCursor([ref]$rect) | Out-Null
  Start-Sleep -Milliseconds 200
}`;
  cursorLockProcess = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', code], {
    windowsHide: true,
    stdio: 'ignore'
  });
  cursorLockBoundsKey = boundsKey;
  cursorLockProcess.on('exit', () => {
    cursorLockProcess = null;
    cursorLockBoundsKey = '';
    if (config?.cursorLockEnabled && !app.isQuitting) setTimeout(() => setCursorLock(true), 250);
  });
  return true;
}

async function setCursorLock(enabled, { persist = false } = {}) {
  const nextEnabled = Boolean(enabled);
  if (persist) saveConfig({ cursorLockEnabled: nextEnabled });
  if (nextEnabled) {
    const bounds = playerDisplayCursorBounds();
    cursorLockActive = await clipCursor(bounds);
    if (cursorLockActive) startCursorLockHelper(bounds);
  } else {
    stopCursorLockHelper();
    await clipCursor(null);
    cursorLockActive = false;
  }
  updateTray();
  clientWindow?.webContents.send('stage-client:cursor-lock', {
    enabled: config.cursorLockEnabled,
    active: cursorLockActive
  });
  return { enabled: config.cursorLockEnabled, active: cursorLockActive };
}

function controllerWsUrl() {
  if (config.managerWs) return config.managerWs;
  const url = new URL(config.controller);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.port = '3178';
  url.pathname = '/stage';
  url.search = '';
  return url.toString();
}

function controllerHttpUrl(relativeUrl = '') {
  const base = new URL(config.controller);
  base.port = '3174';
  return new URL(relativeUrl, base).toString();
}

function reportUpdate(status = '', details = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: 'update',
    station: config.stationId,
    status,
    message: details.message || status,
    version: details.version || '',
    error: details.error || ''
  }));
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const client = url.startsWith('https:') ? https : http;
    const headers = config?.stageKey ? { 'X-Stage-Token': config.stageKey } : {};
    const request = client.get(url, { headers }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        downloadFile(new URL(response.headers.location, url).toString(), destination).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Update download failed: HTTP ${response.statusCode}`));
        response.resume();
        return;
      }
      const stream = fs.createWriteStream(destination);
      response.pipe(stream);
      stream.on('finish', () => stream.close(() => resolve(destination)));
      stream.on('error', reject);
    });
    request.on('error', reject);
  });
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function updateTargetExecutable() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function startupSettings() {
  const supported = process.platform === 'win32' && app.isPackaged;
  return {
    startupSupported: supported,
    startWithWindows: supported && app.getLoginItemSettings({ path: updateTargetExecutable(), args: [] }).executableWillLaunchAtLogin
  };
}

function setStartWithWindows(enabled) {
  if (!startupSettings().startupSupported) {
    if (enabled) throw new Error('Start with Windows is available in the packaged Windows client.');
    return false;
  }
  app.setLoginItemSettings({
    name: 'ISUStageDisplayClient',
    openAtLogin: Boolean(enabled),
    enabled: Boolean(enabled),
    path: updateTargetExecutable(),
    args: []
  });
  const actual = Boolean(startupSettings().startWithWindows);
  if (actual !== Boolean(enabled)) throw new Error('Windows did not apply the startup setting. Check Startup apps in Windows Settings.');
  return actual;
}

function writeUpdaterScript(downloadedFile, targetFile) {
  const scriptPath = path.join(app.getPath('userData'), 'stage-client-update', `apply-${Date.now()}.ps1`);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  const readyFile = `${scriptPath}.ready`;
  const script = createUpdaterScript({
    downloadedFile, targetFile, processId: process.pid,
    launcherId: process.env.PORTABLE_EXECUTABLE_FILE ? process.ppid : 0,
    readyFile, logFile: path.join(path.dirname(scriptPath), 'update.log')
  });
  fs.writeFileSync(scriptPath, script.trim(), 'utf8');
  return { scriptPath, readyFile };
}

async function installUpdate(update = {}) {
  if (updateInProgress) return;
  updateInProgress = true;
  try {
    const downloadUrl = controllerHttpUrl(update.downloadUrl || '/api/stage/client-update/download');
    const updateDir = path.join(app.getPath('userData'), 'stage-client-update');
    const downloadedFile = path.join(updateDir, update.fileName || 'ISU-Stage-Display-Client-Update.exe');
    reportUpdate('downloading', { version: update.version, message: `Downloading client ${update.version || ''}` });
    await downloadFile(downloadUrl, downloadedFile);
    if (update.sha256) {
      reportUpdate('verifying', { version: update.version, message: 'Verifying client update' });
      const hash = sha256File(downloadedFile);
      if (hash.toLowerCase() !== String(update.sha256).toLowerCase()) {
        throw new Error('Downloaded client update did not pass verification');
      }
    }
    const target = updateTargetExecutable();
    const { scriptPath, readyFile } = writeUpdaterScript(downloadedFile, target);
    const helper = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      cwd: path.dirname(scriptPath)
    });
    await new Promise((resolve, reject) => {
      const startedAt = Date.now();
      let timer;
      const fail = (error) => { clearInterval(timer); reject(error); };
      helper.once('error', fail);
      timer = setInterval(() => {
        if (fs.existsSync(readyFile)) {
          clearInterval(timer);
          resolve();
        } else if (helper.exitCode !== null || Date.now() - startedAt > 15000) {
          helper.kill();
          fail(new Error('Update helper did not start. Client remains open; check stage-client-update/update.log.'));
        }
      }, 100);
    });
    helper.unref();
    reportUpdate('relaunching', { version: update.version, message: 'Installing client update and relaunching' });
    app.quit();
  } catch (error) {
    updateInProgress = false;
    lastError = error?.message || String(error);
    reportUpdate('failed', { version: update.version, message: lastError, error: lastError });
  }
}

function createClientWindow() {
  const targetDisplay = displayByIndex(config.stageDisplay, 1);
  const bounds = targetDisplay.bounds;
  clientWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    title: `ISU Stage Display Client ${config.stationId}`,
    webPreferences: {
      preload: path.join(__dirname, 'stage-display-client-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  clientWindow.loadFile(path.join(__dirname, 'client', 'index.html'));
  clientWindow.on('closed', () => { clientWindow = null; });
}

function createTrayImage() {
  // Opaque orange tile with white pixel lettering, readable at tray sizes.
  const pixels = Buffer.alloc(32 * 32 * 4);
  const letters = ['11101110101', '01001000101', '01001110101', '01000010101', '11101110111'];
  for (let y = 0; y < 32; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      const glyph = letters[Math.floor((y - 11) / 2)]?.[Math.floor((x - 5) / 2)] === '1';
      const offset = (y * 32 + x) * 4;
      pixels[offset] = glyph ? 255 : 32;
      pixels[offset + 1] = glyph ? 255 : 121;
      pixels[offset + 2] = glyph ? 255 : 244;
      pixels[offset + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: 32, height: 32, scaleFactor: 1 });
}

function openClientSettings() {
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(760, area.width);
  const height = Math.min(820, area.height);
  const bounds = { x: area.x + Math.floor((area.width - width) / 2), y: area.y + Math.floor((area.height - height) / 2), width, height };
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.setBounds(bounds);
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    ...bounds,
    title: 'ISU Stage Display Client - Station Setup',
    backgroundColor: '#0b0b0c',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'stage-display-client-preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  const window = settingsWindow;
  window.once('ready-to-show', () => { window.show(); window.focus(); });
  window.on('closed', () => { settingsWindow = null; });
  window.loadFile(path.join(__dirname, 'client', 'index.html'), { query: { settings: '1' } });
}

ipcMain.on('stage-client:open-settings', openClientSettings);
ipcMain.on('stage-client:close-settings', (event) => {
  if (event.sender === settingsWindow?.webContents) settingsWindow.close();
});

function updateTray() {
  if (!tray) return;
  tray.setToolTip(`ISU Stage Display Client - Station ${config?.stationId || 1}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Station ${String(config?.stationId || 1).padStart(2, '0')}`, enabled: false },
    { label: `Mode: ${currentMode}`, enabled: false },
    { type: 'separator' },
    { label: 'Open Settings', click: openClientSettings },
    { label: 'Reconnect to Controller', click: restartConnection },
    {
      label: 'Start with Windows', type: 'checkbox',
      checked: Boolean(startupSettings().startWithWindows),
      enabled: startupSettings().startupSupported,
      click: (item) => {
        try { saveConfig({ startWithWindows: setStartWithWindows(item.checked) }); }
        catch (error) { dialog.showErrorBox('Windows startup setting', error.message); }
        updateTray();
        settingsWindow?.webContents.send('stage-client:config-changed');
      }
    },
    { type: 'separator' },
    {
      label: 'Lock Cursor to Player Display',
      type: 'checkbox',
      checked: Boolean(config?.cursorLockEnabled),
      click: (item) => setCursorLock(item.checked, { persist: true })
    },
    {
      label: 'Unlock Cursor Now',
      enabled: cursorLockActive,
      click: () => setCursorLock(false, { persist: true })
    },
    { type: 'separator' },
    { label: 'Blackout Stage Display', click: () => setMode('blackout', {}) },
    { label: 'Quit', click: () => app.quit() }
  ]));
}

function createTray() {
  tray = new Tray(createTrayImage());
  tray.on('double-click', openClientSettings);
  updateTray();
}

function sendStatus(type = 'status') {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type,
    station: config.stationId,
    mode: currentMode,
    ready: true,
    preset: currentPreset,
    error: lastError
  }));
}

function registerClient() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  console.log(`[stage-client] registering station ${config.stationId} at wall position ${config.wallPosition}`);
  socket.send(JSON.stringify({
    type: 'register',
    station: config.stationId,
    token: config.stageKey || '',
    hostname: os.hostname(),
    clientVersion: CLIENT_VERSION,
    wallPosition: Math.max(1, Math.round(Number(config.wallPosition) || config.stationId)),
    mode: currentMode,
    ready: true
  }));
}

async function sendPreview() {
  if (!clientWindow || clientWindow.isDestroyed() || !socket || socket.readyState !== WebSocket.OPEN) return;
  try {
    const image = await clientWindow.webContents.capturePage();
    if (image.isEmpty()) return;
    const thumbnail = image.resize({ width: 320, height: 180, quality: 'good' });
    socket.send(JSON.stringify({
      type: 'preview',
      station: config.stationId,
      mode: currentMode,
      preset: currentPreset,
      preview: `data:image/jpeg;base64,${thumbnail.toJPEG(58).toString('base64')}`
    }));
  } catch (error) {
    lastError = error?.message || String(error);
  }
}

function connectManager() {
  clearTimeout(reconnectTimer);
  if (socket) {
    try { socket.close(); } catch {}
  }
  const wsUrl = controllerWsUrl();
  console.log(`[stage-client] connecting station ${config.stationId} to ${wsUrl}`);
  socket = new WebSocket(wsUrl);
  socket.on('open', () => {
    lastError = '';
    console.log(`[stage-client] connected station ${config.stationId}`);
    registerClient();
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => sendStatus('heartbeat'), 2000);
    clearInterval(previewTimer);
    previewTimer = setInterval(sendPreview, 1500);
    setTimeout(sendPreview, 500);
    clockSync.reset();
    clearInterval(timeSyncTimer);
    // Burst a few pings right away for a quick estimate, then keep it fresh.
    for (const delay of [50, 250, 500, 1000]) setTimeout(sendTimeSync, delay);
    timeSyncTimer = setInterval(sendTimeSync, 15000);
  });
  socket.on('message', (data) => {
    let message = null;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message.command === 'time_sync') {
      clockSync.addSample(message.clientSentAt, message.serverAt, Date.now());
      return;
    }
    if (message.command === 'set_mode') {
      setMode(message.mode, message);
      return;
    }
    if (message.command === 'prepare_preset') {
      preparePreset(message);
      return;
    }
    if (message.command === 'play_preset') {
      setMode(message.mode || 'graphic', message);
      return;
    }
    if (message.command === 'install_update') {
      installUpdate(message.update || {});
    }
  });
  const thisSocket = socket;
  socket.on('close', (code, reason) => {
    // Ignore close events from sockets we already replaced, or they'd tear down the live connection.
    if (socket !== thisSocket) return;
    const text = reason?.toString() || '';
    if (code === 1008 || code === 4009) {
      // Rejected (wrong stage key or station number already taken): show why instead of silently retrying.
      lastError = text || (code === 4009 ? 'Station number already in use' : 'Connection rejected');
      console.error(`[stage-client] station ${config.stationId} rejected: ${lastError}`);
      clientWindow?.webContents.send('stage-client:mode', { mode: 'hold', stationId: config.stationId, error: lastError });
    }
    scheduleReconnect(code === 1008 || code === 4009 ? 10000 : 2500);
  });
  socket.on('error', (error) => {
    lastError = error?.message || String(error);
    console.error(`[stage-client] connection error station ${config.stationId}: ${lastError}`);
  });
}

function restartConnection() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  clearInterval(timeSyncTimer);
  timeSyncTimer = null;
  clearInterval(previewTimer);
  previewTimer = null;
  clearTimeout(reconnectTimer);
  if (socket) {
    try { socket.close(); } catch {}
    socket = null;
  }
  connectManager();
}

function scheduleReconnect(delayMs = 2500) {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  clearInterval(previewTimer);
  previewTimer = null;
  clearInterval(timeSyncTimer);
  timeSyncTimer = null;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectManager, Number(delayMs) || 2500);
}

function sendTimeSync() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: 'time_sync',
    station: config.stationId,
    clientSentAt: Date.now(),
    offsetMs: clockSync.ready ? Math.round(clockSync.offsetMs) : null,
    rttMs: clockSync.rttMs
  }));
}

// executeAt from the controller is on the controller's clock; the renderer schedules on ours.
function localExecuteAt(executeAt) {
  const local = clockSync.toLocalSeconds(executeAt);
  return local === null ? null : local;
}

function setMode(mode = 'hold', details = {}) {
  const allowed = new Set(['gameplay', 'wall', 'graphic', 'individual', 'blackout', 'hold']);
  const nextMode = allowed.has(String(mode)) ? String(mode) : 'hold';
  currentMode = nextMode;
  currentPreset = details.preset || '';
  clientWindow?.webContents.send('stage-client:mode', {
    mode: nextMode,
    playId: details.playId || '',
    preset: details.preset || '',
    assetPath: details.assetPath || '',
    executeAt: localExecuteAt(details.executeAt),
    wallPosition: Math.max(1, Math.round(Number(details.wallPosition) || config.wallPosition)),
    wallTotal: Number(details.wallTotal) || 10,
    stationId: config.stationId
  });
  sendStatus();
  updateTray();
}

function preparePreset(details = {}) {
  const allowed = new Set(['wall', 'graphic', 'individual']);
  const mode = allowed.has(String(details.mode)) ? String(details.mode) : 'graphic';
  clientWindow?.webContents.send('stage-client:prepare', {
    mode,
    playId: details.playId || '',
    preset: details.preset || '',
    assetPath: details.assetPath || '',
    wallPosition: Math.max(1, Math.round(Number(details.wallPosition) || config.wallPosition)),
    wallTotal: Number(details.wallTotal) || 10,
    stationId: config.stationId
  });
}

async function screenSourceForPlayerDisplay() {
  const displays = orderedDisplays();
  const targetDisplay = displayByIndex(config.playerDisplay, 0);
  const targetDisplayId = String(targetDisplay.id);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 }
  });
  const matched = sources.find((source) => String(source.display_id) === targetDisplayId)
    || sources[Math.max(0, Math.min(sources.length - 1, config.playerDisplay - 1))]
    || sources[0];
  return matched ? {
    id: matched.id,
    name: matched.name,
    displayId: matched.display_id,
    displayCount: displays.length
  } : null;
}

ipcMain.handle('stage-client:get-config', () => ({
  ...config,
  ...startupSettings(),
  clientVersion: CLIENT_VERSION,
  hostname: os.hostname(),
  cursorLockActive,
  displays: orderedDisplays().map((display, index) => ({
    index: index + 1,
    id: String(display.id),
    width: display.bounds.width,
    height: display.bounds.height,
    x: display.bounds.x,
    y: display.bounds.y,
    primary: display.id === screen.getPrimaryDisplay().id
  }))
}));

ipcMain.handle('stage-client:get-player-source', () => screenSourceForPlayerDisplay());

ipcMain.handle('stage-client:save-config', (_event, details = {}) => {
  const previousStageDisplay = Number(config.stageDisplay);
  const previousCursorLock = Boolean(config.cursorLockEnabled);
  if (typeof details.startWithWindows === 'boolean') setStartWithWindows(details.startWithWindows);
  const saved = saveConfig(details);
  if (Number(saved.stageDisplay) !== previousStageDisplay && clientWindow && !clientWindow.isDestroyed()) {
    const targetDisplay = displayByIndex(saved.stageDisplay, 1);
    clientWindow.setBounds(targetDisplay.bounds);
    clientWindow.setFullScreen(true);
  }
  if (Boolean(saved.cursorLockEnabled) !== previousCursorLock || cursorLockActive) {
    setCursorLock(saved.cursorLockEnabled);
  }
  restartConnection();
  updateTray();
  clientWindow?.webContents.send('stage-client:config-changed');
  return {
    ...saved,
    ...startupSettings(),
    clientVersion: CLIENT_VERSION,
    hostname: os.hostname(),
    cursorLockActive,
    displays: orderedDisplays().map((display, index) => ({
      index: index + 1,
      id: String(display.id),
      width: display.bounds.width,
      height: display.bounds.height,
      x: display.bounds.x,
      y: display.bounds.y,
      primary: display.id === screen.getPrimaryDisplay().id
    }))
  };
});

ipcMain.handle('stage-client:set-cursor-lock', (_event, details = {}) => setCursorLock(details.enabled, { persist: true }));

ipcMain.on('stage-client:renderer-status', (_event, status = {}) => {
  if (status.type === 'prepared') {
    lastError = status.error || '';
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      type: 'prepared',
      station: config.stationId,
      mode: currentMode,
      playId: status.playId || '',
      preset: status.preset || '',
      ready: !lastError,
      error: lastError
    }));
    return;
  }
  currentMode = status.mode || currentMode;
  currentPreset = status.preset || currentPreset;
  lastError = status.error || '';
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: status.ready === false ? 'status' : 'ready',
    station: config.stationId,
    mode: currentMode,
    ready: status.ready !== false,
    preset: status.preset || '',
    error: lastError
  }));
});

app.setAppUserModelId('edu.isu.esports.stagedisplayclient');

app.whenReady().then(() => {
  config = loadConfig();
  console.log(`[stage-client] config station ${config.stationId}, controller ${config.controller}, display ${config.stageDisplay}, userData ${app.getPath('userData')}`);
  createClientWindow();
  createTray();
  globalShortcut.register('Control+Alt+L', () => setCursorLock(!config.cursorLockEnabled, { persist: true }));
  if (config.cursorLockEnabled) setCursorLock(true);
  screen.on('display-metrics-changed', () => {
    if (config?.cursorLockEnabled) setCursorLock(true);
  });
  screen.on('display-added', () => {
    if (config?.cursorLockEnabled) setCursorLock(true);
  });
  screen.on('display-removed', () => {
    if (config?.cursorLockEnabled) setCursorLock(true);
  });
  connectManager();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  clearInterval(previewTimer);
  globalShortcut.unregisterAll();
  stopCursorLockHelper();
  clipCursor(null);
  if (socket) socket.close();
});
