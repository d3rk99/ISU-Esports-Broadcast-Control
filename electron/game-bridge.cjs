const { WebSocket } = require('ws');
const { RocketLeagueService, normalizeSettings: normalizeRocketLeagueSettings } = require('./rocket-league-service.cjs');
const { ValorantOcrService, normalizeSettings: normalizeValorantSettings } = require('./valorant-ocr-service.cjs');

const SUPPORTED_GAMES = Object.freeze(['rocketleague', 'valorant']);

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
    valorant: normalizeValorantSettings({ ...(settings.valorant || settings), enabled: true, source: 'local' })
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
    this.valorant = new ValorantOcrService({
      capture,
      ocr,
      onState: (state) => {
        this.onOcrState(state);
        this.forward('valorant', state);
      },
      onStatus: (status) => this.reportSource(status)
    });
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
    if (this.settings.game === 'valorant') this.valorant.configure(this.settings.valorant);
    else this.rocketLeague.configure({ ...this.settings.rocketLeague, updateIntervalMs: 1 });
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
    if (this.settings.game === 'valorant') this.valorant.configure(this.settings.valorant);
    else this.rocketLeague.configure({ ...this.settings.rocketLeague, updateIntervalMs: 1 });
    return this.getStatus();
  }

  stop() {
    this.generation += 1;
    clearTimeout(this.remoteRetry);
    this.remoteRetry = null;
    this.rocketLeague.stop();
    this.valorant.stop();
    if (this.remote) {
      this.remote.removeAllListeners?.();
      this.remote.on?.('error', () => {});
      this.remote.terminate?.();
      this.remote = null;
    }
  }

  async shutdown() {
    this.stop();
    await this.valorant.shutdown();
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
      this.remoteStatus = { state: 'connected', message: `Connected to Graphics PC for ${this.settings.game === 'valorant' ? 'VALORANT' : 'Rocket League'}` };
      this.report();
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

  listWindows() {
    return this.valorant.listWindows();
  }

  captureSnapshot() {
    if (this.settings?.game !== 'valorant') throw new Error('Debug capture is only available in VALORANT mode');
    return this.valorant.captureSnapshot();
  }

  clearOcrState() {
    return this.valorant.clearState();
  }

  startSimulator() {
    if (this.settings?.game === 'valorant') return this.valorant.startSimulator();
    return this.rocketLeague.startSimulator();
  }

  stopSimulator() {
    if (!this.settings) return null;
    if (this.settings.game === 'valorant') this.valorant.stopSimulator();
    else this.rocketLeague.stopSimulator();
    if (this.settings.game === 'valorant') return this.valorant.configure(this.settings.valorant);
    return this.rocketLeague.configure({ ...this.settings.rocketLeague, updateIntervalMs: 1 });
  }
}

module.exports = { SUPPORTED_GAMES, UniversalGameBridge, createGameEnvelope, normalizeBridgeSettings };
