'use strict';
// Overwatch scoreboard OCR: one spectator (Observer 3) keeps the Tab scoreboard open; this
// service grabs that window, reads every cell (ult %, E/A/D, damage, healing, mitigation,
// names), passes each read through OverwatchConsensus and emits a structured board.
//
// It reuses the VALORANT capture (window capture + crop/preprocess) and Tesseract engine, so
// there is one capture stack to maintain. The controller writes the result into
// state.games.overwatch.overwatchOcr.live; overlays read it from there. Manual (Companion)
// scores keep working; OCR only fills the player stats.
const { getProfile, cellRois, parseCell, ringFill, resolveUltimate, OverwatchConsensus, emptyBoard, applySweep } = require('./overwatch-ocr-parse.cjs');

const DEFAULTS = { enabled: false, windowName: 'Overwatch', profileId: 'default-1080p', intervalMs: 500 };

function normalizeSettings(s = {}) {
  return {
    enabled: Boolean(s.enabled),
    windowName: String(s.windowName || DEFAULTS.windowName).slice(0, 120),
    profileId: String(s.profileId || DEFAULTS.profileId),
    intervalMs: Math.max(200, Math.min(5000, Math.round(Number(s.intervalMs) || DEFAULTS.intervalMs)))
  };
}

class OverwatchOcrService {
  constructor({ capture, ocr, onState = () => {}, onStatus = () => {}, now = () => Date.now() } = {}) {
    Object.assign(this, { capture, ocr, onState, onStatus, now });
    this.settings = normalizeSettings();
    this.board = emptyBoard();
    this.consensus = new OverwatchConsensus();
    this.status = { state: 'disabled', message: 'Overwatch OCR is off', sweepMs: 0, sweeps: 0 };
    this.timer = null;
    this.running = false;
  }

  configure(next = {}) {
    const before = this.settings;
    this.settings = normalizeSettings({ ...before, ...next });
    if (before.profileId !== this.settings.profileId) this.clear();
    if (this.settings.enabled) this.start(); else this.stop();
    return this.getStatus();
  }

  getStatus() { return { ...this.status, settings: this.settings }; }

  setStatus(state, message, extra = {}) {
    this.status = { ...this.status, state, message, ...extra };
    this.onStatus(this.getStatus());
  }

  start() {
    if (this.timer) return;
    if (!this.capture || !this.ocr) { this.setStatus('error', 'Capture or OCR engine is unavailable'); return; }
    this.setStatus('starting', `Looking for the “${this.settings.windowName}” window`);
    const loop = async () => {
      if (!this.settings.enabled) return;
      const started = this.now();
      try { await this.sweep(); } catch (error) { this.setStatus('error', error.message || String(error)); }
      const wait = Math.max(0, this.settings.intervalMs - (this.now() - started));
      this.timer = setTimeout(loop, wait);
      this.timer.unref?.();
    };
    this.timer = setTimeout(loop, 0);
  }

  stop() {
    clearTimeout(this.timer); this.timer = null;
    if (this.status.state !== 'disabled') this.setStatus('disabled', 'Overwatch OCR is off');
  }

  clear() {
    this.board = emptyBoard();
    this.consensus.reset();
    this.onState(this.snapshot());
  }

  // One full read of the board. Cells are read one after another on the OCR engine's own
  // worker pool; a sweep that overlaps the next tick is skipped, never queued.
  async sweep() {
    if (this.running) return false;
    this.running = true;
    const started = this.now();
    try {
      const frame = await this.capture.capture(this.settings.windowName);
      const profile = getProfile(this.settings.profileId);
      const reads = [];
      for (const cell of cellRois(profile)) {
        reads.push({ side: cell.side, row: cell.row, field: cell.field, value: await this.readCell(frame, profile, cell) });
      }
      // READY: no number in the middle and a full ring.
      if (typeof this.capture.luminance === 'function') {
        const ring = profile.ultimateRing;
        for (const team of profile.teams) team.rowCenters.forEach((cy, row) => {
          const read = reads.find((r) => r.side === team.id && r.row === row && r.field === 'ultimate');
          if (read.value !== null) return;
          read.value = resolveUltimate(null, ringFill((x, y) => this.capture.luminance(frame, x, y), ring.cx, cy + ring.dy, ring.radius));
        });
      }
      const changed = applySweep(this.board, this.consensus, reads, this.now());
      const seen = reads.filter((r) => r.value !== null).length;
      this.setStatus(seen ? 'reading' : 'no-board', seen ? `Reading ${seen}/${reads.length} cells` : 'Window found but no scoreboard visible (is Tab open on this spectator?)', { sweepMs: this.now() - started, sweeps: (this.status.sweeps || 0) + 1, lastSweepAt: this.now() });
      if (changed) this.onState(this.snapshot());
      return changed;
    } finally { this.running = false; }
  }

  async readCell(frame, profile, cell) {
    const kind = cell.field === 'name' ? 'text' : 'score';
    const base = { ...profile.preprocess, allowedChars: cell.column.allowedChars };
    const attempt = async (preprocess, mode) => {
      const crop = this.capture.crop(frame, cell.roi, preprocess);
      const result = await this.ocr.recognize(crop.image, { allowedChars: cell.column.allowedChars, kind, fieldId: `overwatch-${cell.side}-${cell.row}-${cell.field}`, pageMode: mode });
      return result.confidence >= 0.3 ? parseCell(cell.field, result.text) : null;
    };
    let value = await attempt(base);
    // Lone digits get dropped in line mode; retry as a single character at a couple of scales.
    if (value === null && kind === 'score') {
      for (const scale of [4, 6]) { value = await attempt({ ...base, scale }, 'char'); if (value !== null) break; }
    }
    return value;
  }

  snapshot() { return { ...this.board, status: this.getStatus() }; }

  async shutdown() { this.stop(); }
}

module.exports = { OverwatchOcrService, normalizeSettings, DEFAULTS };
