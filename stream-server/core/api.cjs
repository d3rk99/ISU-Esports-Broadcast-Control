'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { companionVariables } = require('./api-variables.cjs');

// Opt-in local control API for Bitfocus Companion. Every command goes through the same serialized
// service commands the UI uses, so the delay interlock applies identically. Auth: X-ISU-Stream-Key
// (or Bearer). Loopback by default; LAN only when switched on. Requests carrying an Origin header
// (browsers) are refused, bodies are capped, and keys never appear in responses.
const MAX_BODY = 16 * 1024;
const RECORDING = ['RECORDING', 'WAITING_KEYFRAME'];

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

class ApiServer {
  // run(action, payload): serialized service command. getStatus(): fullStatus(). getKey(): plaintext key.
  constructor({ run, getStatus, getKey, logger }) {
    this.run = run; this.getStatus = getStatus; this.getKey = getKey; this.logger = logger;
    this.server = null; this.clients = new Set(); this.timer = null; this.lastPayload = ''; this.lastSentAt = 0;
    this.state = { listening: false, address: '', error: '' };
  }

  async start({ port, lan }) {
    await this.stop();
    const host = lan ? '0.0.0.0' : '127.0.0.1';
    const server = http.createServer((req, res) => this.handle(req, res).catch((error) => this.send(res, 500, { error: error.message })));
    server.headersTimeout = 10000;
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
    } catch (error) {
      this.state = { listening: false, address: '', error: error.code === 'EADDRINUSE' ? `Port ${port} is already in use` : error.message };
      throw new Error(`Companion API could not start: ${this.state.error}`);
    }
    this.server = server;
    this.state = { listening: true, address: `${host}:${port}`, error: '' };
    this.timer = setInterval(() => this.broadcast(), 250);
    this.logger?.write('api.state', { state: 'LISTENING', count: port });
  }

  async stop() {
    clearInterval(this.timer); this.timer = null;
    for (const res of this.clients) { try { res.destroy(); } catch {} }
    this.clients.clear();
    const server = this.server; this.server = null;
    if (server) await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); setTimeout(resolve, 2000).unref(); });
    this.state = { ...this.state, listening: false, address: '' };
  }

  send(res, code, body) {
    if (res.headersSent) { try { res.end(); } catch {} return; }
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body));
  }

  authorized(req) {
    const key = this.getKey();
    const given = req.headers['x-isu-stream-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return Boolean(key && given) && safeEqual(given, key);
  }

  async body(req) {
    let size = 0; const parts = [];
    for await (const part of req) { size += part.length; if (size > MAX_BODY) throw Object.assign(new Error('Body too large'), { status: 413 }); parts.push(part); }
    const text = Buffer.concat(parts).toString('utf8');
    if (!text.trim()) return {};
    try { const v = JSON.parse(text); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(); return v; }
    catch { throw Object.assign(new Error('Malformed JSON body'), { status: 400 }); }
  }

  async handle(req, res) {
    if (req.headers.origin) return this.send(res, 403, { error: 'Browser origins are not allowed' });
    if (!this.authorized(req)) return this.send(res, 401, { error: 'Missing or wrong X-ISU-Stream-Key' });
    const url = new URL(req.url, 'http://local');
    const path = url.pathname.replace(/\/+$/, '');
    if (req.method === 'GET' && path === '/api/status') return this.send(res, 200, { variables: companionVariables(this.getStatus()), status: this.publicStatus() });
    if (req.method === 'GET' && path === '/api/variables') return this.send(res, 200, companionVariables(this.getStatus()));
    if (req.method === 'GET' && path === '/api/events') return this.subscribe(req, res);
    if (req.method !== 'POST') return this.send(res, 404, { error: 'Unknown route' });
    let payload;
    try { payload = await this.body(req); } catch (error) { return this.send(res, error.status || 400, { error: error.message }); }
    const status = this.getStatus();
    const output = /^\/api\/outputs\/([^/]+)\/(start|stop|toggle)$/.exec(path);
    let action; let args = {};
    if (path === '/api/stream/start') action = 'startAll';
    else if (path === '/api/stream/stop') action = 'stopAll';
    else if (path === '/api/recording/start') action = 'startRecording';
    else if (path === '/api/recording/stop') action = 'stopRecording';
    else if (path === '/api/recording/toggle') action = RECORDING.includes(status.recording?.state) ? 'stopRecording' : 'startRecording';
    else if (path === '/api/buffer/reset') action = 'reset';
    else if (path === '/api/delay') {
      const seconds = Number(payload.seconds);
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86400) return this.send(res, 400, { error: 'seconds must be a whole number 0-86400' });
      action = 'setDelay'; args = { seconds };
    } else if (output) {
      const id = this.resolveOutput(decodeURIComponent(output[1]), status);
      if (!id) return this.send(res, 404, { error: 'Unknown destination' });
      const current = status.outputs.find((o) => o.id === id)?.state;
      action = output[2] === 'toggle' ? (['STOPPED', 'DISABLED'].includes(current) ? 'start' : 'stop') : output[2];
      args = { id };
    } else return this.send(res, 404, { error: 'Unknown route' });
    try {
      await this.run(action, args);
      this.logger?.write('api.command', { code: action.toUpperCase() });
      return this.send(res, 200, { ok: true, message: `${action} done`, variables: companionVariables(this.getStatus()) });
    } catch (error) {
      // e.g. "Outputs locked: ..." -> 409 with the reason; nothing was sent.
      return this.send(res, 409, { ok: false, error: error.message, variables: companionVariables(this.getStatus()) });
    }
  }

  // Outputs can be addressed by id, 1-based number, or exact name (case-insensitive).
  resolveOutput(ref, status) {
    const outputs = status.outputs || [];
    if (outputs.some((o) => o.id === ref)) return ref;
    if (/^\d+$/.test(ref)) return outputs[Number(ref) - 1]?.id || '';
    return outputs.find((o) => (o.name || '').toLowerCase() === ref.toLowerCase())?.id || '';
  }

  publicStatus() {
    const s = this.getStatus();
    return {
      engine: s.engine, simulation: s.simulation, error: s.error || '', programHealth: s.programHealth,
      buffer: { ready: s.buffer?.ready, filledSeconds: s.buffer?.filledSeconds, configuredSeconds: s.buffer?.configuredSeconds },
      outputsLocked: s.outputsLocked,
      outputs: (s.outputs || []).map(({ id, name, state, live, healthy, health, reconnectCount, sentBytes, error }) => ({ id, name, state, live, healthy, health, reconnectCount, sentBytes, error })),
      recording: s.recording && { state: s.recording.state, seconds: s.recording.seconds, bytes: s.recording.bytes }
    };
  }

  subscribe(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`retry: 2000\n\ndata: ${JSON.stringify(companionVariables(this.getStatus()))}\n\n`);
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }

  // Push only on change (checked 4x/s), plus a keepalive copy every 15 s.
  broadcast() {
    if (!this.clients.size) return;
    const payload = JSON.stringify(companionVariables(this.getStatus()));
    const now = Date.now();
    if (payload === this.lastPayload && now - this.lastSentAt < 15000) return;
    this.lastPayload = payload; this.lastSentAt = now;
    for (const res of this.clients) {
      if (res.writableLength > 256 * 1024) { this.clients.delete(res); try { res.destroy(); } catch {} continue; }
      res.write(`data: ${payload}\n\n`);
    }
  }
}

module.exports = { ApiServer, companionVariables };
