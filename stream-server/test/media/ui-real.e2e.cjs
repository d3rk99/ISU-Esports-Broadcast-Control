'use strict';
// Real-engine Electron check: launches the app's real UI with an isolated profile, sets a short
// delay + a local RTMP receiver through the form, waits for READY, presses START ALL in the UI,
// and verifies the receiver got decodable H.264/AAC. Screenshot written to argv[2].
const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const root = path.join(__dirname, '..', '..');
const { ConfigStore, ElectronCredentialStore, defaults } = require(path.join(root, 'core/config.cjs'));
const { Logger } = require(path.join(root, 'core/logger.cjs'));
const { StreamService } = require(path.join(root, 'core/service.cjs'));
const { startReceiver } = require('./receiver.cjs');
const shot = process.argv.filter((a) => a.endsWith('.png'))[0] || '/tmp/stream-ui-real.png';

class PlainCreds { seal(s) { return s ? Buffer.from(s).toString('base64') : ''; } open(s) { return s ? Buffer.from(s, 'base64').toString() : ''; } }

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isu-ui-real-'));
  const rx = await startReceiver(path.join(dir, 'rx.ts'));
  const store = new ConfigStore(dir, safeStorage.isEncryptionAvailable() ? new ElectronCredentialStore(safeStorage) : new PlainCreds());
  const cfg = defaults();
  cfg.encoder = { ...cfg.encoder, resolution: '1280x720', videoBitrate: 3000, audioBitrate: 128 };
  store.save(cfg);
  const service = new StreamService(store, new Logger(path.join(dir, 'logs')), { dataDir: dir });
  await service.initialize();
  const win = new BrowserWindow({ width: 1400, height: 1100, show: false, webPreferences: { preload: path.join(root, 'preload.cjs'), contextIsolation: true, sandbox: true, offscreen: true } });
  ipcMain.handle('stream:view', () => service.view());
  ipcMain.handle('stream:command', async (_e, action, payload) => { try { return { ok: true, view: await service.command(action, payload) }; } catch (error) { return { ok: false, error: error.message }; } });
  service.on('status', (s) => { if (!win.isDestroyed()) win.webContents.send('stream:status', s); });
  await win.loadFile(path.join(root, 'ui/index.html'));
  const js = (code) => win.webContents.executeJavaScript(code);
  await new Promise((r) => setTimeout(r, 800));
  // Fill the form like an operator: 5 s delay, one destination pointing at the local receiver.
  await js(`(() => {
    const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(document.querySelector('#delaySeconds'), '5');
    const rows = [...document.querySelectorAll('#destinations article')];
    rows.slice(1).forEach((r) => r.remove());
    set(rows[0].querySelector('[data-field=name]'), 'Local test receiver');
    rows[0].querySelector('[data-field=protocol]').value = 'RTMP';
    set(rows[0].querySelector('[data-field=serverUrl]'), ${JSON.stringify(rx.url)});
    set(rows[0].querySelector('[data-field=streamKey]'), 'test-key');
    document.querySelector('#settings').requestSubmit();
  })()`);
  const lockedEarly = await js(`new Promise((r) => setTimeout(() => r(document.querySelector('#startAll').disabled), 1500))`);
  const t0 = Date.now();
  while (!service.status().buffer.ready && Date.now() - t0 < 40000) await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => setTimeout(r, 600));
  const unlocked = !(await js(`document.querySelector('#startAll').disabled`));
  await js(`document.querySelector('#startAll').click()`);
  await new Promise((r) => setTimeout(r, 9000));
  win.setSize(1400, 1100);
  fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
  const status = service.status();
  const keyInConfig = fs.readFileSync(store.file, 'utf8').includes('test-key');
  const keyInView = JSON.stringify(service.view()).includes('test-key');
  await service.close();
  await rx.stop();
  let streams = [];
  try { streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', rx.file]).toString()).streams.map((s) => `${s.codec_type}:${s.codec_name}`); } catch {}
  const result = { lockedEarly, unlocked, outputState: status.outputs[0]?.state, sentBytes: status.outputs[0]?.sentBytes, streams, keyInConfig, keyInView, error: status.error };
  console.log(JSON.stringify(result));
  const pass = lockedEarly && unlocked && streams.includes('video:h264') && streams.includes('audio:aac') && !keyInView && !keyInConfig;
  console.log(pass ? 'UI REAL PASS' : 'UI REAL FAIL');
  fs.rmSync(dir, { recursive: true, force: true });
  app.exit(pass ? 0 : 1);
}).catch((e) => { console.error(e); app.exit(1); });
