const { app, BrowserWindow, desktopCapturer, ipcMain, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { UniversalGameBridge } = require('./game-bridge.cjs');
const { ValorantWindowCapture } = require('./valorant-capture.cjs');
const { HybridValorantWindowCapture, NativeValorantWindowCapture } = require('./valorant-native-capture.cjs');
const { TesseractOcrEngine } = require('./valorant-ocr-engine.cjs');

const appDataPath = app.getPath('appData');
app.setName('ISU Esports Game Bridge');
app.setPath('userData', path.join(appDataPath, 'ISU Esports Game Bridge'));
app.setAppUserModelId('edu.isu.esports.gamebridge');

let mainWindow;
let forwarder;

function configPath() {
  return path.join(app.getPath('userData'), 'bridge-config.json');
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}

function readConfigWithLegacyFallback() {
  const current = readConfig();
  if (Object.keys(current).length) return current;
  try {
    return { game: 'rocketleague', ...JSON.parse(fs.readFileSync(path.join(appDataPath, 'ISU Rocket League Bridge', 'bridge-config.json'), 'utf8')) };
  } catch {}
  return {};
}

function saveConfig(config) {
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 900,
    minWidth: 760,
    minHeight: 700,
    backgroundColor: '#0b0b0c',
    title: 'ISU Esports Game Bridge',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'bridge-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'bridge', 'index.html'));
}

app.whenReady().then(() => {
  forwarder = new UniversalGameBridge({
    capture: new HybridValorantWindowCapture({
      nativeCapture: new NativeValorantWindowCapture({ nativeImage }),
      fallbackCapture: new ValorantWindowCapture({ desktopCapturer, nativeImage })
    }),
    ocr: new TesseractOcrEngine(),
    onStatus: (status) => mainWindow?.webContents.send('bridge:status', status),
    onOcrState: (state) => mainWindow?.webContents.send('bridge:ocr-state', state)
  });
  ipcMain.handle('bridge:get-config', () => readConfigWithLegacyFallback());
  ipcMain.handle('bridge:get-status', () => forwarder.getStatus());
  ipcMain.handle('bridge:start', (_event, config) => {
    saveConfig(config);
    return forwarder.start(config);
  });
  ipcMain.handle('bridge:stop', () => {
    forwarder.stop();
    return forwarder.getStatus();
  });
  ipcMain.handle('bridge:list-windows', () => forwarder.listWindows());
  ipcMain.handle('bridge:capture-snapshot', () => forwarder.captureSnapshot());
  ipcMain.handle('bridge:clear-ocr', () => forwarder.clearOcrState());
  ipcMain.handle('bridge:start-simulator', (_event, config) => {
    if (config) {
      saveConfig(config);
      forwarder.start(config);
    }
    return forwarder.startSimulator();
  });
  ipcMain.handle('bridge:stop-simulator', () => forwarder.stopSimulator());
  createWindow();
});

app.on('second-instance', () => {
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.focus();
});

app.on('window-all-closed', () => {
  forwarder?.shutdown();
  app.quit();
});
