const { WebSocket } = require('ws');
const { keepAlive } = require('./bridge-link.cjs');
const { RocketLeagueService, normalizeSettings: normalizeRocketLeagueSettings } = require('./rocket-league-service.cjs');
const { SpectateTracker, DEFAULT_ROIS: SPECTATE_ROIS, DEFAULT_PORTRAITS } = require('./spectate-tracker.cjs');
let AgentMatcher = null; try { ({ AgentMatcher } = require('./valorant-board-parse.cjs')); } catch {}

const SUPPORTED_GAMES = Object.freeze(['rocketleague', 'valorant', 'overwatch']);

function safePort(value, fallback = 3175) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

function normalizeBridgeSettings(settings = {}) {
  const game = SUPPORTED_GAMES.includes(settings.game) ? settings.game : 'rocketleague';
  return {
    ...settings,
    game,
    graphicsHost: String(settings.graphicsHost || '').trim(),
    bridgePort: safePort(settings.bridgePort),
    bridgeToken: String(settings.bridgeToken || '').trim(),
    rocketLeague: normalizeRocketLeagueSettings({ ...(settings.rocketLeague || settings), enabled: true, source: 'local' }),
    // VALORANT: the scoreboard is read on the Graphics PC (scoreboard reader); on a Game PC the
    // bridge only tracks the spectated player (player-POV spectator), so it is always on there.
    spectate: { ...normalizeSpectateSettings(settings.spectate, game), enabled: game !== 'rocketleague' }
  };
}

function normalizeSpectateSettings(raw = {}, game = 'valorant') {
  const def = SPECTATE_ROIS[game] || SPECTATE_ROIS.valorant;
  const r = raw?.roi || {};
  const n = (v, d, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number.isFinite(Number(v)) ? Number(v) : d)));
  return {
    enabled: Boolean(raw?.enabled),
    // Off = the normal scoreboard OCR; on = THIS PC watches player POVs and only tracks the name.
    windowName: String(raw?.windowName || (game === 'valorant' ? 'VALORANT' : game === 'overwatch' ? 'Overwatch' : 'Rocket League')).slice(0, 120),
    intervalMs: n(raw?.intervalMs, 250, 120, 2000),
    roi: { x: n(r.x, def.x, 0, 1900), y: n(r.y, def.y, 0, 1060), w: n(r.w, def.w, 20, 1920), h: n(r.h, def.h, 10, 300) },
    // Agent portrait square (fast ~1-10 ms read: agent icon + red/teal team box). null = name only.
    portrait: DEFAULT_PORTRAITS[game] ? (() => { const pd = DEFAULT_PORTRAITS[game]; const pr = raw?.portrait || {}; return { x: n(pr.x, pd.x, 0, 1900), y: n(pr.y, pd.y, 0, 1060), s: n(pr.s, pd.s, 20, 300) }; })() : null
  };
}

function createGameEnvelope(game, payload, sequence, capturedAt = Date.now()) {
  return {
    type: game === 'rocketleague' ? 'game-telemetry' : 'game-state',
    game,
    version: 1,
    sequence,
    capturedAt,
    payload
  };
}

class UniversalGameBridge {
  constructor({ capture = null, ocr = null, onStatus = () => {}, onOcrState = () => {}, WebSocketImpl = WebSocket } = {}) {
    this.onStatus = onStatus;
    this.onOcrState = onOcrState;
    this.WebSocketImpl = WebSocketImpl;
    this.settings = null;
    this.remote = null;
    this.remoteRetry = null;
    this.generation = 0;
    this.sequence = 0;
    this.sentPackets = 0;
    this.remoteStatus = { state: 'disabled', message: 'Not connected' };
    this.sourceStatus = { state: 'disabled', message: 'Game adapter is stopped' };
    this.rocketLeague = new RocketLeagueService({
      onEvent: (event) => this.forward('rocketleague', event),
      onStatus: (status) => this.reportSource(status)
    });
    this.capture = capture;
    this.ocr = ocr;
    // Agent icons for the fast portrait read (VALORANT); missing = name OCR only.
    let agents = null; try { agents = AgentMatcher ? new AgentMatcher() : null; } catch {}
    this.spectate = new SpectateTracker({ ocr, agents });
    this.spectateTimer = null;
    this.spectateStatus = { state: 'off', message: 'Spectated-player tracking is off' };
  }

  start(settings = {}) {
    this.stop();
    this.settings = normalizeBridgeSettings(settings);
    this.sequence = 0;
    this.sentPackets = 0;
    if (!this.settings.graphicsHost || !this.settings.bridgeToken) {
      this.remoteStatus = { state: 'error', message: 'Graphics PC address and bridge key are required' };
      this.report();
      return this.getStatus();
    }
    this.startGameSource();
    this.connectRemote();
    return this.getStatus();
  }

  updateConfig(settings = {}) {
    const previous = this.settings;
    this.settings = normalizeBridgeSettings(settings);
    if (!previous || !previous.graphicsHost || !previous.bridgeToken) return this.getStatus();
    if (previous.game !== this.settings.game || previous.graphicsHost !== this.settings.graphicsHost || previous.bridgePort !== this.settings.bridgePort || previous.bridgeToken !== this.settings.bridgeToken) {
      return this.start(this.settings);
    }
    this.startGameSource();
    return this.getStatus();
  }

  // Normal mode: the game's own adapter (RL Stats API / VALORANT scoreboard OCR). Spectate mode:
  // this PC follows player POVs, so only the spectated-name tracker runs.
  startGameSource() {
    this.stopSpectate();
    // Rocket League reports the spectated player in its API: no OCR tracker there.
    if (this.settings.game !== 'rocketleague') { this.rocketLeague.stop(); this.startSpectate(); return; }
    this.rocketLeague.configure({ ...this.settings.rocketLeague, updateIntervalMs: 1 });
  }

  startSpectate() {
    const generation = this.generation;
    const cfg = this.settings.spectate;
    // Name font: Overwatch = BigNoodle (trained 'ow' model), VALORANT = DIN-like (trained 'val').
    this.spectate.lang = this.settings.game === 'overwatch' ? 'ow' : this.settings.game === 'valorant' ? 'val' : 'eng';
    this.spectate.clear();
    this.spectateStatus = { state: 'starting', message: `Looking for the "${cfg.windowName}" window` };
    this.reportSource(this.spectateStatus);
    const loop = async () => {
      if (generation !== this.generation || !this.settings?.spectate?.enabled) return;
      const started = Date.now();
      try {
        if (!this.capture) throw new Error('Capture is unavailable');
        const frame = await this.capture.capture(cfg.windowName);
        if (frame.width !== 1920 || frame.height !== 1080) throw new Error(`Captured ${frame.width}x${frame.height}; use a 16:9 window`);
        const { changed, spectated } = await this.spectate.sweep((x, y) => this.capture.rgb(frame, x, y), cfg.roi, cfg.portrait);
        if (changed || !this.lastSpectateSentAt || Date.now() - this.lastSpectateSentAt > 2000) {
          this.forwardRaw({ type: 'spectated', game: this.settings.game, version: 1, payload: spectated });
          this.lastSpectateSentAt = Date.now();
        }
        this.onOcrState({ spectate: { ...spectated, last: this.spectate.last } });
        const who = spectated.name ? `Spectating ${spectated.name}${spectated.station ? ` (station ${spectated.station})` : ''}` : (this.spectate.candidates.length ? 'No known player name in the box' : 'Waiting for player names from the controller');
        this.spectateStatus = { state: 'reading', message: `${who} · ${Date.now() - started} ms/read` };
      } catch (error) {
        this.spectateStatus = { state: 'error', message: error.message || String(error) };
      }
      this.reportSource(this.spectateStatus);
      this.spectateTimer = setTimeout(loop, Math.max(0, cfg.intervalMs - (Date.now() - started)));
    };
    this.spectateTimer = setTimeout(loop, 0);
  }

  stopSpectate() { clearTimeout(this.spectateTimer); this.spectateTimer = null; this.spectate.clear(); }

  // Debug: one frame + the name box crop, so the operator can place the box.
  async spectateSnapshot() {
    const cfg = this.settings?.spectate || normalizeSpectateSettings({}, this.settings?.game);
    const frame = await this.capture.capture(cfg.windowName);
    return { frameDataUrl: frame.image?.toDataURL ? frame.image.toDataURL() : '', roi: cfg.roi, width: frame.width, height: frame.height, last: this.spectate.last, capturedAt: Date.now() };
  }

  stop() {
    this.generation += 1;
    clearTimeout(this.remoteRetry);
    this.remoteRetry = null;
    this.rocketLeague.stop();
    this.stopSpectate?.();
    if (this.remote) {
      this.remote.removeAllListeners?.();
      this.remote.on?.('error', () => {});
      this.remote.terminate?.();
      this.remote = null;
    }
  }

  async shutdown() {
    this.stop();
    try { await this.ocr?.close?.(); } catch {}
  }

  connectRemote() {
    if (!this.settings) return;
    const generation = this.generation;
    const query = new URLSearchParams({ token: this.settings.bridgeToken, game: this.settings.game });
    const url = `ws://${this.settings.graphicsHost}:${this.settings.bridgePort}/game-bridge?${query}`;
    this.remoteStatus = { state: 'connecting', message: `Connecting to ${this.settings.graphicsHost}:${this.settings.bridgePort}` };
    this.report();
    const socket = new this.WebSocketImpl(url);
    this.remote = socket;
    socket.on('open', () => {
      if (generation !== this.generation) return socket.terminate?.();
      // Detect a dead link (cable pull / Wi-Fi drop) and fall into the normal 3 s reconnect.
      keepAlive(socket);
      this.remoteStatus = { state: 'connected', message: `Connected to Graphics PC for ${this.settings.game === 'valorant' ? 'VALORANT (spectated player)' : this.settings.game === 'overwatch' ? 'Overwatch (spectated player)' : 'Rocket League'}` };
      this.report();
    });
    // The controller sends the names to look for (rosters + scoreboard) whenever they change.
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'spectate-candidates' && Array.isArray(msg.candidates)) { this.spectate.setCandidates(msg.candidates); this.spectate.setSides(msg.sides || null); }
      } catch {}
    });
    socket.on('error', () => {});
    socket.on('close', (_code, reason) => {
      if (this.remote !== socket || generation !== this.generation) return;
      this.remote = null;
      this.remoteStatus = { state: 'waiting', message: reason?.toString() || 'Graphics PC unavailable; retrying…' };
      this.report();
      this.remoteRetry = setTimeout(() => this.connectRemote(), 3000);
    });
  }

  forward(game, payload) {
    if (this.settings?.game !== game || this.remote?.readyState !== this.WebSocketImpl.OPEN) return false;
    const packet = createGameEnvelope(game, payload, ++this.sequence);
    this.remote.send(JSON.stringify(packet));
    this.sentPackets += 1;
    return true;
  }

  forwardRaw(packet) {
    if (this.remote?.readyState !== this.WebSocketImpl.OPEN) return false;
    this.remote.send(JSON.stringify({ ...packet, sequence: ++this.sequence, capturedAt: Date.now() }));
    this.sentPackets += 1;
    return true;
  }

  reportSource(status = {}) {
    this.sourceStatus = status;
    this.report();
  }

  report() {
    this.onStatus(this.getStatus());
  }

  getStatus() {
    return {
      game: this.settings?.game || 'rocketleague',
      remote: { ...this.remoteStatus, sentPackets: this.sentPackets },
      source: { ...this.sourceStatus }
    };
  }

  async listWindows() {
    if (typeof this.capture?.listWindows === 'function') return this.capture.listWindows();
    return [];
  }

  startSimulator() { return this.rocketLeague.startSimulator(); }

  stopSimulator() {
    if (!this.settings) return null;
    this.rocketLeague.stopSimulator();
    return this.rocketLeague.configure({ ...this.settings.rocketLeague, updateIntervalMs: 1 });
  }
}

module.exports = { SUPPORTED_GAMES, UniversalGameBridge, createGameEnvelope, normalizeBridgeSettings, normalizeSpectateSettings };
