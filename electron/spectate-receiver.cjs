'use strict';
// Graphics PC side of the Game Bridge link for VALORANT / Overwatch spectating (the old VALORANT
// OCR lab used to own this socket). A player-POV spectator PC runs the Game Bridge in
// "track spectated player" mode and connects here with the bridge key. We:
//   - send it the gamertags to look for ('spectate-candidates': rosters + scoreboard names),
//   - receive {type:'spectated'} packets and hand them to onSpectated (-> Companion variables).
// Rocket League doesn't use this: its Stats API names the spectated player directly.
const { WebSocketServer } = require('ws');
const { BRIDGE_MAX_PAYLOAD, bridgeKeyMatches, keepAlive } = require('./bridge-link.cjs');

const DEFAULTS = { enabled: false, port: 3175, token: '' };
function normalizeSettings(s = {}) {
  const port = Math.round(Number(s.port));
  return { enabled: Boolean(s.enabled), port: port >= 1024 && port <= 65535 ? port : DEFAULTS.port, token: String(s.token || '').trim().slice(0, 200) };
}

class SpectateReceiver {
  constructor({ onSpectated = () => {}, onStatus = () => {}, now = () => Date.now() } = {}) {
    Object.assign(this, { onSpectated, onStatus, now });
    this.settings = normalizeSettings();
    this.server = null; this.clients = new Set(); this.candidates = []; this.sides = null;
    this.status = { state: 'disabled', message: 'Spectated-player receiver is off', clients: 0 };
  }

  setStatus(state, message) { this.status = { state, message, clients: this.clients.size, port: this.settings.port }; this.onStatus(this.getStatus()); }
  getStatus() { return { ...this.status, settings: { ...this.settings, token: this.settings.token ? '(set)' : '' } }; }

  configure(next = {}) {
    const before = this.settings;
    this.settings = normalizeSettings({ ...before, ...next });
    const restart = !this.server || before.port !== this.settings.port || before.token !== this.settings.token || !this.settings.enabled;
    if (restart) this.stop();
    if (this.settings.enabled && !this.server) this.start();
    if (!this.settings.enabled) this.setStatus('disabled', 'Spectated-player receiver is off');
    return this.getStatus();
  }

  start() {
    if (!this.settings.token) { this.setStatus('error', 'Generate a bridge key first'); return; }
    try { this.server = new WebSocketServer({ host: '0.0.0.0', port: this.settings.port, maxPayload: BRIDGE_MAX_PAYLOAD }); }
    catch (error) { this.server = null; this.setStatus('error', error.message); return; }
    this.server.on('listening', () => this.setStatus('listening', `Waiting for the spectator Game Bridge on port ${this.settings.port}`));
    this.server.on('error', (error) => this.setStatus('error', `Port ${this.settings.port}: ${error.code || error.message}`));
    this.server.on('connection', (client, request) => {
      const url = new URL(request.url, `ws://${request.headers.host || 'localhost'}`);
      if (!bridgeKeyMatches(this.settings.token, url.searchParams.get('token'))) { client.close(1008, 'Invalid bridge key'); return; }
      this.clients.add(client); keepAlive(client);
      this.setStatus('connected', 'Spectator Game Bridge connected');
      if (this.candidates.length) client.send(JSON.stringify({ type: 'spectate-candidates', candidates: this.candidates, sides: this.sides || null }));
      client.on('message', (raw) => {
        try {
          const packet = JSON.parse(String(raw));
          if (packet.type === 'spectated' && packet.payload && typeof packet.payload === 'object') this.onSpectated({ ...packet.payload, game: packet.game || '', receivedAt: this.now() });
        } catch {}
      });
      client.on('close', () => { this.clients.delete(client); this.setStatus('listening', `Spectator Game Bridge disconnected; waiting on port ${this.settings.port}`); });
      client.on('error', () => {});
      client.send(JSON.stringify({ type: 'welcome', version: 1 }));
    });
  }

  stop() {
    for (const c of this.clients) { try { c.close(); } catch {} }
    this.clients.clear();
    try { this.server?.close(); } catch {}
    this.server = null;
  }

  // Names the tracker may report, pushed to every connected bridge when they change.
  // sides: { red: 'home'|'away', teal: 'home'|'away', round } = which team has which colour now.
  setCandidates(list = [], sides = null) {
    const next = (Array.isArray(list) ? list : []).filter((c) => c && String(c.name || '').trim()).slice(0, 40)
      .map((c) => ({ name: String(c.name).trim().slice(0, 40), station: Number(c.station) || null, side: c.side === 'away' ? 'away' : c.side === 'home' ? 'home' : '', team: String(c.team || '').slice(0, 60), agent: String(c.agent || '').replace(/[^a-z0-9-]/g, '').slice(0, 20) }));
    const nextSides = sides && ['home', 'away'].includes(sides.red) ? { red: sides.red, teal: sides.teal, round: Number(sides.round) || 0 } : null;
    if (JSON.stringify(next) === JSON.stringify(this.candidates) && JSON.stringify(nextSides) === JSON.stringify(this.sides)) return next.length;
    this.candidates = next; this.sides = nextSides;
    for (const client of this.clients) { try { client.send(JSON.stringify({ type: 'spectate-candidates', candidates: next, sides: nextSides })); } catch {} }
    return next.length;
  }
}

module.exports = { SpectateReceiver, normalizeSettings };
