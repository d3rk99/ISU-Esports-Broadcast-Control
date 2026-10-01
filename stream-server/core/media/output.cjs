'use strict';
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const MAX_QUEUE_BYTES = 64 * 1024 * 1024; // per destination; overflow drops to the next keyframe chunk
const BACKOFF = [1000, 2000, 4000, 8000, 15000, 30000];

// Build the publish URL. Keys live only in memory here and in the child's argv (see SECURITY note).
function publishUrl(definition, key) {
  const base = definition.serverUrl.replace(/\/+$/, '');
  return key ? `${base}/${encodeURIComponent(key).replace(/%2F/g, '/')}` : base;
}
function redact(text, key) {
  let out = String(text || '');
  if (key) out = out.split(key).join('***').split(encodeURIComponent(key)).join('***');
  return out.replace(/(rtmps?:\/\/[^\s/]+\/[^\s/]+\/)[^\s'"]+/gi, '$1***');
}

// One destination = one FFmpeg that STREAM-COPIES the delayed program (-c copy). It never
// encodes. It is fed whole keyframe-aligned chunks through a bounded queue.
class Destination extends EventEmitter {
  constructor({ ffmpegPath, definition, getKey, spawnFn = spawn }) {
    super();
    this.ffmpegPath = ffmpegPath;
    this.definition = definition;
    this.getKey = getKey;
    this.spawn = spawnFn;
    this.state = 'STOPPED';
    this.reconnects = 0;
    this.attempt = 0;
    this.queue = [];
    this.queueBytes = 0;
    this.child = null;
    this.retryTimer = null;
    this.sentBytes = 0;
    this.sentChunks = 0;
    this.droppedChunks = 0;
    this.lastError = '';
    this.encoderInstance = null; // which program encoder the bytes came from (encode-once proof)
    this.wanted = false;
    this.needKeyframe = true;
  }

  set(state, error = '') {
    this.state = state;
    if (error) this.lastError = error;
    this.emit('state', state);
  }

  // Start (or keep) streaming. Bytes only flow from the delay release path, never from capture.
  start() {
    if (this.wanted && ['CONNECTING', 'CONNECTED', 'RECONNECTING'].includes(this.state)) return;
    this.wanted = true;
    this.attempt = 0;
    this.lastError = '';
    this.connect();
  }

  connect() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (!this.wanted) return;
    let key = '';
    try { key = this.getKey(); }
    catch { this.wanted = false; this.set('ERROR', 'Saved stream key could not be decrypted on this Windows account. Re-enter the key.'); return; }
    const url = publishUrl(this.definition, key);
    this.key = key;
    this.set(this.attempt ? 'RECONNECTING' : 'CONNECTING');
    // SECURITY: FFmpeg needs the URL in argv; it is visible to other processes of the same user.
    // It is never logged, shown, or returned in status. Errors are redacted before display.
    const child = this.spawn(this.ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-fflags', '+genpts', '-f', 'mpegts', '-i', 'pipe:0', '-map', '0', '-c', 'copy', '-flvflags', 'no_duration_filesize', '-rw_timeout', '15000000', '-f', 'flv', url], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    this.child = child;
    this.needKeyframe = true; // join on a decodable point
    this.queue = []; this.queueBytes = 0;
    let errorText = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (t) => { errorText = `${errorText}${t}`.slice(-1500); });
    child.stdin.on('error', () => {}); // EPIPE handled by exit
    child.on('error', (error) => this.onExit(child, null, redact(error.message, key)));
    child.on('exit', (code) => this.onExit(child, code, redact(errorText.trim().split('\n').pop() || `exit ${code}`, key)));
    // CONNECTED = FFmpeg is still alive and has taken media for 3 s (RTMP handshake done).
    const startSent = this.sentChunks;
    this.connectedTimer = setInterval(() => {
      if (this.child !== child) return clearInterval(this.connectedTimer);
      if (this.sentChunks > startSent && this.state !== 'CONNECTED') { this.set('CONNECTED'); this.attempt = 0; clearInterval(this.connectedTimer); }
    }, 3000);
  }

  onExit(child, code, message) {
    if (this.child !== child) return;
    this.child = null;
    clearInterval(this.connectedTimer);
    if (!this.wanted) { this.set('STOPPED'); return; }
    this.set('ERROR', message || 'Connection closed');
    const wait = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
    this.attempt += 1;
    this.reconnects += 1;
    this.retryTimer = setTimeout(() => this.connect(), wait);
  }

  // Delayed chunk from the release path. Each chunk starts with PAT/PMT + a keyframe.
  push(chunk) {
    if (!this.child || !this.wanted) return;
    this.encoderInstance = chunk.instance;
    if (this.queueBytes + chunk.data.length > MAX_QUEUE_BYTES) {
      // Slow destination: drop queued media and rejoin at the next keyframe chunk. Bounded RAM,
      // and it never touches the other destinations or the live edge.
      this.droppedChunks += this.queue.length + 1;
      this.queue = []; this.queueBytes = 0;
      this.lastError = 'Destination too slow; skipped ahead to the next delayed keyframe';
      return;
    }
    this.queue.push(chunk.data);
    this.queueBytes += chunk.data.length;
    this.pump();
  }

  pump() {
    const child = this.child;
    if (!child || this.pumping) return;
    this.pumping = true;
    const next = () => {
      if (this.child !== child || !this.queue.length) { this.pumping = false; return; }
      const data = this.queue.shift();
      this.queueBytes -= data.length;
      const ok = child.stdin.write(data);
      this.sentBytes += data.length;
      this.sentChunks += 1;
      if (ok) setImmediate(next); else child.stdin.once('drain', next);
    };
    next();
  }

  async stop() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    clearInterval(this.connectedTimer);
    this.retryTimer = null;
    this.queue = []; this.queueBytes = 0;
    const child = this.child;
    if (!child) { this.set('STOPPED'); return; }
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      try { child.stdin.end(); } catch {}
      setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 500);
    });
    this.child = null;
    this.set('STOPPED');
  }

  snapshot() {
    return { state: this.state, reconnectCount: this.reconnects, sentBytes: this.sentBytes, sentChunks: this.sentChunks, droppedChunks: this.droppedChunks, queueBytes: this.queueBytes, encoderInstance: this.encoderInstance, error: this.state === 'ERROR' || this.droppedChunks ? this.lastError : '' };
  }
}

module.exports = { Destination, publishUrl, redact, MAX_QUEUE_BYTES };
