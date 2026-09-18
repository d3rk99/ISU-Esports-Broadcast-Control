const FIELD_IDS = Object.freeze(['homeScore', 'timer', 'awayScore']);
const SCORE_STALE_MS = 5000;
const TIMER_STALE_MS = 1250;
const INITIAL_SCORE_WINDOW = 5;
const INITIAL_SCORE_CONSENSUS = 3;
const SCORE_CHANGE_WINDOW = 3;
const SCORE_CHANGE_CONSENSUS = 2;
const SCORE_CORRECTION_WINDOW = 10;
const SCORE_CORRECTION_CONSENSUS = 8;
const VIDEO_SEEK_WINDOW = 5;
const VIDEO_SEEK_CONSENSUS = 3;

function clampConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function normalizeDigits(text) {
  return String(text ?? '')
    .toUpperCase()
    .replace(/[OQD]/g, '0')
    .replace(/[IL|!]/g, '1')
    .replace(/[^0-9:]/g, '');
}

function parseScore(text) {
  const normalized = normalizeDigits(text).replaceAll(':', '');
  if (!/^\d{1,2}$/.test(normalized)) return { value: null, normalized, valid: false };
  const value = Number(normalized);
  return { value: value <= 25 ? value : null, normalized, valid: value <= 25 };
}

function parseTimer(text) {
  const normalized = normalizeDigits(text);
  let minutes;
  let seconds;
  if (/^\d{1,2}:\d{2}$/.test(normalized)) {
    [minutes, seconds] = normalized.split(':').map(Number);
  } else {
    const compact = normalized.replaceAll(':', '');
    if (!/^\d{2,4}$/.test(compact)) return { value: null, normalized, valid: false };
    minutes = Number(compact.slice(0, -2));
    seconds = Number(compact.slice(-2));
  }
  const valid = minutes <= 9 && seconds <= 59;
  return {
    value: valid ? minutes * 60 + seconds : null,
    normalized: valid ? `${minutes}:${String(seconds).padStart(2, '0')}` : normalized,
    valid
  };
}

function emptyField(id) {
  return {
    id,
    value: null,
    displayValue: '--',
    confidence: 0,
    rawText: '',
    normalized: '',
    updatedAt: null,
    observedAt: null,
    accepted: false,
    reason: 'waiting',
    correctionCandidate: null,
    correctionProgress: 0,
    correctionRequired: 0,
    stale: true,
    source: null,
    iteration: 0
  };
}

class ValorantOcrState {
  constructor({ scoreConfidence = 0.72, timerConfidence = 0.62, correctionConfidence = 0.9, recordedVideoMode = false } = {}) {
    this.scoreConfidence = scoreConfidence;
    this.timerConfidence = timerConfidence;
    this.correctionConfidence = correctionConfidence;
    this.recordedVideoMode = Boolean(recordedVideoMode);
    this.fields = Object.fromEntries(FIELD_IDS.map((id) => [id, emptyField(id)]));
    this.pending = Object.fromEntries(FIELD_IDS.map((id) => [id, { value: null, count: 0 }]));
    this.history = Object.fromEntries(FIELD_IDS.map((id) => [id, []]));
    this.metrics = { observations: 0, accepted: 0, rejected: 0 };
    this.startedAt = Date.now();
  }

  setRecordedVideoMode(enabled) {
    this.recordedVideoMode = Boolean(enabled);
  }

  clear(now = Date.now()) {
    this.fields = Object.fromEntries(FIELD_IDS.map((id) => [id, emptyField(id)]));
    this.pending = Object.fromEntries(FIELD_IDS.map((id) => [id, { value: null, count: 0 }]));
    this.history = Object.fromEntries(FIELD_IDS.map((id) => [id, []]));
    this.metrics = { observations: 0, accepted: 0, rejected: 0 };
    this.startedAt = now;
    return this.snapshot(now);
  }

  observe(fieldId, result = {}, now = Date.now()) {
    if (!FIELD_IDS.includes(fieldId)) return this.snapshot(now);
    const field = this.fields[fieldId];
    const parser = fieldId === 'timer' ? parseTimer : parseScore;
    const parsed = parser(result.text);
    const confidence = clampConfidence(result.confidence);
    this.metrics.observations += 1;
    field.iteration += 1;
    field.rawText = String(result.text ?? '').trim();
    field.normalized = parsed.normalized;
    field.confidence = confidence;
    field.observedAt = now;
    field.source = result.source || 'ocr';

    const minimumConfidence = fieldId === 'timer' ? this.timerConfidence : this.scoreConfidence;
    if (parsed.valid && confidence >= minimumConfidence) this.remember(fieldId, parsed.value, confidence, now);

    let decision;
    if (!parsed.valid) decision = { accepted: false, reason: 'unreadable' };
    else if (fieldId === 'timer') decision = this.validateTimer(field, parsed.value, confidence, now);
    else decision = this.validateScore(field, parsed.value, confidence);

    field.accepted = decision.accepted;
    field.reason = decision.reason;
    field.correctionCandidate = decision.correctionCandidate ?? null;
    field.correctionProgress = decision.correctionProgress ?? 0;
    field.correctionRequired = decision.correctionRequired ?? 0;
    if (decision.accepted) {
      field.value = parsed.value;
      field.displayValue = fieldId === 'timer'
        ? `${Math.floor(parsed.value / 60)}:${String(parsed.value % 60).padStart(2, '0')}`
        : String(parsed.value);
      field.updatedAt = now;
      field.stale = false;
      if (decision.resetHistory) this.history[fieldId] = [];
      this.metrics.accepted += 1;
    } else {
      this.metrics.rejected += 1;
    }
    return this.snapshot(now);
  }

  validateScore(field, value, confidence) {
    if (confidence < this.scoreConfidence) return { accepted: false, reason: 'low-confidence' };
    if (field.value === null) {
      const matches = this.consensus(field.id, value, INITIAL_SCORE_WINDOW);
      if (matches >= INITIAL_SCORE_CONSENSUS) return { accepted: true, reason: 'score-initial-consensus', resetHistory: true };
      return {
        accepted: false,
        reason: `initial-consensus-${matches}/${INITIAL_SCORE_CONSENSUS}`,
        correctionCandidate: value,
        correctionProgress: matches,
        correctionRequired: INITIAL_SCORE_CONSENSUS
      };
    }
    if (value === field.value) {
      this.pending[field.id] = { value: null, count: 0 };
      return { accepted: true, reason: 'confirmed-current' };
    }
    if (value === field.value + 1) {
      const matches = this.consensus(field.id, value, SCORE_CHANGE_WINDOW);
      if (matches >= SCORE_CHANGE_CONSENSUS) return { accepted: true, reason: 'score-change-consensus', resetHistory: true };
      return {
        accepted: false,
        reason: `score-change-${matches}/${SCORE_CHANGE_CONSENSUS}`,
        correctionCandidate: value,
        correctionProgress: matches,
        correctionRequired: SCORE_CHANGE_CONSENSUS
      };
    }

    const videoMatches = this.consensus(field.id, value, VIDEO_SEEK_WINDOW, this.scoreConfidence);
    if (this.recordedVideoMode && videoMatches >= VIDEO_SEEK_CONSENSUS) {
      return { accepted: true, reason: 'recorded-video-seek', resetHistory: true };
    }

    const correctionMatches = this.consensus(field.id, value, SCORE_CORRECTION_WINDOW, this.correctionConfidence);
    if (correctionMatches >= SCORE_CORRECTION_CONSENSUS) {
      return { accepted: true, reason: 'persistent-score-correction', resetHistory: true };
    }
    const transition = value < field.value ? 'score-decrease' : 'score-jump';
    const required = this.recordedVideoMode ? VIDEO_SEEK_CONSENSUS : SCORE_CORRECTION_CONSENSUS;
    const progress = this.recordedVideoMode ? videoMatches : correctionMatches;
    return {
      accepted: false,
      reason: `${transition}-held-${progress}/${required}`,
      correctionCandidate: value,
      correctionProgress: progress,
      correctionRequired: required
    };
  }

  validateTimer(field, value, confidence, now) {
    if (confidence < this.timerConfidence) return { accepted: false, reason: 'low-confidence' };
    if (field.value === null) return this.confirmCandidate(field.id, value, confidence >= 0.9, 'timer-lock');

    const elapsedSeconds = Math.max(0, (now - field.updatedAt) / 1000);
    const predicted = Math.max(0, field.value - elapsedSeconds);
    const delta = value - predicted;
    if (delta > 2.25) return this.confirmCandidate(field.id, value, false, 'timer-reset');
    if (delta < -3.25) {
      if (this.recordedVideoMode) return this.confirmCandidate(field.id, value, false, 'recorded-video-seek');
      return { accepted: false, reason: 'timer-jump' };
    }
    return this.confirmCandidate(field.id, value, confidence >= 0.86, 'timer-plausible');
  }

  remember(fieldId, value, confidence, observedAt) {
    const history = this.history[fieldId];
    history.push({ value, confidence, observedAt });
    if (history.length > SCORE_CORRECTION_WINDOW) history.splice(0, history.length - SCORE_CORRECTION_WINDOW);
  }

  consensus(fieldId, value, windowSize, minimumConfidence = this.scoreConfidence) {
    return this.history[fieldId]
      .slice(-windowSize)
      .filter((candidate) => candidate.value === value && candidate.confidence >= minimumConfidence)
      .length;
  }

  confirmCandidate(fieldId, value, immediate, acceptedReason) {
    const pending = this.pending[fieldId];
    if (pending.value === value) pending.count += 1;
    else {
      pending.value = value;
      pending.count = 1;
    }
    if (immediate || pending.count >= 2) {
      this.pending[fieldId] = { value: null, count: 0 };
      return { accepted: true, reason: immediate ? `${acceptedReason}-high-confidence` : acceptedReason };
    }
    return { accepted: false, reason: 'awaiting-confirmation' };
  }

  snapshot(now = Date.now()) {
    const fields = {};
    for (const id of FIELD_IDS) {
      const source = this.fields[id];
      const staleAfter = id === 'timer' ? TIMER_STALE_MS : SCORE_STALE_MS;
      const ageMs = source.updatedAt === null ? null : Math.max(0, now - source.updatedAt);
      const stale = ageMs === null || ageMs > staleAfter;
      let displayValue = source.displayValue;
      let value = source.value;
      if (id === 'timer' && value !== null && !stale) {
        value = Math.max(0, Math.round(value - ageMs / 1000));
        displayValue = `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
      }
      fields[id] = { ...source, value, displayValue, stale, ageMs };
    }
    return { fields, metrics: { ...this.metrics }, generatedAt: now };
  }
}

module.exports = {
  FIELD_IDS,
  SCORE_STALE_MS,
  TIMER_STALE_MS,
  ValorantOcrState,
  normalizeDigits,
  parseScore,
  parseTimer
};
