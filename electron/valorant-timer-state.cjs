const { performance } = require('node:perf_hooks');
const { parseTimer } = require('./valorant-ocr-state.cjs');

const TIMER_STATES = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  ROUND_ACTIVE: 'ROUND_ACTIVE',
  LOW_TIME: 'LOW_TIME',
  SPIKE_PLANTED: 'SPIKE_PLANTED',
  ROUND_END: 'ROUND_END'
});

const TIMER_DEFAULTS = Object.freeze({
  confidenceThreshold: 0.72,
  highConfidenceThreshold: 0.88,
  syncCorrectionThresholdSeconds: 1.2,
  maxForwardJumpSeconds: 3.5,
  resetJumpSeconds: 8,
  maxVisionSeconds: 105,
  roundStartLockSeconds: 99,
  lowTimeThresholdSeconds: 15,
  spikeDurationSeconds: 45,
  spikePersistence: 2,
  staleSyncMs: 5000
});

function clampNumber(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function formatClock(seconds, { lowTime = false } = {}) {
  const value = Math.max(0, Number(seconds) || 0);
  if (lowTime) return value.toFixed(2).padStart(5, '0');
  const whole = Math.max(0, Math.ceil(value));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function parseTimerVision(result = {}) {
  if (result?.state === 'spike-planted') {
    return {
      rawText: String(result.text || 'SPIKE PLANTED'),
      parsedSeconds: null,
      confidence: clampNumber(result.confidence, 0, 1, 0),
      hudMode: 'SPIKE_PLANTED',
      source: result.source || 'vision'
    };
  }
  const rawText = String(result.text ?? '').trim();
  const decimal = rawText.replace(/[OQD]/gi, '0').replace(/[IL|!]/g, '1').match(/(\d{1,2})[\.:](\d{1,2})/);
  if (decimal && rawText.includes('.')) {
    const seconds = Number(decimal[1]);
    const fraction = Number(decimal[2].padEnd(2, '0').slice(0, 2)) / 100;
    if (seconds <= 15) {
      return {
        rawText,
        parsedSeconds: seconds + fraction,
        confidence: clampNumber(result.confidence, 0, 1, 0),
        hudMode: 'LOW_TIME',
        source: result.source || 'vision'
      };
    }
  }
  const parsed = parseTimer(rawText);
  return {
    rawText,
    parsedSeconds: parsed.valid ? parsed.value : null,
    confidence: clampNumber(result.confidence, 0, 1, 0),
    hudMode: parsed.valid && parsed.value <= TIMER_DEFAULTS.lowTimeThresholdSeconds ? 'LOW_TIME' : 'NORMAL',
    source: result.source || 'vision',
    normalized: parsed.normalized,
    valid: parsed.valid
  };
}

class ValorantTimerStateService {
  constructor({ now = () => Date.now(), monotonicNow = () => performance.now(), config = {} } = {}) {
    this.now = now;
    this.monotonicNow = monotonicNow;
    this.config = { ...TIMER_DEFAULTS, ...config };
    this.clear();
  }

  clear() {
    this.state = TIMER_STATES.UNKNOWN;
    this.syncRemainingSeconds = null;
    this.syncMonoMs = null;
    this.lastSyncAt = null;
    this.lastVision = null;
    this.trustedVision = null;
    this.pending = { value: null, count: 0, state: null };
    this.spikeDetections = 0;
    this.acceptedReadings = 0;
    this.rejectedReadings = 0;
    this.lastRejectionReason = '';
    this.lastSyncErrorSeconds = null;
    return this.snapshot();
  }

  currentSeconds(monoMs = this.monotonicNow()) {
    if (this.syncRemainingSeconds === null || this.syncMonoMs === null) return null;
    return Math.max(0, this.syncRemainingSeconds - ((monoMs - this.syncMonoMs) / 1000));
  }

  sync(seconds, state, vision, monoMs = this.monotonicNow(), wallNow = this.now(), reason = 'sync') {
    this.syncRemainingSeconds = Math.max(0, Number(seconds) || 0);
    this.syncMonoMs = monoMs;
    this.lastSyncAt = wallNow;
    this.state = state;
    this.trustedVision = { ...vision, acceptedAt: wallNow, reason };
    this.acceptedReadings += 1;
    this.lastRejectionReason = '';
  }

  reject(reason) {
    this.rejectedReadings += 1;
    this.lastRejectionReason = reason;
  }

  observe(result = {}, wallNow = this.now(), monoMs = this.monotonicNow()) {
    const vision = { ...parseTimerVision(result), timestamp: wallNow };
    this.lastVision = vision;

    if (vision.hudMode === 'SPIKE_PLANTED') {
      this.spikeDetections += 1;
      if (this.spikeDetections >= this.config.spikePersistence && this.state !== TIMER_STATES.SPIKE_PLANTED) {
        this.sync(this.config.spikeDurationSeconds, TIMER_STATES.SPIKE_PLANTED, vision, monoMs, wallNow, 'spike-planted');
      }
      return this.snapshot(wallNow, monoMs);
    }
    this.spikeDetections = 0;

    if (vision.parsedSeconds === null || vision.confidence < this.config.confidenceThreshold) {
      this.reject(vision.parsedSeconds === null ? 'timer-unreadable' : 'low-confidence');
      return this.snapshot(wallNow, monoMs);
    }
    if (vision.parsedSeconds > this.config.maxVisionSeconds) {
      this.reject('above-round-timer-maximum');
      return this.snapshot(wallNow, monoMs);
    }
    if (vision.parsedSeconds > this.config.roundStartLockSeconds) {
      this.reject('awaiting-round-start');
      return this.snapshot(wallNow, monoMs);
    }

    const current = this.currentSeconds(monoMs);
    const nextState = vision.parsedSeconds <= this.config.lowTimeThresholdSeconds ? TIMER_STATES.LOW_TIME : TIMER_STATES.ROUND_ACTIVE;
    if (current === null) {
      const immediate = vision.confidence >= this.config.highConfidenceThreshold;
      if (!immediate && this.pending.value === Math.round(vision.parsedSeconds)) this.pending.count += 1;
      else this.pending = { value: Math.round(vision.parsedSeconds), count: 1, state: nextState };
      if (immediate || this.pending.count >= 2) this.sync(vision.parsedSeconds, nextState, vision, monoMs, wallNow, 'initial-lock');
      else this.reject('awaiting-initial-confirmation');
      return this.snapshot(wallNow, monoMs);
    }

    const delta = vision.parsedSeconds - current;
    this.lastSyncErrorSeconds = delta;
    if (delta > this.config.resetJumpSeconds && current <= this.config.lowTimeThresholdSeconds + 2) {
      this.sync(vision.parsedSeconds, nextState, vision, monoMs, wallNow, 'round-reset');
      return this.snapshot(wallNow, monoMs);
    }
    if (delta > this.config.maxForwardJumpSeconds) {
      this.reject('impossible-backward-jump');
      return this.snapshot(wallNow, monoMs);
    }
    if (Math.abs(delta) >= this.config.syncCorrectionThresholdSeconds) {
      const rounded = Math.round(vision.parsedSeconds * 10) / 10;
      if (this.pending.value === rounded) this.pending.count += 1;
      else this.pending = { value: rounded, count: 1, state: nextState };
      if (vision.confidence >= this.config.highConfidenceThreshold || this.pending.count >= 2) {
        this.sync(vision.parsedSeconds, nextState, vision, monoMs, wallNow, 'correction');
      } else this.reject('awaiting-correction-confirmation');
      return this.snapshot(wallNow, monoMs);
    }

    this.state = nextState;
    this.trustedVision = { ...vision, acceptedAt: wallNow, reason: 'confirmed' };
    this.acceptedReadings += 1;
    this.lastRejectionReason = '';
    return this.snapshot(wallNow, monoMs);
  }

  snapshot(wallNow = this.now(), monoMs = this.monotonicNow()) {
    const secondsRemaining = this.currentSeconds(monoMs);
    const lowTime = this.state === TIMER_STATES.LOW_TIME || (secondsRemaining !== null && secondsRemaining <= this.config.lowTimeThresholdSeconds);
    const syncAgeMs = this.lastSyncAt === null ? null : Math.max(0, wallNow - this.lastSyncAt);
    const stale = syncAgeMs === null || (syncAgeMs > this.config.staleSyncMs && secondsRemaining === null);
    const state = secondsRemaining === 0 && this.state !== TIMER_STATES.UNKNOWN ? TIMER_STATES.ROUND_END : this.state;
    return {
      state,
      secondsRemaining,
      display: secondsRemaining === null
        ? '--'
        : state === TIMER_STATES.SPIKE_PLANTED
          ? 'SPIKE PLANTED'
          : formatClock(secondsRemaining, { lowTime }),
      lowTime,
      spikePlanted: state === TIMER_STATES.SPIKE_PLANTED,
      source: secondsRemaining === null ? 'waiting' : stale ? 'internal_stale' : 'internal_running',
      visionConfidence: this.trustedVision?.confidence || 0,
      syncAgeMs,
      rawVision: this.lastVision,
      trustedVision: this.trustedVision,
      internalTimer: secondsRemaining,
      syncErrorSeconds: this.lastSyncErrorSeconds,
      acceptedReadings: this.acceptedReadings,
      rejectedReadings: this.rejectedReadings,
      lastRejectionReason: this.lastRejectionReason,
      config: { ...this.config }
    };
  }
}

module.exports = {
  TIMER_STATES,
  TIMER_DEFAULTS,
  ValorantTimerStateService,
  parseTimerVision,
  formatClock
};
