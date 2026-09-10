const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { RocketLeagueForwarder } = require('./rocket-league-bridge.cjs');

app.setName('ISU Rocket League Bridge');
app.setPath('userData', path.join(app.getPath('appData'), 'ISU Rocket League Bridge'));
app.setAppUserModelId('edu.isu.esports.rocketleaguebridge');

let mainWindow;
let forwarder;

function configPath() {
  return path.join(app.getPath('userData'), 'bridge-config.json');
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}

function saveConfig(config) {
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 700,
    height: 650,
    minWidth: 620,
    minHeight: 560,
    backgroundColor: '#0b0b0c',
    title: 'ISU Rocket League Bridge',
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
  forwarder = new RocketLeagueForwarder({ onStatus: (status) => mainWindow?.webContents.send('bridge:status', status) });
  ipcMain.handle('bridge:get-config', () => readConfig());
  ipcMain.handle('bridge:start', (_event, config) => {
    saveConfig(config);
    forwarder.start(config);
    return true;
  });
  ipcMain.handle('bridge:stop', () => {
    forwarder.stop();
    return true;
  });
  createWindow();
});

app.on('second-instance', () => {
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.focus();
});

app.on('window-all-closed', () => {
  forwarder?.stop();
  app.quit();
});
