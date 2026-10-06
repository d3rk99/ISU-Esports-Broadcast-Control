'use strict';
// Display Manager (controller side). Stations (display-client PCs) connect over a WebSocket and
// get told ONE of two things:
//   mirror           show this PC's own player monitor (game mirror)
//   ndi <source>     show an NDI source full screen (normally "ISU Stage NN" from OBS)
// What is drawn on the NDI feeds is decided elsewhere (presets -> state.stageObs -> OBS pages).
// Protocol (JSON text frames):
//   client -> hello {station, hostname, version, key, mode, source}
//          -> status {mode, source, state, error, fps}
//   server -> welcome {station} | mode {mode, source}
const crypto = require('node:crypto');
const http = require('node:http');
const { WebSocketServer } = require('ws');

const STATIONS = 10;
const MODES = ['mirror', 'ndi'];
const pad = (n) => String(n).padStart(2, '0');
const defaultSource = (station) => `ISU Stage ${pad(station)}`;

function keyOk(expected, provided) {
  if (!expected) return true;
  const a = Buffer.from(String(expected)); const b = Buffer.from(String(provided || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class DisplayManager {
  constructor({ port = 3178, host = '0.0.0.0', key = '', onStatus = () => {}, now = () => Date.now() } = {}) {
    Object.assign(this, { port, host, key: String(key || ''), onStatus, now });
    this.stations = new Map();
    for (let n = 1; n <= STATIONS; n += 1) this.stations.set(n, this.blank(n));
    this.server = null; this.wss = null; this.error = '';
  }

  blank(n) { return { station: n, online: false, hostname: '', version: '', mode: 'ndi', source: defaultSource(n), state: 'offline', error: '', fps: 0, lastSeen: 0, socket: null }; }

  async start() {
    this.server = http.createServer((_req, res) => { res.writeHead(426); res.end('ISU display manager: WebSocket only'); });
    this.wss = new WebSocketServer({ server: this.server, path: '/display', maxPayload: 64 * 1024 });
    this.wss.on('connection', (socket) => this.accept(socket));
    this.heartbeat = setInterval(() => {
      for (const client of this.wss?.clients || []) { if (client.isAlive === false) { client.terminate(); continue; } client.isAlive = false; try { client.ping(); } catch {} }
    }, 5000);
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.port, this.host, resolve); })
      .catch((error) => { this.error = `Display manager could not open port ${this.port}: ${error.code || error.message}`; });
    if (!this.error) this.port = this.server.address().port;
    this.emit();
  }

  accept(socket) {
    let station = 0;
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('message', (raw) => {
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === 'hello') {
        const n = Math.round(Number(msg.station));
        if (!(n >= 1 && n <= STATIONS)) return socket.close(1008, 'Station must be 1-10');
        if (!keyOk(this.key, msg.key)) return socket.close(4003, 'Display key rejected');
        const current = this.stations.get(n);
        const hostname = String(msg.hostname || '').slice(0, 100);
        if (current.socket && current.socket !== socket && current.socket.readyState === 1 && current.hostname && current.hostname !== hostname) {
          return socket.close(4009, `Station ${n} is already used by ${current.hostname}`);
        }
        if (current.socket && current.socket !== socket) try { current.socket.close(4000, 'Replaced'); } catch {}
        station = n;
        Object.assign(current, { online: true, socket, hostname, version: String(msg.version || '').slice(0, 30), state: 'connected', error: '', lastSeen: this.now() });
        this.send(n, { type: 'welcome', station: n });
        // The controller is the source of truth: push the assigned mode on every (re)connect.
        this.send(n, { type: 'mode', mode: current.mode, source: current.source });
        this.emit();
        return;
      }
      if (!station) return;
      const current = this.stations.get(station);
      if (msg.type === 'status') {
        Object.assign(current, {
          state: String(msg.state || '').slice(0, 30), error: String(msg.error || '').slice(0, 300),
          fps: Math.max(0, Math.min(240, Math.round(Number(msg.fps) || 0))), lastSeen: this.now()
        });
        this.emit();
      }
    });
    socket.on('close', () => {
      if (!station) return;
      const current = this.stations.get(station);
      if (current.socket !== socket) return;
      Object.assign(current, { online: false, socket: null, state: 'offline', fps: 0 });
      this.emit();
    });
  }

  send(n, payload) {
    const s = this.stations.get(n)?.socket;
    if (s && s.readyState === 1) { s.send(JSON.stringify(payload)); return true; }
    return false;
  }

  // station: 1-10 or 'all'. mode: 'mirror' | 'ndi'. source: NDI name (blank = ISU Stage NN).
  setMode(station, mode, source = '') {
    if (!MODES.includes(mode)) return { ok: false, error: 'Mode must be mirror or ndi' };
    const targets = station === 'all' ? [...this.stations.keys()] : [Math.round(Number(station))];
    if (!targets.every((n) => n >= 1 && n <= STATIONS)) return { ok: false, error: 'Station must be 1-10 or all' };
    for (const n of targets) {
      const current = this.stations.get(n);
      current.mode = mode;
      current.source = mode === 'ndi' ? (String(source || '').trim().slice(0, 200) || defaultSource(n)) : current.source;
      this.send(n, { type: 'mode', mode: current.mode, source: current.source });
    }
    this.emit();
    return { ok: true, stations: targets, mode };
  }

  setKey(key = '') { this.key = String(key || '').trim(); this.emit(); return { ok: true, keyRequired: Boolean(this.key) }; }

  status() {
    return {
      port: this.port, error: this.error, keyRequired: Boolean(this.key),
      onlineCount: [...this.stations.values()].filter((s) => s.online).length,
      stations: [...this.stations.values()].map(({ socket: _s, ...rest }) => rest)
    };
  }

  emit() { try { this.onStatus(this.status()); } catch {} }

  async stop() {
    clearInterval(this.heartbeat);
    for (const s of this.stations.values()) try { s.socket?.close(1001, 'Controller closing'); } catch {}
    await new Promise((r) => (this.wss ? this.wss.close(() => r()) : r()));
    await new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

module.exports = { DisplayManager, defaultSource, STATIONS, MODES };
