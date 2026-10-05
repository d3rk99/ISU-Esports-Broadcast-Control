'use strict';
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { SimStreamService } = require('./sim-service.cjs');
const { RealEngine } = require('./media/engine.cjs');
const { findFfmpeg } = require('./media/ffmpeg.cjs');
const { listDevices, listModes } = require('./media/devices.cjs');
const { listObsDevices, findCaptureExe } = require('./media/obs-capture.cjs');
const { HealthTracker } = require('./health.cjs');

// Transport-independent command facade used by the UI and the local API. The engine is chosen
// explicitly by config.engine; a real-mode failure is reported, never swapped for simulation.
class StreamService extends EventEmitter {
  constructor(store, logger, { dataDir = '', findFfmpegFn = findFfmpeg, listDevicesFn = listDevices, listModesFn = listModes } = {}) {
    super();
    this.store = store;
    this.logger = logger;
    this.dataDir = dataDir;
    this.findFfmpeg = findFfmpegFn;
    this.listDevicesFn = listDevicesFn;
    this.listModesFn = listModesFn;
    this.config = store.load();
    this.sim = null;
    this.engine = null;
    this.ffmpeg = null;
    this.startupError = '';
    this.health = new HealthTracker();
  }

  get simulation() { return this.config.engine === 'simulation'; }
  storageDir() { return this.config.storageDir || path.join(this.dataDir, 'delay-buffer'); }
  recordingDir() { return this.config.recording?.directory || path.join(require('node:os').homedir(), 'Videos', 'ISU Stream Server'); }

  async initialize() {
    if (this.simulation) return this.initSim();
    try {
      this.ffmpeg = await this.findFfmpeg(this.config.ffmpegPath);
      this.logger.write('dependency.ffmpeg', { state: 'FOUND', code: this.ffmpeg.nvencUsable ? 'NVENC' : 'NO_NVENC' });
    } catch (error) {
      this.startupError = error.message;
      this.logger.write('dependency.ffmpeg', { state: 'MISSING', code: error.code || 'FFMPEG' });
      this.emit('status', this.status());
      return;
    }
    // List capture devices before the program grabs one (an open device can't list its modes).
    try { await this.scanDevices(); this.logger.write('device.discovery', { count: this.captureDevices.video.length }); }
    catch { this.captureDevices = { backend: '', video: [], audio: [], error: 'Device scan failed' }; }
    this.engine = new RealEngine({ ffmpeg: this.ffmpeg, storageDir: this.storageDir(), credentials: this.store.credentials, logger: this.logger });
    this.engine.on('status', () => this.emit('status', this.status()));
    // Preview frames/meters go out as their own events: big JPEGs never ride the status object.
    this.engine.on('preview', (jpeg) => this.emit('preview', jpeg));
    this.engine.on('meter', (meter) => this.emit('meter', meter));
    await this.engine.init();
    this.engine.showSecrets = Boolean(this.config.troubleshooting);
    this.engine.configureDestinations(this.config.destinations);
    // The program (capture + encode + buffering) starts with the app; outputs never auto-start.
    try { await this.engine.startProgram(this.config); }
    catch (error) { this.startupError = error.message; }
    this.emit('status', this.status());
  }

  async initSim() {
    this.sim = new SimStreamService(this.store, this.logger);
    this.sim.config = this.config;
    this.sim.outputs.configure(this.config.destinations);
    this.sim.on('status', (s) => this.emit('status', s));
    await this.sim.initialize();
  }

  tick(seconds) { if (this.sim) this.sim.tick(seconds); else this.emit('status', this.status()); }

  status() {
    if (this.sim) return this.sim.status();
    const snap = this.engine?.snapshot();
    const defs = this.config.destinations;
    if (!snap) {
      return { simulation: false, engine: 'ERROR', error: this.startupError, input: { connected: false }, encoder: 'UNAVAILABLE', buffer: { ready: false, filledSeconds: 0, configuredSeconds: this.config.delaySeconds, effectiveDelaySeconds: 0 }, outputsLocked: true, outputs: defs.map((d) => ({ id: d.id, state: d.enabled ? 'STOPPED' : 'DISABLED', reconnectCount: 0 })), uptime: 0, telemetry: { currentBitrateKbps: 0, droppedFrames: 0, encodedFrames: 0, avSyncWarning: false }, ffmpeg: null };
    }
    const ready = this.engine.ready();
    const enc = snap.encoder;
    return {
      simulation: false,
      engine: snap.engine,
      error: snap.error || this.startupError,
      input: { connected: enc.running && enc.frames > 0, type: this.config.input.type, resolution: this.config.encoder.resolution, fps: enc.fps },
      encoder: enc.running ? 'ENCODING' : snap.engine === 'ERROR' ? 'ERROR' : 'STOPPED',
      codec: enc.codec,
      buffer: { ready: snap.delay.ready, filledSeconds: snap.delay.filledSeconds, configuredSeconds: snap.delay.configuredSeconds, effectiveDelaySeconds: snap.delay.ready ? snap.delay.configuredSeconds : 0, bytes: snap.delay.bytes, hasAudio: snap.delay.hasAudio, hasVideo: snap.delay.hasVideo, failure: snap.delay.failure, lastReleaseAgeMs: snap.lastReleaseAgeMs, storageDir: this.storageDir() },
      outputsLocked: !ready,
      encoderInstance: snap.encoderInstance,
      outputs: defs.map((d) => {
        const o = snap.outputs.find((x) => x.id === d.id) || {};
        const out = { id: d.id, name: d.name, state: d.enabled ? (o.state || 'STOPPED') : 'DISABLED', reconnectCount: o.reconnectCount || 0, sentBytes: o.sentBytes || 0, droppedChunks: o.droppedChunks || 0, queueBytes: o.queueBytes || 0, error: o.error || '' };
        return { ...out, ...this.health.output(out) };
      }),
      recording: { ...snap.recording, directory: this.recordingDir() },
      preview: snap.preview,
      uptime: enc.uptimeSeconds,
      telemetry: { currentBitrateKbps: enc.bitrateKbps, droppedFrames: enc.dropped, encodedFrames: enc.frames, fps: enc.fps, speed: enc.speed, avSyncWarning: Boolean(snap.delay.hasVideo && !snap.delay.hasAudio) },
      ffmpeg: this.ffmpeg && { version: this.ffmpeg.version, nvenc: this.ffmpeg.nvencUsable, x264: this.ffmpeg.libx264, decklink: this.ffmpeg.decklink, rtmps: this.ffmpeg.rtmps }
    };
  }

  // status() plus program health. Kept separate so the health clock only advances on real polls.
  fullStatus() {
    const s = this.status();
    if (s.simulation) return { ...s, programHealth: { healthy: !s.outputsLocked, problems: s.outputsLocked ? ['BUFFERING'] : [] } };
    return { ...s, programHealth: this.health.program(s, Number(this.config.encoder.fps) || 0) };
  }

  view() { return { config: this.store.publicConfig(this.config), devices: this.devices(), status: this.fullStatus(), api: this.apiState?.() || { listening: false } }; }

  devices() {
    if (this.sim) return this.sim.devices;
    return { video: ['Test pattern (clock + tone)', 'Media file', 'DeckLink SDI', 'Video capture device'], audio: ['Embedded / file audio'], decklink: Boolean(this.ffmpeg?.decklink), capture: this.captureDevices || null };
  }

  // Webcams / capture cards / virtual cameras. Read-only listing; never interrupts the program.
  async scanDevices() {
    if (!this.ffmpeg) throw new Error(this.startupError || 'FFmpeg is not available, so devices cannot be listed');
    this.captureDevices = { ...(await this.listDevicesFn(this.ffmpeg.path)), scannedAt: Date.now() };
    // OBS engine: same devices as libdshowcapture sees them (only when isu-capture is installed).
    const exe = findCaptureExe(this.config.input?.captureExe);
    this.captureDevices.obs = exe ? await listObsDevices(exe) : { backend: 'obs', video: [], audio: [], error: 'isu-capture.exe not installed (stream-server/vendor/capture/)' };
    return this.captureDevices;
  }

  async deviceModes(device) {
    if (!this.ffmpeg) throw new Error('FFmpeg is not available');
    if (typeof device !== 'string' || !device || device.length > 1024) throw new Error('Pick a video device first');
    // A device already in use (by this program or another app) may refuse to list its modes.
    return this.listModesFn(this.ffmpeg.path, device);
  }

  async command(action, payload = {}) {
    if (action === 'save') return this.save(payload);
    // Delay change via the API: same path as SAVE SETTINGS (stop outputs, discard, refill).
    if (action === 'setDelay') return this.save({ ...this.store.publicConfig(this.config), delaySeconds: payload.seconds });
    if (action === 'scanDevices') { await this.scanDevices(); return this.view(); }
    if (action === 'deviceModes') return { ...this.view(), modes: await this.deviceModes(payload.device) };
    if (this.sim) { await this.sim.command(action, payload); return this.view(); }
    if (!this.engine) throw new Error(this.startupError || 'Real engine unavailable');
    switch (action) {
      case 'startAll': await this.engine.startAll(); break;
      case 'stopAll': await this.engine.stopAllOutputs(); break;
      case 'start': await this.engine.startOutput(payload.id); break;
      case 'stop': await this.engine.stopOutput(payload.id); break;
      // Reset = stop outputs, throw away every buffered second, refill from the live input.
      case 'reset': await this.engine.startProgram(this.config); break;
      case 'restartProgram': await this.engine.startProgram(this.config); break;
      // Recording is LIVE (undelayed) local files; it never feeds a stream destination.
      case 'startRecording': await this.engine.startRecording({ directory: this.recordingDir(), segmentMinutes: this.config.recording?.segmentMinutes || 30 }); break;
      case 'stopRecording': await this.engine.stopRecording(); break;
      case 'preview': this.engine.preview.setEnabled(Boolean(payload.enabled)); break;
      default: throw new Error('Unknown command');
    }
    this.emit('status', this.status());
    return this.view();
  }

  // Validate before touching anything; only then stop outputs and rebuild with the new config.
  async save(payload) {
    const next = this.store.prepare(payload, this.config);
    const engineChanged = next.engine !== this.config.engine || next.ffmpegPath !== this.config.ffmpegPath || next.storageDir !== this.config.storageDir;
    const programChanged = engineChanged || JSON.stringify([next.input, next.encoder, next.delaySeconds]) !== JSON.stringify([this.config.input, this.config.encoder, this.config.delaySeconds]);
    if (programChanged && this.engine?.encoder.running) await this.engine.stopAllOutputs();
    this.store.save(next);
    this.config = next;
    this.health.forget(next.destinations.map((d) => d.id));
    if (engineChanged) {
      await this.closeEngines();
      await this.initialize();
    } else if (this.sim) {
      // Simulation: same reset semantics as the scaffold (stop outputs, refill fake buffer).
      this.sim.config = next;
      await this.sim.outputs.stopAll();
      this.sim.outputs.configure(next.destinations);
      await this.sim.delay.configure(next.delaySeconds);
      this.sim.tick(0);
    } else if (this.engine) {
      this.engine.showSecrets = Boolean(next.troubleshooting);
      this.engine.configureDestinations(next.destinations);
      if (programChanged || this.engine.state !== 'RUNNING') {
        try { await this.engine.startProgram(next); this.startupError = ''; }
        catch (error) { this.startupError = error.message; }
      }
    } else {
      await this.initialize();
    }
    this.logger.write('settings.saved', { state: next.engine.toUpperCase(), seconds: next.delaySeconds });
    this.emit('saved');
    this.emit('status', this.status());
    return this.view();
  }

  async closeEngines() {
    if (this.engine) { await this.engine.close(); this.engine = null; }
    if (this.sim) { await this.sim.close(); this.sim = null; }
  }

  async close() { await this.closeEngines(); }
}

module.exports = { StreamService };
