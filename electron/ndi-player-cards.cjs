'use strict';
// NDI player cards: the controller renders one 1920x1080 card per stage station
// (public/overlays/player-card.html?station=N) in a hidden offscreen window and publishes
// every painted frame as an NDI source "ISU Player Card NN". Display clients (or any NDI
// receiver in the arena) pick up their station's source with no page load.
//
// NDI comes from the optional native addon @stagetimerio/grandiose (bundles the NDI 6
// runtime). If it is not installed / not built for this Electron, the service reports that
// and everything else keeps working.

function loadNdi() {
  try { return { ndi: require('@stagetimerio/grandiose'), error: '' }; }
  catch (error) { return { ndi: null, error: `NDI runtime not available (${error.code || error.message}). Run "npm run ndi:install" on this PC.` }; }
}

const WIDTH = 1920;
const HEIGHT = 1080;

class NdiPlayerCards {
  constructor({ BrowserWindow, baseUrl, fps = 30, loadNdiImpl = loadNdi, log = () => {} } = {}) {
    Object.assign(this, { BrowserWindow, baseUrl, fps, loadNdiImpl, log });
    this.outputs = new Map(); // station -> { window, sender, frames, lastFrameAt, error }
    this.state = { enabled: false, stations: [], error: '', ndiVersion: '' };
  }

  status() {
    return {
      ...this.state,
      outputs: [...this.outputs.entries()].map(([station, o]) => ({
        station, source: o.sourceName || '', frames: o.frames, connections: safe(() => o.sender?.connections?.(), 0), error: o.error || ''
      }))
    };
  }

  // stations: array of station numbers (1-10) to publish. Empty / enabled=false stops all.
  async configure({ enabled = false, stations = [] } = {}) {
    const wanted = new Set(enabled ? stations.map((s) => Math.round(Number(s))).filter((s) => s >= 1 && s <= 10) : []);
    for (const station of [...this.outputs.keys()]) if (!wanted.has(station)) await this.stopStation(station);
    this.state = { ...this.state, enabled: Boolean(enabled), stations: [...wanted].sort((a, b) => a - b), error: '' };
    if (!wanted.size) return this.status();
    const { ndi, error } = this.loadNdiImpl();
    if (!ndi) { this.state.error = error; return this.status(); }
    this.ndi = ndi;
    this.state.ndiVersion = safe(() => ndi.version(), '');
    for (const station of wanted) if (!this.outputs.has(station)) await this.startStation(station);
    return this.status();
  }

  async startStation(station) {
    const output = { frames: 0, lastFrameAt: 0, error: '', busy: false };
    this.outputs.set(station, output);
    try {
      output.sender = await this.ndi.send({ name: `ISU Player Card ${String(station).padStart(2, '0')}`, clockVideo: false, clockAudio: false });
      output.sourceName = safe(() => output.sender.sourcename(), '');
      const win = new this.BrowserWindow({
        show: false, width: WIDTH, height: HEIGHT, frame: false, useContentSize: true,
        webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true }
      });
      output.window = win;
      win.webContents.setFrameRate(this.fps);
      win.webContents.on('paint', (_event, _dirty, image) => { output.lastImage = image; this.publish(station, image); });
      // A static card only repaints when it changes; repeat the last frame so a station that
      // connects later (or reconnects) gets a picture within ~0.5 s.
      output.keepAlive = setInterval(() => { if (output.lastImage && Date.now() - output.lastFrameAt > 450) this.publish(station, output.lastImage); }, 500);
      output.keepAlive.unref?.();
      await win.loadURL(`${this.baseUrl}/overlays/player-card.html?station=${station}`);
      win.webContents.invalidate();
      this.log(`[ndi] station ${station} -> ${output.sourceName}`);
    } catch (error) {
      output.error = error.message || String(error);
      this.log(`[ndi] station ${station} failed: ${output.error}`);
    }
  }

  // Offscreen paint gives BGRA at the window size. Frames arriving while the previous send is
  // still in flight are dropped (latest frame wins), so NDI can never back up memory.
  async publish(station, image) {
    const output = this.outputs.get(station);
    if (!output?.sender || output.busy) return;
    const size = image.getSize();
    if (size.width !== WIDTH || size.height !== HEIGHT) return;
    output.busy = true;
    try {
      await output.sender.video({
        xres: WIDTH, yres: HEIGHT, frameRateN: this.fps * 1000, frameRateD: 1000,
        fourCC: this.ndi.FOURCC_BGRA, pictureAspectRatio: WIDTH / HEIGHT,
        frameFormatType: this.ndi.FORMAT_TYPE_PROGRESSIVE, lineStrideBytes: WIDTH * 4,
        data: image.toBitmap()
      });
      output.frames += 1;
      output.lastFrameAt = Date.now();
      output.error = '';
    } catch (error) {
      output.error = error.message || String(error);
    } finally { output.busy = false; }
  }

  async stopStation(station) {
    const output = this.outputs.get(station);
    this.outputs.delete(station);
    if (!output) return;
    clearInterval(output.keepAlive);
    try { if (output.window && !output.window.isDestroyed()) output.window.destroy(); } catch {}
    try { await output.sender?.destroy?.(); } catch {}
  }

  async shutdown() { for (const station of [...this.outputs.keys()]) await this.stopStation(station); }
}

function safe(fn, fallback) { try { return fn(); } catch { return fallback; } }

module.exports = { NdiPlayerCards, loadNdi, WIDTH, HEIGHT };
