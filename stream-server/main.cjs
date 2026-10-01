const { app, BrowserWindow, ipcMain, safeStorage, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { ConfigStore, ElectronCredentialStore } = require('./core/config.cjs');
const { Logger } = require('./core/logger.cjs');
const { StreamService } = require('./core/service.cjs');
const smoke = process.argv.includes('--smoke');
app.setName('ISU Stream Server');
app.setPath('userData', smoke ? fs.mkdtempSync(path.join(os.tmpdir(), 'isu-stream-smoke-')) : path.join(app.getPath('appData'), 'ISU Stream Server'));
let service, timer, window, closing = false;
// Serialize commands and ticks so future async adapters cannot race UI/API commands.
let queue = Promise.resolve();
function enqueue(fn) { const result = queue.then(fn); queue = result.catch(() => {}); return result; }
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.restore(); window?.focus(); });
  app.whenReady().then(async () => {
    const logger = new Logger(path.join(app.getPath('userData'), 'logs'));
    const store = new ConfigStore(app.getPath('userData'), new ElectronCredentialStore(safeStorage));
    if (smoke) store.save({ ...require('./core/config.cjs').defaults(), engine: process.env.SMOKE_ENGINE || 'simulation' });
    service = new StreamService(store, logger, { dataDir: app.getPath('userData') });
    logger.write('application.startup', { state: service.simulation ? 'SIMULATION' : 'REAL' });
    await service.initialize();
    window = new BrowserWindow({ width: 1400, height: 980, minWidth: 1000, minHeight: 720, show: !smoke, title: 'ISU Stream Server', backgroundColor: '#101317', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    window.setMenuBarVisibility(false);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    ipcMain.handle('stream:view', event => { authorize(event); return service.view(); });
    // Real-mode startup errors are shown in the UI, never silently replaced by simulation.
    ipcMain.handle('stream:command', (event, action, payload) => {
      authorize(event);
      return enqueue(async () => {
        try { return { ok: true, view: await service.command(action, payload) }; }
        catch (error) { logger.write('command.error', { code: 'COMMAND_FAILED' }); return { ok: false, error: error.message }; }
      });
    });
    function authorize(event) { if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted IPC sender'); }
    service.on('status', state => { if (!window.isDestroyed()) window.webContents.send('stream:status', state); });
    await window.loadFile(path.join(__dirname, 'ui/index.html'));
    let last = performance.now();
    timer = setInterval(() => { const now = performance.now(); const seconds = Math.min(2, (now - last) / 1000); last = now; enqueue(() => service.tick(seconds)).catch(() => logger.write('application.error', { code: 'TICK_FAILED' })); }, 250);
    if (smoke) {
      await window.webContents.executeJavaScript(`(async () => {
        const wait = () => new Promise(r => setTimeout(r, 50));
        for (let i = 0; i < 100 && !document.querySelector('#destinations article'); i++) await wait();
        if (document.querySelectorAll('#destinations article').length !== 3) throw new Error('Destination UI missing');
        if (!document.querySelector('#startAll').disabled) throw new Error('Interlock UI missing');
        const blocked = await window.stream.command('startAll');
        if (blocked.ok) throw new Error('Interlock bypass');
        const delayInput = document.querySelector('#delaySeconds');
        delayInput.value = '0'; delayInput.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#settings').requestSubmit();
        for (let i = 0; i < 100 && (await window.stream.view()).config.delaySeconds !== 0; i++) await wait();
        if ((await window.stream.view()).config.delaySeconds !== 0) throw new Error('Settings UI save failed');
        if (!(await window.stream.command('startAll')).ok) throw new Error('Start failed');
        await new Promise(r => setTimeout(r, 1400));
        if (!(await window.stream.view()).status.outputs.every(o => o.state === 'CONNECTED')) throw new Error('Connections failed');
        await window.stream.command('stopAll');
        if (!(await window.stream.view()).status.outputs.every(o => o.state === 'STOPPED')) throw new Error('Stop failed');
        delayInput.value = '300'; delayInput.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#settings').requestSubmit();
        for (let i = 0; i < 100 && (await window.stream.view()).config.delaySeconds !== 300; i++) await wait();
        await wait();
        if (!document.querySelector('#startAll').disabled || !document.querySelector('#delayTime').textContent.includes('05:00')) throw new Error('Saved delay UI mismatch');
      })()`);
      // Hidden Chromium windows may retain an old compositor frame.
      window.showInactive();
      await new Promise(resolve => setTimeout(resolve, 300));
      const imagePath = path.join(app.getPath('userData'), 'smoke.png');
      fs.writeFileSync(imagePath, (await window.webContents.capturePage()).toPNG());
      console.log('Stream Server Electron smoke passed; screenshot:', imagePath); app.quit();
    }
  }).catch(error => { console.error('Stream Server startup failed:', error.message); if (!smoke) dialog.showErrorBox('ISU Stream Server', 'Startup failed. Configuration was preserved. Inspect the Stream Server configuration and logs in AppData.'); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (!service || closing) return;
    event.preventDefault(); closing = true; clearInterval(timer);
    enqueue(() => service.close()).finally(() => app.quit());
  });
}
