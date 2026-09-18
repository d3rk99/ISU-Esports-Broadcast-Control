const { DEFAULT_PROFILE_ID, FIELD_IDS, getValorantOcrProfile, listValorantOcrProfiles } = require('./valorant-ocr-profiles.cjs');
const { ValorantOcrState } = require('./valorant-ocr-state.cjs');
const { WebSocketServer } = require('ws');

const DEFAULTS = Object.freeze({
  enabled: false,
  source: 'local',
  windowName: 'VALORANT',
  captureFps: 8,
  profileId: DEFAULT_PROFILE_ID,
  language: 'eng',
  scoreboardMode: 'manual',
  recordedVideoMode: false,
  debugRois: true,
  bridgePort: 3175,
  bridgeToken: '',
  roiOverrides: {}
});

function safePort(value, fallback = DEFAULTS.bridgePort) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

function normalizeSettings(settings = {}) {
  const captureFps = Number(settings.captureFps);
  const profile = getValorantOcrProfile(settings.profileId, settings.roiOverrides);
  return {
    ...DEFAULTS,
    ...settings,
    enabled: Boolean(settings.enabled),
    source: ['remote', 'simulator'].includes(settings.source) ? settings.source : 'local',
    windowName: String(settings.windowName || DEFAULTS.windowName).trim() || DEFAULTS.windowName,
    captureFps: Number.isFinite(captureFps) ? Math.max(1, Math.min(15, Math.round(captureFps))) : DEFAULTS.captureFps,
    profileId: profile.id,
    language: 'eng',
    scoreboardMode: ['manual', 'swapped'].includes(settings.scoreboardMode) ? settings.scoreboardMode : 'manual',
    recordedVideoMode: Boolean(settings.recordedVideoMode),
    debugRois: settings.debugRois !== false,
    bridgePort: safePort(settings.bridgePort),
    bridgeToken: String(settings.bridgeToken || '').trim(),
    roiOverrides: Object.fromEntries(FIELD_IDS.map((id) => [id, { ...profile.fields[id].roi }]))
  };
}

class ValorantOcrService {
  constructor({ capture = null, ocr = null, onState = () => {}, onStatus = () => {}, now = () => Date.now() } = {}) {
    this.capture = capture;
    this.ocr = ocr;
    this.onState = onState;
    this.onStatus = onStatus;
    this.now = now;
    this.settings = { ...DEFAULTS };
    this.validator = new ValorantOcrState();
    this.loopTimer = null;
    this.watchdogTimer = null;
    this.simulatorTimer = null;
    this.server = null;
    this.bridgeClients = new Set();
    this.remoteState = null;
    this.remoteSequence = 0;
    this.lastRemoteAt = 0;
    this.busy = false;
    this.generation = 0;
    this.lastScannedAt = Object.fromEntries(FIELD_IDS.map((id) => [id, 0]));
    this.latestFrame = null;
    this.frameTimestamps = [];
    this.scanTimestamps = [];
    this.latencies = [];
    this.captureFailures = 0;
    this.consecutiveCaptureFailures = 0;
    this.lastCaptureErrorAt = 0;
    this.lastCaptureRecoveredAt = 0;
    this.status = this.makeStatus('disabled', 'VALORANT OCR is off');
  }

  makeStatus(state, message, extra = {}) {
    const now = this.now();
    const snapshot = this.settings.source === 'remote'
      ? this.remoteSnapshot(now)
      : this.validator.snapshot(now);
    const lastTrustedAt = Math.max(0, ...FIELD_IDS.map((id) => snapshot.fields[id].updatedAt || 0));
    return {
      state,
      message,
      enabled: Boolean(this.settings.enabled),
      source: this.settings.source,
      profileId: this.settings.profileId,
      windowName: this.settings.windowName,
      captureFps: this.frameRate(now),
      captureWidth: this.latestFrame?.width || null,
      captureHeight: this.latestFrame?.height || null,
      scans: snapshot.metrics.observations,
      scansPerSecond: this.scanRate(now),
      accepted: snapshot.metrics.accepted,
      rejected: snapshot.metrics.rejected,
      avgOcrLatencyMs: this.latencies.length ? Math.round(this.latencies.reduce((sum, value) => sum + value, 0) / this.latencies.length) : null,
      lastFrameAt: this.latestFrame?.capturedAt || null,
      frameAgeMs: this.latestFrame ? now - this.latestFrame.capturedAt : null,
      captureFailures: this.captureFailures,
      consecutiveCaptureFailures: this.consecutiveCaptureFailures,
      lastCaptureErrorAt: this.lastCaptureErrorAt || null,
      lastCaptureRecoveredAt: this.lastCaptureRecoveredAt || null,
      usingLastGoodFrame: this.consecutiveCaptureFailures > 0 && Boolean(this.latestFrame),
      lastTrustedAt: lastTrustedAt || null,
      trustedAgeMs: lastTrustedAt ? now - lastTrustedAt : null,
      bridgeClients: this.bridgeClients.size,
      lastPacketAt: this.lastRemoteAt || null,
      dataAgeMs: this.lastRemoteAt ? now - this.lastRemoteAt : null,
      updatedAt: now,
      ...extra
    };
  }

  emitStatus(state = this.status.state, message = this.status.message, extra = {}) {
    this.status = this.makeStatus(state, message, extra);
    this.onStatus({ ...this.status });
    return this.status;
  }

  emitState(now = this.now()) {
    if (this.settings.source === 'remote') {
      const state = this.remoteSnapshot(now);
      this.onState(state);
      return state;
    }
    const snapshot = this.validator.snapshot(now);
    const state = this.normalizedState(snapshot, now);
    this.onState(state);
    return state;
  }

  remoteSnapshot(now = this.now()) {
    if (!this.remoteState) {
      const state = this.normalizedState(new ValorantOcrState().snapshot(now), now);
      state.connected = false;
      state.capture = { width: 1920, height: 1080, fps: 0, lastFrameAt: null, windowName: this.settings.windowName };
      return state;
    }
    const state = JSON.parse(JSON.stringify(this.remoteState));
    const networkStale = !this.lastRemoteAt || now - this.lastRemoteAt > 1500;
    state.connected = !networkStale && this.bridgeClients.size > 0;
    state.receivedAt = this.lastRemoteAt || null;
    state.networkAgeMs = this.lastRemoteAt ? now - this.lastRemoteAt : null;
    if (networkStale && state.fields) {
      for (const field of Object.values(state.fields)) field.stale = true;
    }
    return state;
  }

  normalizedState(snapshot = this.validator.snapshot(this.now()), now = this.now()) {
    const homeScore = snapshot.fields.homeScore;
    const timer = snapshot.fields.timer;
    const awayScore = snapshot.fields.awayScore;
    return {
      source: 'valorant-ocr',
      connected: Boolean(this.settings.enabled && (this.settings.source === 'simulator' || (this.latestFrame && now - this.latestFrame.capturedAt <= 2500))),
      capture: {
        width: this.latestFrame?.width || 1920,
        height: this.latestFrame?.height || 1080,
        fps: this.frameRate(now),
        lastFrameAt: this.latestFrame?.capturedAt || null,
        windowName: this.latestFrame?.sourceName || this.settings.windowName,
        failures: this.captureFailures,
        consecutiveFailures: this.consecutiveCaptureFailures,
        recovering: this.consecutiveCaptureFailures > 0,
        usingLastGoodFrame: this.consecutiveCaptureFailures > 0 && Boolean(this.latestFrame)
      },
      match: { timerSeconds: timer.value, timerDisplay: timer.displayValue },
      teams: {
        home: { score: homeScore.value },
        away: { score: awayScore.value }
      },
      ...snapshot
    };
  }

  configure(nextSettings = {}) {
    const wasEnabled = this.settings.enabled;
    this.stopLoops();
    this.settings = normalizeSettings(nextSettings);
    this.validator.setRecordedVideoMode(this.settings.recordedVideoMode);
    this.lastScannedAt = Object.fromEntries(FIELD_IDS.map((id) => [id, 0]));
    this.frameTimestamps = [];
    this.scanTimestamps = [];
    this.latencies = [];
    this.captureFailures = 0;
    this.consecutiveCaptureFailures = 0;
    this.lastCaptureErrorAt = 0;
    this.lastCaptureRecoveredAt = 0;
    if (!this.settings.enabled) {
      this.emitState();
      return this.emitStatus('disabled', 'VALORANT OCR is off');
    }
    this.startWatchdog();
    if (this.settings.source === 'simulator') {
      this.startSimulator();
      return this.status;
    }
    if (this.settings.source === 'remote') {
      this.emitStatus('starting', 'Starting VALORANT bridge receiver');
      this.startReceiver();
      return this.status;
    }
    if (!this.capture || !this.ocr) return this.emitStatus('error', 'OCR capture service is unavailable');
    this.emitStatus('starting', wasEnabled ? 'Restarting VALORANT OCR' : 'Starting VALORANT OCR');
    this.schedule(0);
    return this.status;
  }

  stopLoops() {
    this.generation += 1;
    clearTimeout(this.loopTimer);
    clearInterval(this.watchdogTimer);
    clearInterval(this.simulatorTimer);
    this.loopTimer = null;
    this.watchdogTimer = null;
    this.simulatorTimer = null;
    this.busy = false;
    for (const client of this.bridgeClients) client.close();
    this.bridgeClients.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  stop() {
    this.stopLoops();
    this.settings = { ...this.settings, enabled: false };
    return this.emitStatus('disabled', 'VALORANT OCR is off');
  }

  async shutdown() {
    this.stop();
    await this.ocr?.close?.();
  }

  schedule(delay = Math.round(1000 / this.settings.captureFps)) {
    const generation = this.generation;
    clearTimeout(this.loopTimer);
    this.loopTimer = setTimeout(async () => {
      if (generation !== this.generation || !this.settings.enabled || this.settings.source !== 'local') return;
      await this.tick();
      if (generation === this.generation && this.settings.enabled) this.schedule();
    }, delay);
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    const now = this.now();
    try {
      const frame = await this.capture.capture(this.settings.windowName);
      if (this.consecutiveCaptureFailures > 0) this.lastCaptureRecoveredAt = now;
      this.consecutiveCaptureFailures = 0;
      this.latestFrame = frame;
      this.frameTimestamps.push(frame.capturedAt || now);
      this.frameTimestamps = this.frameTimestamps.filter((value) => now - value <= 2000);
      const profile = getValorantOcrProfile(this.settings.profileId, this.settings.roiOverrides);
      const dueFields = FIELD_IDS.filter((id) => now - this.lastScannedAt[id] >= profile.fields[id].cadenceMs);
      for (const fieldId of dueFields) {
        const field = profile.fields[fieldId];
        const crop = this.capture.crop(frame, field.roi, field.preprocess);
        const result = await this.ocr.recognize(crop.image, { ...field.preprocess, kind: field.kind });
        const observedAt = this.now();
        this.lastScannedAt[fieldId] = observedAt;
        this.scanTimestamps.push(observedAt);
        this.scanTimestamps = this.scanTimestamps.filter((value) => observedAt - value <= 2000);
        if (Number.isFinite(result.latencyMs)) {
          this.latencies.push(result.latencyMs);
          if (this.latencies.length > 30) this.latencies.shift();
        }
        this.validator.observe(fieldId, { ...result, source: 'ocr' }, observedAt);
      }
      this.emitState();
      const snapshot = this.validator.snapshot(this.now());
      const trustedCount = FIELD_IDS.filter((id) => snapshot.fields[id].value !== null).length;
      this.emitStatus(trustedCount === FIELD_IDS.length ? 'reading' : 'calibrating', trustedCount === FIELD_IDS.length
        ? 'Reading VALORANT scoreboard'
        : `Capture active; locked ${trustedCount} of ${FIELD_IDS.length} fields`, { sourceName: frame.sourceName });
    } catch (error) {
      this.captureFailures += 1;
      this.consecutiveCaptureFailures += 1;
      this.lastCaptureErrorAt = this.now();
      const transient = ['CAPTURE_EMPTY', 'WINDOW_NOT_FOUND'].includes(error?.code);
      const retainingFrame = transient && Boolean(this.latestFrame);
      let state;
      let message;
      if (transient && this.consecutiveCaptureFailures <= 3) {
        state = this.latestFrame ? 'recovering' : 'searching-window';
        message = `${error?.message || 'Capture temporarily unavailable'}; retrying automatically (${this.consecutiveCaptureFailures}/3)`;
      } else {
        state = error?.code === 'WINDOW_NOT_FOUND' && !this.latestFrame ? 'searching-window' : error?.code === 'CAPTURE_SIZE' || transient ? 'degraded' : 'error';
        message = error?.message || 'VALORANT OCR capture failed';
      }
      this.emitState();
      this.emitStatus(state, message, {
        errorCode: error?.code || 'OCR_ERROR',
        usingLastGoodFrame: retainingFrame,
        retrying: transient
      });
    } finally {
      this.busy = false;
    }
  }

  frameRate(now = this.now()) {
    const recent = this.frameTimestamps.filter((value) => now - value <= 2000);
    if (recent.length < 2) return recent.length;
    return Math.round(((recent.length - 1) / ((recent.at(-1) - recent[0]) / 1000)) * 10) / 10;
  }

  scanRate(now = this.now()) {
    const recent = this.scanTimestamps.filter((value) => now - value <= 2000);
    if (recent.length < 2) return recent.length;
    const seconds = (recent.at(-1) - recent[0]) / 1000;
    return seconds > 0 ? Math.round(((recent.length - 1) / seconds) * 10) / 10 : recent.length;
  }

  startWatchdog() {
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => {
      const snapshot = this.emitState();
      if (this.settings.source === 'remote' && this.lastRemoteAt && this.now() - this.lastRemoteAt > 1500) {
        this.emitStatus('stale', 'Game PC data is stale; retaining the last trusted values', { transport: 'bridge' });
      } else if (this.status.state === 'reading' && FIELD_IDS.every((id) => snapshot.fields[id].stale)) {
        this.emitStatus('stale', 'OCR data is stale; retaining the last trusted values');
      } else this.emitStatus();
    }, 500);
  }

  clearState() {
    if (this.settings.source === 'remote') {
      this.remoteState = null;
      this.remoteSequence = 0;
      this.lastRemoteAt = 0;
      this.emitStatus('listening', 'Remote state cleared; waiting for Game PC', { transport: 'bridge' });
      return this.emitState();
    }
    const snapshot = this.validator.clear(this.now());
    this.onState(this.normalizedState(snapshot));
    this.emitStatus(this.settings.enabled ? 'calibrating' : 'disabled', this.settings.enabled ? 'OCR state cleared; waiting for a stable read' : 'VALORANT OCR is off');
    return this.normalizedState(snapshot);
  }

  async listWindows() {
    if (this.settings.source === 'remote') return [];
    if (!this.capture) return [];
    return this.capture.listWindows();
  }

  async captureSnapshot() {
    if (this.settings.source === 'remote') throw new Error('Capture debug frames on the Game PC bridge');
    if (!this.capture) throw new Error('Capture service is unavailable');
    const frame = await this.capture.capture(this.settings.windowName);
    this.latestFrame = frame;
    const profile = getValorantOcrProfile(this.settings.profileId, this.settings.roiOverrides);
    return { ...this.capture.snapshot(frame, profile.fields), profile };
  }

  startReceiver() {
    if (!this.settings.bridgeToken) return this.emitStatus('error', 'Create a bridge key before starting remote mode');
    try {
      this.server = new WebSocketServer({ host: '0.0.0.0', port: this.settings.bridgePort });
    } catch (error) {
      return this.emitStatus('error', error.message, { transport: 'bridge' });
    }
    this.server.on('listening', () => this.emitStatus('listening', `Waiting for Game PC on port ${this.settings.bridgePort}`, { transport: 'bridge' }));
    this.server.on('error', (error) => this.emitStatus('error', `Bridge receiver error: ${error.message}`, { transport: 'bridge' }));
    this.server.on('connection', (client, request) => {
      const requestUrl = new URL(request.url, `ws://${request.headers.host || 'localhost'}`);
      if (requestUrl.searchParams.get('token') !== this.settings.bridgeToken) {
        client.close(1008, 'Invalid bridge key');
        return;
      }
      this.bridgeClients.add(client);
      this.emitStatus('connected', 'Universal Game Bridge connected; waiting for VALORANT data', { transport: 'bridge' });
      client.on('message', (raw) => {
        try {
          const packet = JSON.parse(raw.toString());
          if (packet.game !== 'valorant' || !['game-state', 'valorant-state'].includes(packet.type)) return;
          const sequence = Number(packet.sequence) || 0;
          if (sequence && sequence <= this.remoteSequence) return;
          if (sequence) this.remoteSequence = sequence;
          if (!packet.payload || typeof packet.payload !== 'object') return;
          this.remoteState = packet.payload;
          this.lastRemoteAt = this.now();
          this.onState(this.remoteSnapshot(this.lastRemoteAt));
          this.emitStatus('reading', 'Receiving validated VALORANT OCR from Game PC', { transport: 'bridge' });
        } catch {}
      });
      client.on('close', () => {
        this.bridgeClients.delete(client);
        this.emitStatus('listening', `Game PC disconnected; waiting on port ${this.settings.bridgePort}`, { transport: 'bridge' });
      });
      client.on('error', () => {});
      client.send(JSON.stringify({ type: 'welcome', game: 'valorant', version: 1 }));
    });
  }

  startSimulator() {
    this.stopLoops();
    this.settings = { ...this.settings, enabled: true, source: 'simulator' };
    this.validator.clear(this.now());
    this.latestFrame = null;
    this.frameTimestamps = [];
    this.scanTimestamps = [];
    this.latencies = [];
    this.startWatchdog();
    const startedAt = this.now();
    const apply = () => {
      const elapsed = Math.floor((this.now() - startedAt) / 1000);
      const roundLength = 100;
      const timer = Math.max(0, roundLength - (elapsed % 110));
      const round = Math.floor(elapsed / 110);
      const values = { homeScore: Math.min(13, round), timer, awayScore: Math.min(13, Math.floor(round / 2)) };
      for (const fieldId of FIELD_IDS) {
        const value = values[fieldId];
        const text = fieldId === 'timer' ? `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}` : String(value);
        this.validator.observe(fieldId, { text, confidence: 0.99, latencyMs: 1, source: 'simulator' }, this.now());
      }
      this.emitState();
      this.emitStatus('simulating', 'Deterministic OCR test feed is running');
    };
    apply();
    apply();
    apply();
    this.simulatorTimer = setInterval(apply, 250);
    return this.status;
  }

  stopSimulator() {
    this.stopLoops();
    this.settings = { ...this.settings, enabled: false, source: 'local' };
    return this.emitStatus('disabled', 'VALORANT OCR test feed stopped');
  }

  getInfo() {
    return { settings: { ...this.settings }, status: { ...this.status }, profiles: listValorantOcrProfiles(), state: this.normalizedState() };
  }
}

module.exports = { DEFAULTS, ValorantOcrService, normalizeSettings };
