const { WebSocket } = require('ws');
const { RocketLeagueService, normalizeSettings } = require('./rocket-league-service.cjs');

class RocketLeagueForwarder {
  constructor({ onStatus = () => {} } = {}) {
    this.onStatus = onStatus;
    this.settings = null;
    this.remote = null;
    this.remoteRetry = null;
    this.source = new RocketLeagueService({
      onEvent: (event) => this.forward(event),
      onStatus: (status) => this.report({ source: status })
    });
    this.remoteStatus = { state: 'disabled', message: 'Not connected' };
  }

  start(settings = {}) {
    this.stop();
    this.settings = {
      ...normalizeSettings({ ...settings, enabled: true, source: 'local' }),
      graphicsHost: String(settings.graphicsHost || '').trim()
    };
    if (!this.settings.graphicsHost || !this.settings.bridgeToken) {
      this.remoteStatus = { state: 'error', message: 'Graphics PC address and bridge key are required' };
      return this.report();
    }
    // Forward every state update the game makes available. The Graphics PC
    // applies the operator-selected display interval without reconnecting.
    this.source.configure({ ...this.settings, updateIntervalMs: 1 });
    this.connectRemote();
  }

  stop() {
    clearTimeout(this.remoteRetry);
    this.remoteRetry = null;
    this.source.stop();
    if (this.remote) {
      this.remote.removeAllListeners();
      this.remote.on('error', () => {});
      this.remote.terminate();
      this.remote = null;
    }
  }

  connectRemote() {
    if (!this.settings) return;
    const url = `ws://${this.settings.graphicsHost}:${this.settings.bridgePort}/rocket-league?token=${encodeURIComponent(this.settings.bridgeToken)}`;
    this.remoteStatus = { state: 'connecting', message: `Connecting to ${this.settings.graphicsHost}:${this.settings.bridgePort}` };
    this.report();
    const socket = new WebSocket(url);
    this.remote = socket;
    socket.on('open', () => {
      this.remoteStatus = { state: 'connected', message: 'Connected to Graphics PC' };
      this.report();
    });
    socket.on('error', () => {});
    socket.on('close', (_code, reason) => {
      if (this.remote !== socket) return;
      this.remote = null;
      this.remoteStatus = { state: 'waiting', message: reason?.toString() || 'Graphics PC unavailable; retrying…' };
      this.report();
      this.remoteRetry = setTimeout(() => this.connectRemote(), 3000);
    });
  }

  forward(event) {
    if (this.remote?.readyState === WebSocket.OPEN) this.remote.send(JSON.stringify({ type: 'telemetry', version: 1, event }));
  }

  report(extra = {}) {
    this.onStatus({ remote: this.remoteStatus, ...extra });
  }
}

module.exports = { RocketLeagueForwarder };
