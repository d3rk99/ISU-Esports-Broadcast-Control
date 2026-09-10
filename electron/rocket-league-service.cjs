const net = require('node:net');
const { WebSocket, WebSocketServer } = require('ws');

const DEFAULTS = Object.freeze({
  enabled: false,
  source: 'local',
  transport: 'auto',
  host: '127.0.0.1',
  tcpPort: 49123,
  webPort: 49124,
  bridgePort: 3175,
  bridgeToken: '',
  updateIntervalMs: 33
});

function safePort(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

function safeUpdateInterval(value, fallback = DEFAULTS.updateIntervalMs) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(50, Math.round(parsed))) : fallback;
}

function normalizeSettings(settings = {}) {
  return {
    ...DEFAULTS,
    ...settings,
    enabled: Boolean(settings.enabled),
    source: settings.source === 'remote' ? 'remote' : 'local',
    transport: ['auto', 'websocket', 'tcp'].includes(settings.transport) ? settings.transport : 'auto',
    host: String(settings.host || DEFAULTS.host).trim(),
    tcpPort: safePort(settings.tcpPort, DEFAULTS.tcpPort),
    webPort: safePort(settings.webPort, DEFAULTS.webPort),
    bridgePort: safePort(settings.bridgePort, DEFAULTS.bridgePort),
    bridgeToken: String(settings.bridgeToken || '').trim(),
    updateIntervalMs: safeUpdateInterval(settings.updateIntervalMs)
  };
}

class JsonStreamParser {
  constructor(onValue) {
    this.onValue = onValue;
    this.buffer = '';
    this.depth = 0;
    this.start = -1;
    this.inString = false;
    this.escaped = false;
  }

  push(chunk) {
    const input = String(chunk || '');
    for (const character of input) {
      if (this.start < 0) {
        if (character !== '{') continue;
        this.start = this.buffer.length;
        this.depth = 1;
        this.buffer += character;
        continue;
      }

      this.buffer += character;
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (character === '\\') this.escaped = true;
        else if (character === '"') this.inString = false;
        continue;
      }
      if (character === '"') this.inString = true;
      else if (character === '{') this.depth += 1;
      else if (character === '}') this.depth -= 1;

      if (this.depth === 0) {
        const json = this.buffer.slice(this.start);
        this.buffer = '';
        this.start = -1;
        try { this.onValue(JSON.parse(json)); } catch {}
      }
    }
    if (this.buffer.length > 2_000_000) this.reset();
  }

  reset() {
    this.buffer = '';
    this.depth = 0;
    this.start = -1;
    this.inString = false;
    this.escaped = false;
  }
}

function normalizeEnvelope(message) {
  if (!message || typeof message !== 'object') return null;
  const event = message.Event || message.event;
  let data = message.Data ?? message.data ?? {};
  if (!event) return null;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = {}; }
  }
  return { Event: String(event), Data: data && typeof data === 'object' ? data : {} };
}

class RocketLeagueService {
  constructor({ onEvent = () => {}, onStatus = () => {} } = {}) {
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.settings = { ...DEFAULTS };
    this.socket = null;
    this.server = null;
    this.reconnectTimer = null;
    this.simulatorTimer = null;
    this.watchdogTimer = null;
    this.generation = 0;
    this.packets = 0;
    this.bridgeClients = new Set();
    this.lastTickSent = 0;
    this.lastStatusSentAt = 0;
    this.lastPacketTimestamp = 0;
    this.lastRateAt = Date.now();
    this.lastRatePackets = 0;
    this.status = { state: 'disabled', transport: null, message: 'Live data is off', packets: 0, packetRate: 0, bridgeClients: 0, lastPacketAt: null, dataAgeMs: null };
  }

  configure(nextSettings) {
    this.settings = normalizeSettings(nextSettings);
    this.stop();
    this.packets = 0;
    this.lastPacketTimestamp = 0;
    this.lastRateAt = Date.now();
    this.lastRatePackets = 0;
    this.lastTickSent = 0;
    this.status = { ...this.status, packets: 0, packetRate: 0, lastPacketAt: null, dataAgeMs: null };
    if (!this.settings.enabled) return this.emitStatus('disabled', 'Live data is off');
    this.startWatchdog();
    if (this.settings.source === 'remote') this.startReceiver();
    else this.connectLocal();
  }

  stop() {
    this.generation += 1;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.simulatorTimer);
    clearInterval(this.watchdogTimer);
    this.reconnectTimer = null;
    this.simulatorTimer = null;
    this.watchdogTimer = null;
    if (this.socket) {
      this.socket.removeAllListeners?.();
      this.socket.on?.('error', () => {});
      if (typeof this.socket.terminate === 'function') this.socket.terminate();
      else this.socket.destroy?.();
      this.socket = null;
    }
    for (const client of this.bridgeClients) client.close();
    this.bridgeClients.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  emitStatus(state, message, extra = {}) {
    this.status = {
      ...this.status,
      state,
      message,
      packets: this.packets,
      bridgeClients: this.bridgeClients.size,
      ...extra
    };
    this.lastStatusSentAt = Date.now();
    this.onStatus({ ...this.status });
  }

  setUpdateInterval(value) {
    this.settings.updateIntervalMs = safeUpdateInterval(value);
    this.status = { ...this.status, updateIntervalMs: this.settings.updateIntervalMs };
    this.onStatus({ ...this.status });
    return this.settings.updateIntervalMs;
  }

  startWatchdog() {
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => {
      const now = Date.now();
      const elapsed = Math.max(0.001, (now - this.lastRateAt) / 1000);
      const packetRate = Math.round(((this.packets - this.lastRatePackets) / elapsed) * 10) / 10;
      this.lastRateAt = now;
      this.lastRatePackets = this.packets;
      const dataAgeMs = this.lastPacketTimestamp ? now - this.lastPacketTimestamp : null;
      const transportConnected = this.settings.source === 'remote' ? this.bridgeClients.size > 0 : Boolean(this.socket);
      if (transportConnected && (dataAgeMs === null || dataAgeMs > 2500)) {
        this.emitStatus('idle', this.settings.source === 'remote'
          ? 'Game PC bridge connected; waiting for match data'
          : 'Connected to Rocket League; waiting for an active match', { packetRate, dataAgeMs });
      } else {
        this.status = { ...this.status, packetRate, dataAgeMs };
        this.onStatus({ ...this.status });
      }
    }, 1000);
  }

  ingest(message, transport) {
    const envelope = normalizeEnvelope(message);
    if (!envelope) return;
    this.packets += 1;
    const now = Date.now();
    this.lastPacketTimestamp = now;
    this.status.lastPacketAt = new Date(now).toISOString();
    this.status.dataAgeMs = 0;
    this.status.transport = transport;
    if (envelope.Event === 'UpdateState' && now - this.lastTickSent < this.settings.updateIntervalMs) return;
    if (envelope.Event === 'UpdateState') this.lastTickSent = now;
    const state = transport === 'simulator' ? 'simulating' : 'connected';
    const statusMessage = transport === 'bridge' ? 'Receiving from Game PC bridge' : transport === 'simulator' ? 'Test feed running' : `Connected via ${transport}`;
    this.status = { ...this.status, state, message: statusMessage, transport, packets: this.packets, lastPacketAt: this.status.lastPacketAt };
    if (now - this.lastStatusSentAt >= 500) {
      this.lastStatusSentAt = now;
      this.onStatus({ ...this.status });
    }
    this.onEvent(envelope);
  }

  connectLocal(forceTransport) {
    const generation = ++this.generation;
    const requested = forceTransport || this.settings.transport;
    const transport = requested === 'auto' ? 'websocket' : requested;
    this.emitStatus('connecting', `Connecting to ${this.settings.host} via ${transport}…`, { transport });
    if (transport === 'tcp') this.connectTcp(generation);
    else this.connectWebSocket(generation, requested === 'auto');
  }

  connectWebSocket(generation, allowTcpFallback) {
    const url = `ws://${this.settings.host}:${this.settings.webPort}`;
    const socket = new WebSocket(url);
    this.socket = socket;
    let opened = false;
    socket.on('open', () => {
      if (generation !== this.generation) return socket.close();
      opened = true;
      this.emitStatus('connected', `Connected to Rocket League at ${url}`, { transport: 'websocket' });
    });
    socket.on('message', (raw) => {
      try { this.ingest(JSON.parse(raw.toString()), 'websocket'); } catch {}
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (generation !== this.generation || this.settings.source !== 'local' || !this.settings.enabled) return;
      this.socket = null;
      if (!opened && allowTcpFallback) {
        this.emitStatus('connecting', 'WebSocket unavailable; trying TCP 49123…', { transport: 'tcp' });
        this.connectTcp(generation);
      } else this.scheduleReconnect();
    });
  }

  connectTcp(generation) {
    const parser = new JsonStreamParser((message) => this.ingest(message, 'tcp'));
    const socket = net.createConnection({ host: this.settings.host, port: this.settings.tcpPort });
    this.socket = socket;
    socket.on('connect', () => {
      if (generation !== this.generation) return socket.destroy();
      this.emitStatus('connected', `Connected to Rocket League at ${this.settings.host}:${this.settings.tcpPort}`, { transport: 'tcp' });
    });
    socket.on('data', (chunk) => parser.push(chunk));
    socket.on('error', (error) => this.emitStatus('waiting', `Rocket League feed unavailable: ${error.code || error.message}`, { transport: 'tcp' }));
    socket.on('close', () => {
      if (generation !== this.generation || this.settings.source !== 'local' || !this.settings.enabled) return;
      this.socket = null;
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.emitStatus('waiting', 'Waiting for an active Rocket League match…');
    this.reconnectTimer = setTimeout(() => this.connectLocal(), 3000);
  }

  startReceiver() {
    if (!this.settings.bridgeToken) return this.emitStatus('error', 'Create a bridge key before starting remote mode');
    try {
      this.server = new WebSocketServer({ host: '0.0.0.0', port: this.settings.bridgePort });
    } catch (error) {
      return this.emitStatus('error', error.message);
    }
    this.server.on('listening', () => this.emitStatus('listening', `Waiting for Game PC on port ${this.settings.bridgePort}`, { transport: 'bridge' }));
    this.server.on('error', (error) => this.emitStatus('error', `Bridge receiver error: ${error.message}`, { transport: 'bridge' }));
    this.server.on('connection', (client, request) => {
      const requestUrl = new URL(request.url, `ws://${request.headers.host || 'localhost'}`);
      if (requestUrl.searchParams.get('token') !== this.settings.bridgeToken) {
        client.close(1008, 'Invalid bridge key');
        return;
      }
      this.bridgeClients.add(client);
      this.emitStatus('connected', 'Game PC bridge connected', { transport: 'bridge' });
      client.on('message', (raw) => {
        try {
          const packet = JSON.parse(raw.toString());
          if (packet.type === 'telemetry') this.ingest(packet.event, 'bridge');
        } catch {}
      });
      client.on('close', () => {
        this.bridgeClients.delete(client);
        this.emitStatus('listening', `Game PC disconnected; waiting on port ${this.settings.bridgePort}`, { transport: 'bridge' });
      });
      client.on('error', () => {});
      client.send(JSON.stringify({ type: 'welcome', version: 1 }));
    });
  }

  startSimulator() {
    this.stop();
    this.packets = 0;
    this.startWatchdog();
    let remaining = 300;
    let home = 0;
    let away = 0;
    const matchGuid = `SIM-${Date.now()}`;
    this.emitStatus('simulating', 'Test feed running', { transport: 'simulator' });
    this.ingest({ Event: 'MatchCreated', Data: { MatchGuid: matchGuid } }, 'simulator');
    const tick = () => {
      remaining = Math.max(0, remaining - 1);
      if (remaining === 285) home = 1;
      if (remaining === 270) away = 1;
      const players = ['BengalOne', 'BengalTwo', 'BengalThree', 'Opponent1', 'Opponent2', 'Opponent3'].map((name, index) => ({
        Name: name, PrimaryId: `Sim|${index}|0`, Shortcut: index + 1, TeamNum: index < 3 ? 0 : 1,
        Score: Math.max(0, (300 - remaining) * 3 - index * 7), Goals: index === 0 ? home : index === 3 ? away : 0,
        Shots: index % 3, Assists: 0, Saves: index % 2, Demos: 0,
        Boost: Math.round(50 + 45 * Math.sin((300 - remaining + index * 4) / 7)), bDemolished: false
      }));
      this.ingest({ Event: 'UpdateState', Data: {
        MatchGuid: matchGuid,
        Players: players,
        Game: { Teams: [{ Name: 'Blue', TeamNum: 0, Score: home }, { Name: 'Orange', TeamNum: 1, Score: away }], TimeSeconds: remaining, bOvertime: false, bReplay: false, Arena: 'Stadium_P', bHasTarget: true, Target: { Name: players[0].Name, Shortcut: 1, TeamNum: 0 } }
      } }, 'simulator');
      if (remaining === 0) {
        this.ingest({ Event: 'MatchEnded', Data: { MatchGuid: matchGuid, WinnerTeamNum: home >= away ? 0 : 1 } }, 'simulator');
        clearInterval(this.simulatorTimer);
        this.simulatorTimer = null;
      }
    };
    tick();
    this.simulatorTimer = setInterval(tick, 1000);
  }

  stopSimulator() {
    clearInterval(this.simulatorTimer);
    this.simulatorTimer = null;
    this.configure(this.settings);
  }
}

module.exports = { DEFAULTS, JsonStreamParser, RocketLeagueService, normalizeEnvelope, normalizeSettings };
