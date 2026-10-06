'use strict';
// Overwatch scoreboard OCR: one spectator (Observer 3) keeps the Tab scoreboard open; this
// service grabs that window, reads every cell (ult %, E/A/D, damage, healing, mitigation,
// names), passes each read through OverwatchConsensus and emits a structured board.
//
// It reuses the VALORANT capture (window capture + crop/preprocess) and Tesseract engine, so
// there is one capture stack to maintain. The controller writes the result into
// state.games.overwatch.overwatchOcr.live; overlays read it from there. Manual (Companion)
// scores keep working; OCR only fills the player stats.
const os = require('node:os');
const { HeroMatcher } = require('./overwatch-hero-match.cjs');
const { STAT_FIELDS, getProfile, cellRois, alignBoard, parseCell, glyphCount, plausibleRead, ringFill, isReadyDisc, resolveUltimate, OverwatchConsensus, emptyBoard, applySweep } = require('./overwatch-ocr-parse.cjs');

// Default OCR workers: half the CPU cores, 2..8 (each Tesseract worker is one thread).
const DEFAULT_WORKERS = Math.max(2, Math.min(8, Math.floor((os.cpus()?.length || 4) / 2)));
const DEFAULTS = { enabled: false, windowName: 'Overwatch', profileId: 'default-1080p', intervalMs: 500, workers: DEFAULT_WORKERS };
// Minimum Tesseract confidence for a stat. 0.3 let noise through (random 20 / 139 / 421 on an
// all-zero board); digit reads on this board come back at 0.8-0.96.
const MIN_CONFIDENCE = { score: 0.75, text: 0.6 };

function normalizeSettings(s = {}) {
  return {
    enabled: Boolean(s.enabled),
    windowName: String(s.windowName || DEFAULTS.windowName).slice(0, 120),
    profileId: String(s.profileId || DEFAULTS.profileId),
    intervalMs: Math.max(200, Math.min(5000, Math.round(Number(s.intervalMs) || DEFAULTS.intervalMs))),
    workers: Math.max(1, Math.min(16, Math.round(Number(s.workers) || DEFAULTS.workers))),
    autoAlign: s.autoAlign !== false, // follow rows/names that drives & icons push around
    // Board view: 'auto' (find it from the header bar), 'spectator' (Observer, board centred),
    // 'player' (testing from inside a lobby: your own stat card is on the right and the board
    // sits ~280 px left).
    view: ['auto', 'spectator', 'player'].includes(s.view) ? s.view : 'auto'
  };
}

// Known layouts when the header bar can't be read (offsets from Derk's screenshots 2026-10-06).
function viewFallback(profile, view) {
  const base = Object.fromEntries(STAT_FIELDS.map((f) => [f, Math.round(profile.columns[f].x + profile.columns[f].w / 2)]));
  if (view === 'player') return { view, leftDx: -282, cols: Object.fromEntries(Object.entries(base).map(([f, x]) => [f, x - 183])), forced: true };
  return { view, leftDx: 0, cols: null, forced: true };
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
    // Hero recognition from the portrait column; templates load once. If they are missing the
    // board still reads, just without heroes.
    try { this.heroMatcher = new HeroMatcher(); } catch (error) { this.heroMatcher = null; this.heroError = error.message; }
  }

  // One hero read per row (needs capture.rgb). null = not confident, never a guess.
  readHeroes(frame, profile, align = this.lastAlign) {
    if (!this.heroMatcher || typeof this.capture.rgb !== 'function') return [];
    const shift = align?.leftDx || 0; // perks move the portrait column left
    const rgbAt = (x, y) => this.capture.rgb(frame, x + shift, y);
    const reads = [];
    for (const team of profile.teams) team.rowCenters.forEach((cy, row) => {
      const dy = align?.rows?.[`${team.id}:${row}`]?.statDy || 0;
      const m = this.heroMatcher.match(rgbAt, cy + (Math.abs(dy) >= 3 ? dy : 0));
      reads.push({ side: team.id, row, field: 'hero', value: m.hero, match: m });
    });
    return reads;
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
    this.nameOverrides = new Map();
    this.onState(this.snapshot());
  }

  // Operator-set player name for one board slot (side 'home'|'away', row 0-4). Wins over OCR
  // until cleared (empty name) or the board is cleared; OCR keeps reading every other field.
  setPlayerName({ side, row, name } = {}) {
    if (!['home', 'away'].includes(side)) throw new Error('side must be home or away');
    const r = Math.round(Number(row));
    if (!(r >= 0 && r <= 4)) throw new Error('row must be 0-4');
    const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
    this.nameOverrides = this.nameOverrides || new Map();
    const key = `${side}:${r}`;
    const player = this.board.teams[side].players[r];
    if (clean) { this.nameOverrides.set(key, clean); player.name = clean; }
    else { this.nameOverrides.delete(key); player.name = ''; }
    player.nameManual = Boolean(clean);
    player.updatedAt = this.now();
    this.board.updatedAt = this.now();
    this.onState(this.snapshot());
    return this.snapshot();
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
      this.checkFrame(frame, profile);
      // Auto-align: find where the rows/names really are (drives push names up, icons nudge
      // columns) and move the boxes there. A clean board gives ~0 shifts.
      const align = this.settings.autoAlign !== false && typeof this.capture.luminance === 'function'
        ? alignBoard((x, y) => this.capture.luminance(frame, x, y), profile, typeof this.capture.rgb === 'function' ? (x, y) => this.capture.rgb(frame, x, y) : null) : null;
      if (align && this.settings.view !== 'auto' && align.view !== this.settings.view) {
        // Forced view but the header wasn't read: use that view's known offsets.
        Object.assign(align, viewFallback(profile, this.settings.view));
      }
      this.lastAlign = align;
      const cells = cellRois(profile, align);
      // Read cells in parallel across the OCR engine's worker pool (one CPU core per worker).
      this.ocr.observerConcurrency = this.settings.workers;
      const reads = new Array(cells.length);
      let next = 0;
      const lane = async () => {
        while (next < cells.length) {
          const i = next++; const cell = cells[i];
          reads[i] = { side: cell.side, row: cell.row, field: cell.field, value: await this.readCell(frame, profile, cell) };
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.settings.workers, cells.length) }, lane));
      // READY: the ring turns into a solid disc with a check mark (no number). The disc check
      // wins over any digits OCR may "see" in the check mark.
      if (typeof this.capture.luminance === 'function') {
        const ring = profile.ultimateRing;
        const lum = (x, y) => this.capture.luminance(frame, x, y);
        for (const team of profile.teams) team.rowCenters.forEach((cy0, row) => {
          const dy = align?.rows?.[`${team.id}:${row}`]?.statDy || 0;
          const cy = cy0 + (Math.abs(dy) >= 3 ? dy : 0); // same rule as the boxes: ignore 1-2 px wiggle
          const read = reads.find((r) => r.side === team.id && r.row === row && r.field === 'ultimate');
          const rcx = ring.cx + (align?.leftDx || 0);
          if (process.env.OW_DEBUG_ULT) console.log('ULT', team.id, row, 'cy', cy, 'rcx', rcx, 'ocr', read.value, 'ready', isReadyDisc(lum, rcx, cy + ring.dy, ring.readyRadius || 12), 'fill', ringFill(lum, rcx, cy + ring.dy, ring.radius));
          if (isReadyDisc(lum, rcx, cy + ring.dy, ring.readyRadius || 12)) { read.value = 'READY'; return; }
          if (read.value !== null) return;
          read.value = resolveUltimate(null, ringFill(lum, rcx, cy + ring.dy, ring.radius));
        });
      }
      // Heroes change rarely (spawn room / death): match the portraits ~once a second (65 ms
      // for all ten), not every sweep.
      if (!this.lastHeroAt || this.now() - this.lastHeroAt >= 900) { reads.push(...this.readHeroes(frame, profile)); this.lastHeroAt = this.now(); }
      // Manually named slots: drop the OCR name read so it can never overwrite the operator.
      const overrides = this.nameOverrides || new Map();
      const filtered = overrides.size ? reads.filter((r) => !(r.field === 'name' && overrides.has(`${r.side}:${r.row}`))) : reads;
      const changed = applySweep(this.board, this.consensus, filtered, this.now());
      const seen = reads.filter((r) => r.value !== null).length;
      const layout = align ? ` · ${align.view === 'player' ? 'player view (own stat card)' : align.view === 'spectator' ? 'spectator view' : 'layout not found, default boxes'}${align.perks ? ' · perks' : ''}` : '';
      this.setStatus(seen ? 'reading' : 'no-board', seen ? `Reading ${seen}/${reads.length} cells${layout}` : 'Window found but no scoreboard visible (is Tab open on this spectator?)', { sweepMs: this.now() - started, sweeps: (this.status.sweeps || 0) + 1, lastSweepAt: this.now() });
      if (changed) this.onState(this.snapshot());
      return changed;
    } finally { this.running = false; }
  }

  // The profile is on the 1920x1080 grid; the capture must hand us a frame on that grid
  // (capture normalizes any 16:9 source). Anything else would put every box on the wrong pixels.
  checkFrame(frame, profile) {
    const w = Number(frame?.width); const h = Number(frame?.height);
    if ((w || h) && (w !== profile.width || h !== profile.height)) {
      throw new Error(`Captured frame is ${w}x${h} but the OCR boxes are for ${profile.width}x${profile.height}; use a 16:9 window`);
    }
  }

  async readCell(frame, profile, cell) {
    const kind = cell.field === 'name' ? 'text' : 'score';
    const base = { ...profile.preprocess, allowedChars: cell.column.allowedChars, ...(cell.column.shear ? { shear: cell.column.shear } : {}), ...(cell.column.threshold ? { threshold: cell.column.threshold } : {}) };
    // Digit count straight from the pixels: 0 = empty cell (never read a number into it),
    // otherwise the OCR text must have exactly that many digits.
    const glyphs = kind === 'score' && typeof this.capture.luminance === 'function'
      ? glyphCount((x, y) => this.capture.luminance(frame, x, y), cell.roi) : NaN;
    if (glyphs === 0) return null;
    const attempt = async (preprocess, mode) => {
      const crop = this.capture.crop(frame, cell.roi, preprocess);
      const result = await this.ocr.recognize(crop.image, { allowedChars: cell.column.allowedChars, kind, fieldId: `overwatch-${cell.side}-${cell.row}-${cell.field}`, pageMode: mode });
      if (result.confidence < MIN_CONFIDENCE[kind]) return null;
      return plausibleRead(cell.field, parseCell(cell.field, result.text), glyphs);
    };
    let value = await attempt(base);
    // Lone digits get dropped in line mode; retry as a single character at a couple of scales.
    if (value === null && kind === 'score' && glyphs === 1) {
      for (const scale of [4, 6]) { value = await attempt({ ...base, scale }, 'char'); if (value !== null) break; }
    }
    return value;
  }

  // Debug capture: the full frame plus every cell's raw crop, the processed (binarized) image
  // the OCR sees, the glyph count and what was read, so a misread can be traced to its cause.
  async debugCapture() {
    if (!this.capture) throw new Error('Capture service is unavailable');
    const frame = await this.capture.capture(this.settings.windowName);
    const profile = getProfile(this.settings.profileId);
    this.checkFrame(frame, profile);
    const lum = typeof this.capture.luminance === 'function' ? (x, y) => this.capture.luminance(frame, x, y) : null;
    const cells = [];
    const align = this.settings.autoAlign !== false && lum ? alignBoard(lum, profile, typeof this.capture.rgb === 'function' ? (x, y) => this.capture.rgb(frame, x, y) : null) : null;
    for (const cell of cellRois(profile, align)) {
      const crop = this.capture.crop(frame, cell.roi, { ...profile.preprocess, allowedChars: cell.column.allowedChars, ...(cell.column.shear ? { shear: cell.column.shear } : {}), ...(cell.column.threshold ? { threshold: cell.column.threshold } : {}) });
      const result = await this.ocr.recognize(crop.image, { allowedChars: cell.column.allowedChars, kind: cell.field === 'name' ? 'text' : 'score', fieldId: `overwatch-${cell.side}-${cell.row}-${cell.field}` });
      cells.push({
        side: cell.side, row: cell.row, field: cell.field, roi: cell.roi,
        rawDataUrl: crop.rawDataUrl || '', processedDataUrl: crop.processedDataUrl || '',
        text: String(result.text || '').trim(), confidence: Math.round((result.confidence || 0) * 100),
        glyphs: cell.field === 'name' || !lum ? null : glyphCount(lum, cell.roi),
        accepted: cell.field === 'ultimate' && lum && isReadyDisc(lum, profile.ultimateRing.cx + (align?.leftDx || 0), cell.roi.y + Math.round(cell.roi.h / 2) + profile.ultimateRing.dy, profile.ultimateRing.readyRadius || 12)
          ? 'READY' : await this.readCell(frame, profile, cell)
      });
    }
    const heroes = this.readHeroes(frame, profile, align).map((r) => ({ side: r.side, row: r.row, hero: r.value, candidate: r.match.candidate, score: r.match.score, runnerUp: r.match.runnerUp }));
    return {
      heroes, align,
      capturedAt: this.now(), sourceName: frame.sourceName || '', backend: frame.backend || '',
      width: frame.width, height: frame.height, sourceWidth: frame.sourceWidth || frame.width, sourceHeight: frame.sourceHeight || frame.height,
      frameDataUrl: frame.image?.toDataURL ? frame.image.toDataURL() : '', cells
    };
  }

  snapshot() { return { ...this.board, status: this.getStatus() }; }

  async shutdown() { this.stop(); }
}

module.exports = { OverwatchOcrService, normalizeSettings, DEFAULTS, MIN_CONFIDENCE };
