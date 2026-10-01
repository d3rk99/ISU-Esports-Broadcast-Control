'use strict';
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { PACKET } = require('./ts.cjs');

const MAX_QUEUE_BYTES = 128 * 1024 * 1024;
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024; // stop before the disk is full

// LIVE recording of the program (no delay): taps the encoder output directly and stream-copies it
// (-c copy) into segmented MKV files. No second encode. MKV is used because a crash or power loss
// leaves a playable file, unlike MP4. This path only writes local files; it can never reach a
// stream destination, so the broadcast delay is unaffected.
class Recorder extends EventEmitter {
  constructor({ ffmpegPath, spawnFn = spawn }) {
    super();
    this.ffmpegPath = ffmpegPath;
    this.spawn = spawnFn;
    this.state = 'STOPPED'; // STOPPED | WAITING_KEYFRAME | RECORDING | ERROR
    this.child = null;
    this.queue = [];
    this.queueBytes = 0;
    this.bytes = 0;
    this.error = '';
    this.startedAt = 0;
    this.instance = null;
    this.dir = '';
    this.segmentMinutes = 30;
    this.files = new Set();
  }

  async start({ directory, segmentMinutes = 30 }) {
    if (this.state === 'RECORDING' || this.state === 'WAITING_KEYFRAME') return;
    fs.mkdirSync(directory, { recursive: true });
    const free = freeBytes(directory);
    if (free < MIN_FREE_BYTES) throw Object.assign(new Error(`Not enough disk space to record: ${(free / 1e9).toFixed(1)} GB free at ${directory} (need at least 2 GB)`), { code: 'RECORD_DISK' });
    this.dir = directory;
    this.segmentMinutes = Math.max(1, Math.min(720, Number(segmentMinutes) || 30));
    this.error = '';
    this.bytes = 0;
    this.files = new Set();
    this.wanted = true;
    this.instance = null;
    this.set('WAITING_KEYFRAME'); // the file must begin on a decodable keyframe
  }

  set(state) { this.state = state; this.emit('state', state); }

  spawnWriter() {
    const pattern = path.join(this.dir, 'ISU-%Y-%m-%d_%H-%M-%S.mkv');
    const child = this.spawn(this.ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-fflags', '+genpts', '-f', 'mpegts', '-i', 'pipe:0', '-map', '0', '-c', 'copy', '-f', 'segment', '-segment_format', 'matroska', '-segment_time', String(this.segmentMinutes * 60), '-reset_timestamps', '1', '-strftime', '1', '-segment_list', 'pipe:1', '-segment_list_type', 'flat', pattern], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let errorText = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (t) => { errorText = `${errorText}${t}`.slice(-1500); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (t) => { for (const line of t.split(/\r?\n/)) if (line.trim()) { this.files.add(path.join(this.dir, path.basename(line.trim()))); this.emit('segment', line.trim()); } });
    child.stdin.on('error', () => {});
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.wanted) { this.wanted = false; this.error = errorText.trim().split('\n').pop() || `recorder exited (${code})`; this.set('ERROR'); }
    });
    this.child = child;
  }

  // Called with every encoded TS chunk straight from the encoder (live).
  feed({ instance, packets, reader }) {
    if (!this.wanted) return;
    if (this.instance !== null && instance !== this.instance) {
      // Encoder restarted (settings change / reset): close this file and start a fresh one on the
      // next keyframe so timestamps never jump inside a file.
      this.closeWriter();
      this.instance = null;
      this.set('WAITING_KEYFRAME');
    }
    let data = packets;
    if (this.state === 'WAITING_KEYFRAME') {
      const at = findKeyframe(packets, reader.videoPid);
      const headers = reader.headers();
      if (at < 0 || !headers) return;
      this.instance = instance;
      this.spawnWriter();
      this.startedAt = Date.now();
      this.set('RECORDING');
      data = Buffer.concat([headers, packets.subarray(at)]);
    }
    if (!this.child) return;
    if (this.queueBytes + data.length > MAX_QUEUE_BYTES) {
      this.error = 'Recording disk too slow; recording stopped';
      this.stop();
      this.set('ERROR');
      return;
    }
    this.queue.push(data);
    this.queueBytes += data.length;
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
      this.bytes += data.length;
      if (child.stdin.write(data)) setImmediate(next); else child.stdin.once('drain', next);
    };
    next();
  }

  // Checked by the engine once a second: stop cleanly before the disk fills up.
  checkDisk() {
    if (this.state !== 'RECORDING') return;
    if (freeBytes(this.dir) < MIN_FREE_BYTES / 2) { this.error = 'Disk almost full; recording stopped to protect the delay buffer'; this.stop().then(() => this.set('ERROR')); }
  }

  closeWriter() {
    const child = this.child;
    this.child = null;
    this.queue = []; this.queueBytes = 0; this.pumping = false;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      try { child.stdin.end(); } catch { resolve(); } // EOF lets FFmpeg finalize the MKV properly
    });
  }

  async stop() {
    this.wanted = false;
    await this.closeWriter();
    if (this.state !== 'ERROR') this.set('STOPPED');
  }

  snapshot() {
    return { state: this.state, bytes: this.bytes, seconds: this.state === 'RECORDING' ? Math.round((Date.now() - this.startedAt) / 1000) : 0, directory: this.dir, files: [...this.files].map((f) => path.basename(f)), error: this.state === 'ERROR' ? this.error : '' };
  }
}

function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return 0; }
}

// Byte offset of the first video packet that starts a random-access (keyframe) unit, or -1.
function findKeyframe(packets, videoPid) {
  if (videoPid < 0) return -1;
  for (let at = 0; at + PACKET <= packets.length; at += PACKET) {
    const pid = ((packets[at + 1] & 0x1f) << 8) | packets[at + 2];
    if (pid !== videoPid || !(packets[at + 1] & 0x40)) continue;
    const afc = (packets[at + 3] >> 4) & 0x3;
    if ((afc & 0x2) && packets[at + 4] > 0 && (packets[at + 5] & 0x40)) return at;
  }
  return -1;
}

module.exports = { Recorder, findKeyframe };
