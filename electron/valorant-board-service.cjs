'use strict';
// VALORANT scoreboard OCR, rebuilt like the Overwatch one (2026-10-07). Observer 3 keeps the
// Tab scoreboard open; every sweep grabs that window, finds the board (auto-align), reads each
// cell (name, ult, K/D/A, creds, ping), matches agents, guns and shields, and passes it all
// through a consensus gate so one bad read never shows. Uses the shared window capture and
// Tesseract engine. The controller writes the result to state.games.valorant.valorantBoard.
const os = require('node:os');
const { HudReader } = require('./valorant-hud-reader.cjs');
const { PROFILE, SIDES, alignBoard, cellRois, readCell, AgentMatcher, GearMatcher, BoardConsensus, emptyBoard, applySweep } = require('./valorant-board-parse.cjs');

const DEFAULT_WORKERS = Math.max(2, Math.min(8, Math.floor((os.cpus()?.length || 4) / 2)));
const DEFAULTS = { enabled: false, windowName: 'VALORANT', intervalMs: 500, workers: DEFAULT_WORKERS };

function normalizeSettings(s = {}) {
  return {
    enabled: Boolean(s.enabled),
    windowName: String(s.windowName || DEFAULTS.windowName).slice(0, 120),
    intervalMs: Math.max(200, Math.min(5000, Math.round(Number(s.intervalMs) || DEFAULTS.intervalMs))),
    workers: Math.max(1, Math.min(16, Math.round(Number(s.workers) || DEFAULTS.workers)))
  };
}

class ValorantBoardService {
  constructor({ capture, ocr, onState = () => {}, onStatus = () => {}, now = () => Date.now() } = {}) {
    Object.assign(this, { capture, ocr, onState, onStatus, now });
    this.settings = normalizeSettings();
    this.board = emptyBoard();
    this.consensus = new BoardConsensus();
    this.status = { state: 'disabled', message: 'VALORANT scoreboard OCR is off', sweepMs: 0, sweeps: 0 };
    this.timer = null; this.running = false; this.nameOverrides = new Map();
    try { this.agents = new AgentMatcher(); } catch (error) { this.agents = null; this.agentError = error.message; }
    try { this.gear = new GearMatcher(); } catch (error) { this.gear = null; this.gearError = error.message; }
    // Top HUD: round score + round timer (replaces the old OCR lab). Score needs 2 matching
    // reads in a row; the timer is passed through as read (null = spike planted / not sure).
    try { this.hud = new HudReader(); } catch (error) { this.hud = null; this.hudError = error.message; }
    this.match = { homeScore: null, awayScore: null, timer: null, spikePlanted: false, updatedAt: 0 };
    this.scoreVotes = { home: [], away: [] };
  }

  configure(next = {}) {
    const before = this.settings;
    this.settings = normalizeSettings({ ...before, ...next });
    if (this.settings.enabled) this.start(); else this.stop();
    return this.getStatus();
  }

  getStatus() { return { ...this.status, settings: this.settings }; }
  setStatus(state, message, extra = {}) { this.status = { ...this.status, state, message, ...extra }; this.onStatus(this.getStatus()); }

  start() {
    if (this.timer) return;
    if (!this.capture || !this.ocr) { this.setStatus('error', 'Capture or OCR engine is unavailable'); return; }
    this.setStatus('starting', `Looking for the "${this.settings.windowName}" window`);
    const loop = async () => {
      if (!this.settings.enabled) return;
      const started = this.now();
      try { await this.sweep(); } catch (error) { this.setStatus('error', error.message || String(error)); }
      this.timer = setTimeout(loop, Math.max(0, this.settings.intervalMs - (this.now() - started)));
    };
    this.timer = setTimeout(loop, 0);
  }

  stop() {
    clearTimeout(this.timer); this.timer = null;
    if (!this.settings.enabled) this.setStatus('disabled', 'VALORANT scoreboard OCR is off');
  }

  clear() {
    this.match = { homeScore: null, awayScore: null, timer: null, spikePlanted: false, updatedAt: 0 };
    this.scoreVotes = { home: [], away: [] }; this.board = emptyBoard(); this.consensus = new BoardConsensus(); this.nameOverrides = new Map(); this.onState(this.snapshot()); }

  // Operator-set name for one slot; wins over OCR until cleared (empty name).
  setPlayerName({ side, row, name } = {}) {
    if (!SIDES.includes(side)) throw new Error('side must be home or away');
    const r = Math.round(Number(row)); if (!(r >= 0 && r <= 4)) throw new Error('row must be 0-4');
    const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 32);
    const player = this.board.teams[side].players[r];
    if (clean) { this.nameOverrides.set(`${side}:${r}`, clean); player.name = clean; } else { this.nameOverrides.delete(`${side}:${r}`); player.name = ''; }
    player.nameManual = Boolean(clean); player.updatedAt = this.now(); this.board.updatedAt = this.now();
    this.onState(this.snapshot());
    return this.snapshot();
  }

  checkFrame(frame) {
    const w = Number(frame?.width); const h = Number(frame?.height);
    if ((w || h) && (w !== PROFILE.width || h !== PROFILE.height)) throw new Error(`Captured frame is ${w}x${h}; the board reader needs a 16:9 window (scaled to 1920x1080)`);
  }

  // Builds the OCR input for one box: bright text -> black on white, scaled up.
  makeImage(frame) { return (roi, scale, threshold) => this.capture.crop(frame, roi, { scale, threshold, invert: true, grayscale: true }).image; }

  async sweep() {
    if (this.running) return false;
    this.running = true; const started = this.now();
    try {
      const frame = await this.capture.capture(this.settings.windowName);
      this.checkFrame(frame);
      if (typeof this.capture.luminance !== 'function') throw new Error('Capture has no pixel access');
      const lum = (x, y) => this.capture.luminance(frame, x, y);
      const rgb = typeof this.capture.rgb === 'function' ? (x, y) => this.capture.rgb(frame, x, y) : null;
      // Top HUD first: score and timer are visible with or without the Tab board.
      const matchChanged = this.readHud(lum);
      const align = alignBoard(lum);
      this.lastAlign = align;
      if (!align.found) { if (matchChanged) this.onState(this.snapshot()); this.setStatus('no-board', 'Window found but no scoreboard visible (is Tab open on Observer 3?)', { sweepMs: this.now() - started, sweeps: (this.status.sweeps || 0) + 1 }); return false; }
      const cells = cellRois(PROFILE, align).filter((c) => !(c.field === 'name' && this.nameOverrides.has(`${c.side}:${c.row}`)));
      this.ocr.observerConcurrency = this.settings.workers;
      const reads = new Array(cells.length); let next = 0; const make = this.makeImage(frame);
      const lane = async () => { while (next < cells.length) { const i = next++; const c = cells[i]; reads[i] = { side: c.side, row: c.row, field: c.field, value: await readCell(this.ocr, lum, c, make, `observer3-${c.side}-${c.row}-${c.field}`) }; } };
      await Promise.all(Array.from({ length: Math.min(this.settings.workers, cells.length) }, lane));
      // Icons: agent (colour match), gun + shield (silhouettes). null = not sure, never a guess.
      for (const side of SIDES) for (let row = 0; row < 5; row += 1) {
        const cy = align.rows[`${side}:${row}`].cy;
        if (this.agents && rgb) reads.push({ side, row, field: 'agent', value: this.agents.match(rgb, PROFILE.columns.agent.x + 16 + align.dx, cy).agent });
        if (this.gear) {
          const L = PROFILE.columns.loadout; const S = PROFILE.columns.shield;
          reads.push({ side, row, field: 'weapon', value: this.gear.weapon(lum, { x: L.x + align.dx, y: cy - 12, w: L.w, h: 24 }).weapon });
          reads.push({ side, row, field: 'shield', value: this.gear.shield(lum, S.x + align.dx, S.x + S.w + align.dx, cy).shield });
        }
      }
      const changed = applySweep(this.board, this.consensus, reads, this.now());
      const seen = reads.filter((r) => r.value !== null).length;
      this.setStatus('reading', `Reading ${seen}/${reads.length} cells · board ${align.dx >= 0 ? '+' : ''}${align.dx}/${align.dy >= 0 ? '+' : ''}${align.dy} px`, { sweepMs: this.now() - started, sweeps: (this.status.sweeps || 0) + 1, lastSweepAt: this.now() });
      if (changed || matchChanged) this.onState(this.snapshot());
      return changed || matchChanged;
    } finally { this.running = false; }
  }

  readHud(lum) {
    if (!this.hud) return false;
    const r = this.hud.read(lum);
    const before = JSON.stringify(this.match);
    for (const side of ['home', 'away']) {
      const v = r[`${side}Score`]; const votes = this.scoreVotes[side];
      votes.push(v); if (votes.length > 2) votes.shift();
      if (v !== null && votes.length === 2 && votes[0] === v) this.match[`${side}Score`] = v;
    }
    // Score digits visible but no timer digits = the spike icon is up.
    this.match.timer = r.timer;
    this.match.spikePlanted = !r.timer && r.homeScore !== null && r.awayScore !== null;
    if (JSON.stringify(this.match) !== before) { this.match.updatedAt = this.now(); return true; }
    return false;
  }

  snapshot() { return { ...JSON.parse(JSON.stringify(this.board)), match: { ...this.match }, status: this.getStatus(), align: this.lastAlign ? { dx: this.lastAlign.dx, dy: this.lastAlign.dy, found: this.lastAlign.found } : null }; }
  async shutdown() { this.settings.enabled = false; this.stop(); }
}

module.exports = { ValorantBoardService, normalizeSettings, DEFAULTS };
