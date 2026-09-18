const { DEFAULT_PROFILE_ID, FIELD_IDS, getValorantOcrProfile, listValorantOcrProfiles } = require('./valorant-ocr-profiles.cjs');
const { ValorantOcrState, parseScore, parseTimer } = require('./valorant-ocr-state.cjs');
const { WebSocketServer } = require('ws');

const DEFAULTS = Object.freeze({
  enabled: false,
  source: 'local',
  windowName: 'VALORANT',
  captureBackend: 'auto',
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
    captureBackend: ['native', 'electron'].includes(settings.captureBackend) ? settings.captureBackend : 'auto',
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

function chooseOcrConsensus(results = [], kind = 'timer') {
  const parser = kind === 'timer' ? parseTimer : parseScore;
  const candidates = results.map((result) => ({ result, parsed: parser(result?.text) })).filter((candidate) => candidate.parsed.valid);
  if (!candidates.length) {
    const fallback = [...results].sort((left, right) => Number(right?.confidence || 0) - Number(left?.confidence || 0))[0] || { text: '', confidence: 0 };
    return { ...fallback, confidence: Math.min(0.55, Number(fallback.confidence) || 0), consensus: 0, variants: results.length };
  }
  const groups = new Map();
  for (const candidate of candidates) {
    const key = String(candidate.parsed.value);
    const group = groups.get(key) || [];
    group.push(candidate);
    groups.set(key, group);
  }
  const ranked = [...groups.values()].sort((left, right) => right.length - left.length
    || Math.max(...right.map((item) => item.result.confidence || 0)) - Math.max(...left.map((item) => item.result.confidence || 0)));
  const winners = ranked[0];
  const best = [...winners].sort((left, right) => Number(right.result.confidence || 0) - Number(left.result.confidence || 0))[0];
  const agreed = winners.length >= 2;
  const confidence = agreed
    ? winners.reduce((sum, item) => sum + Number(item.result.confidence || 0), 0) / winners.length
    : Math.min(0.55, Number(best.result.confidence) || 0);
  return {
    ...best.result,
    text: best.parsed.normalized,
    confidence,
    latencyMs: results.reduce((sum, result) => sum + (Number(result?.latencyMs) || 0), 0),
    consensus: winners.length,
    variants: results.length
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
    this.captureTimer = null;
    this.ocrTimer = null;
    this.watchdogTimer = null;
    this.simulatorTimer = null;
    this.server = null;
    this.bridgeClients = new Set();
    this.remoteState = null;
    this.remoteSequence = 0;
    this.lastRemoteAt = 0;
    this.captureBusy = false;
    this.ocrBusy = false;
    this.generation = 0;
    this.lastScannedAt = Object.fromEntries(FIELD_IDS.map((id) => [id, 0]));
    this.lastScannedFrameAt = Object.fromEntries(FIELD_IDS.map((id) => [id, 0]));
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
      captureBackend: this.latestFrame?.backend || this.settings.captureBackend,
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
        backend: this.latestFrame?.backend || this.settings.captureBackend,
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
    this.lastScannedFrameAt = Object.fromEntries(FIELD_IDS.map((id) => [id, 0]));
    this.frameTimestamps = [];
    this.scanTimestamps = [];
    this.latencies = [];
    this.captureFailures = 0;
    this.consecutiveCaptureFailures = 0;
    this.lastCaptureErrorAt = 0;
    this.lastCaptureRecoveredAt = 0;
    if (!this.settings.enabled) {
      void this.capture?.close?.();
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
    this.scheduleCapture(0);
    this.scheduleOcr(0);
    return this.status;
  }

  stopLoops() {
    this.generation += 1;
    clearTimeout(this.captureTimer);
    clearTimeout(this.ocrTimer);
    clearInterval(this.watchdogTimer);
    clearInterval(this.simulatorTimer);
    this.captureTimer = null;
    this.ocrTimer = null;
    this.watchdogTimer = null;
    this.simulatorTimer = null;
    for (const client of this.bridgeClients) client.close();
    this.bridgeClients.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  stop() {
    this.stopLoops();
    void this.capture?.close?.();
    this.settings = { ...this.settings, enabled: false };
    return this.emitStatus('disabled', 'VALORANT OCR is off');
  }

  async shutdown() {
    this.stop();
    await this.capture?.close?.();
    await this.ocr?.close?.();
  }

  scheduleCapture(delay = Math.round(1000 / this.settings.captureFps)) {
    const generation = this.generation;
    clearTimeout(this.captureTimer);
    this.captureTimer = setTimeout(async () => {
      if (generation !== this.generation || !this.settings.enabled || this.settings.source !== 'local') return;
      await this.captureTick();
      if (generation === this.generation && this.settings.enabled) this.scheduleCapture();
    }, delay);
  }

  scheduleOcr(delay = 20) {
    const generation = this.generation;
    clearTimeout(this.ocrTimer);
    this.ocrTimer = setTimeout(async () => {
      if (generation !== this.generation || !this.settings.enabled || this.settings.source !== 'local') return;
      await this.ocrTick();
      if (generation === this.generation && this.settings.enabled) this.scheduleOcr();
    }, delay);
  }

  async captureTick() {
    if (this.captureBusy) return false;
    this.captureBusy = true;
    const generation = this.generation;
    const now = this.now();
    try {
      const frame = await this.capture.capture(this.settings.windowName, {
        backend: this.settings.captureBackend,
        captureFps: this.settings.captureFps
      });
      if (generation !== this.generation) return false;
      if (this.consecutiveCaptureFailures > 0) this.lastCaptureRecoveredAt = now;
      this.consecutiveCaptureFailures = 0;
      const isNewFrame = !this.latestFrame || frame.capturedAt !== this.latestFrame.capturedAt;
      this.latestFrame = frame;
      if (isNewFrame) {
        this.frameTimestamps.push(frame.capturedAt || now);
        this.frameTimestamps = this.frameTimestamps.filter((value) => now - value <= 2000);
      }
      return isNewFrame;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.captureFailures += 1;
      this.consecutiveCaptureFailures += 1;
      this.lastCaptureErrorAt = this.now();
      const transient = ['CAPTURE_EMPTY', 'WINDOW_NOT_FOUND', 'NATIVE_CAPTURE_TIMEOUT', 'NATIVE_CAPTURE_CLOSED'].includes(error?.code);
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
      return false;
    } finally {
      this.captureBusy = false;
    }
  }

  async recognizeField(frame, fieldId, field) {
    const base = { ...field.preprocess };
    delete base.variants;
    const variants = Array.isArray(field.preprocess.variants) && field.preprocess.variants.length
      ? field.preprocess.variants
      : [{}];
    const results = [];
    for (const variant of variants) {
      const recipe = { ...base, ...variant };
      const crop = this.capture.crop(frame, field.roi, recipe);
      results.push(await this.ocr.recognize(crop.image, { ...recipe, kind: field.kind, fieldId }));
    }
    return variants.length > 1 ? chooseOcrConsensus(results, field.kind) : results[0];
  }

  async ocrTick() {
    if (this.ocrBusy || !this.latestFrame || this.consecutiveCaptureFailures > 0) return false;
    const generation = this.generation;
    const frame = this.latestFrame;
    const now = this.now();
    const profile = getValorantOcrProfile(this.settings.profileId, this.settings.roiOverrides);
    const dueFields = FIELD_IDS.filter((id) => now - this.lastScannedAt[id] >= profile.fields[id].cadenceMs
      && frame.capturedAt !== this.lastScannedFrameAt[id]);
    if (!dueFields.length) return false;
    this.ocrBusy = true;
    try {
      const results = await Promise.all(dueFields.map(async (fieldId) => ({
        fieldId,
        result: await this.recognizeField(frame, fieldId, profile.fields[fieldId])
      })));
      if (generation !== this.generation) return false;
      for (const { fieldId, result } of results) {
        const observedAt = this.now();
        this.lastScannedAt[fieldId] = observedAt;
        this.lastScannedFrameAt[fieldId] = frame.capturedAt;
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
        : `Capture active; locked ${trustedCount} of ${FIELD_IDS.length} fields`, {
        sourceName: frame.sourceName,
        captureBackend: frame.backend || this.settings.captureBackend
      });
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.emitStatus('degraded', `OCR recognition failed: ${error?.message || error}`, { errorCode: error?.code || 'OCR_ERROR' });
      return false;
    } finally {
      this.ocrBusy = false;
    }
  }

  async tick() {
    await this.captureTick();
    return this.ocrTick();
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

module.exports = { DEFAULTS, ValorantOcrService, chooseOcrConsensus, normalizeSettings };
