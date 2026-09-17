const FIELD_IDS = Object.freeze(['homeScore', 'timer', 'awayScore']);
const SCORE_STALE_MS = 5000;
const TIMER_STALE_MS = 1250;

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
    stale: true,
    source: null,
    iteration: 0
  };
}

class ValorantOcrState {
  constructor({ scoreConfidence = 0.72, timerConfidence = 0.62 } = {}) {
    this.scoreConfidence = scoreConfidence;
    this.timerConfidence = timerConfidence;
    this.fields = Object.fromEntries(FIELD_IDS.map((id) => [id, emptyField(id)]));
    this.pending = Object.fromEntries(FIELD_IDS.map((id) => [id, { value: null, count: 0 }]));
    this.metrics = { observations: 0, accepted: 0, rejected: 0 };
    this.startedAt = Date.now();
  }

  clear(now = Date.now()) {
    this.fields = Object.fromEntries(FIELD_IDS.map((id) => [id, emptyField(id)]));
    this.pending = Object.fromEntries(FIELD_IDS.map((id) => [id, { value: null, count: 0 }]));
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

    let decision;
    if (!parsed.valid) decision = { accepted: false, reason: 'unreadable' };
    else if (fieldId === 'timer') decision = this.validateTimer(field, parsed.value, confidence, now);
    else decision = this.validateScore(field, parsed.value, confidence);

    field.accepted = decision.accepted;
    field.reason = decision.reason;
    if (decision.accepted) {
      field.value = parsed.value;
      field.displayValue = fieldId === 'timer'
        ? `${Math.floor(parsed.value / 60)}:${String(parsed.value % 60).padStart(2, '0')}`
        : String(parsed.value);
      field.updatedAt = now;
      field.stale = false;
      this.metrics.accepted += 1;
    } else {
      this.metrics.rejected += 1;
    }
    return this.snapshot(now);
  }

  validateScore(field, value, confidence) {
    if (confidence < this.scoreConfidence) return { accepted: false, reason: 'low-confidence' };
    if (field.value !== null && value < field.value) return { accepted: false, reason: 'score-decrease' };
    if (field.value !== null && value > field.value + 1) return { accepted: false, reason: 'score-jump' };
    if (value === field.value) {
      this.pending[field.id] = { value: null, count: 0 };
      return { accepted: true, reason: 'confirmed-current' };
    }
    return this.confirmCandidate(field.id, value, confidence >= 0.94, 'score-confirmed');
  }

  validateTimer(field, value, confidence, now) {
    if (confidence < this.timerConfidence) return { accepted: false, reason: 'low-confidence' };
    if (field.value === null) return this.confirmCandidate(field.id, value, confidence >= 0.9, 'timer-lock');

    const elapsedSeconds = Math.max(0, (now - field.updatedAt) / 1000);
    const predicted = Math.max(0, field.value - elapsedSeconds);
    const delta = value - predicted;
    if (delta > 2.25) return this.confirmCandidate(field.id, value, false, 'timer-reset');
    if (delta < -3.25) return { accepted: false, reason: 'timer-jump' };
    return this.confirmCandidate(field.id, value, confidence >= 0.86, 'timer-plausible');
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
