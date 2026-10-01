'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PACKET } = require('./ts.cjs');

const OWNER_MARK = '.isu-stream-delay'; // only directories holding this file are ever cleaned
const PTS_HZ = 90000;

// True program delay on encoded media. Encoded MPEG-TS is cut into chunks that each start on a
// video keyframe and carry PAT/PMT, so every chunk is an independently decodable entry point.
// A chunk is written to disk, and released only when its LAST packet arrived at least
// `delaySeconds` ago on the monotonic clock. Release order == capture order, A and V together
// (they are interleaved in one TS byte stream), so audio/video stay on one delayed timeline.
class DelayBuffer extends EventEmitter {
  constructor({ directory, now = () => performance.now(), maxChunkSeconds = 2.5 }) {
    super();
    this.root = directory;
    this.now = now;
    this.maxChunkMs = maxChunkSeconds * 1000;
    this.delaySeconds = 300;
    this.epoch = 0;
    this.chunks = []; // { seq, file, bytes, firstAt, lastAt, firstPts, lastPts, keyframe, hasAudio, hasVideo, epoch }
    this.open = null;
    this.seq = 0;
    this.releasedSeq = -1;
    this.timer = null;
    this.failure = null;
    this.sawVideo = false;
    this.sawAudio = false;
  }

  dir() { return path.join(this.root, `epoch-${this.epoch}`); }

  async init() {
    await fsp.mkdir(this.root, { recursive: true });
    await fsp.writeFile(path.join(this.root, OWNER_MARK), 'ISU Stream Server delay storage. Safe to delete while the app is closed.\n');
    await this.sweepStale(); // never trust leftovers from a crash
    this.timer = setInterval(() => this.release().catch((error) => this.fail('STORAGE_READ', error)), 100);
  }

  // Only ever deletes epoch-* folders inside a directory we marked as ours.
  async sweepStale(keep = -1) {
    if (!fs.existsSync(path.join(this.root, OWNER_MARK))) return;
    for (const name of await fsp.readdir(this.root)) {
      if (!/^epoch-\d+$/.test(name) || name === `epoch-${keep}`) continue;
      await fsp.rm(path.join(this.root, name), { recursive: true, force: true });
    }
  }

  // Bytes needed for the requested delay at the configured rate, plus 25% + one chunk of headroom.
  static requiredBytes(seconds, videoKbps, audioKbps) {
    return Math.ceil(((videoKbps + audioKbps) * 1000 / 8) * (seconds * 1.25 + 10) * 1.06); // ~6% TS overhead
  }

  async preflight(seconds, videoKbps, audioKbps) {
    await fsp.mkdir(this.root, { recursive: true });
    const need = DelayBuffer.requiredBytes(seconds, videoKbps, audioKbps);
    const stats = fs.statfsSync(this.root);
    const free = Number(stats.bavail) * Number(stats.bsize);
    if (free < need) throw Object.assign(new Error(`Not enough disk space for a ${seconds}s delay: need ${(need / 1e9).toFixed(2)} GB, ${(free / 1e9).toFixed(2)} GB free at ${this.root}`), { code: 'DISK_SPACE' });
    return { needBytes: need, freeBytes: free };
  }

  // New epoch: discard everything buffered, readiness resets to zero. Used for start, delay change,
  // input discontinuity, encoder restart. Older-epoch chunks can never be released after this.
  async reset(delaySeconds = this.delaySeconds) {
    this.delaySeconds = delaySeconds;
    this.epoch += 1;
    this.chunks = [];
    if (this.open) { this.open.stream.destroy(); this.open = null; }
    this.releasedSeq = -1;
    this.failure = null;
    this.sawVideo = false;
    this.sawAudio = false;
    this.primed = false;
    await fsp.mkdir(this.dir(), { recursive: true });
    await this.sweepStale(this.epoch);
    this.emit('status', this.status());
  }

  // Receive encoded TS packets straight from the program encoder (in order).
  write({ packets, reader, receivedAt }) {
    if (this.failure) return;
    const at = this.now();
    for (let offset = 0; offset < packets.length; offset += PACKET) {
      const packet = packets.subarray(offset, offset + PACKET);
      const info = reader.inspect(packet);
      if (info.video) this.sawVideo = true;
      if (info.audio) this.sawAudio = true;
      // Start a fresh chunk on each video keyframe once the current one is long enough.
      if (info.keyframe && (!this.open || at - this.open.firstAt >= this.maxChunkMs || !this.open.keyframe)) {
        this.closeChunk();
        this.openChunk(at, reader, info.pts);
      }
      if (!this.open) continue; // nothing is buffered until the first keyframe: no undecodable head
      this.open.stream.write(packet);
      this.open.bytes += PACKET;
      this.open.lastAt = at;
      if (info.audio) this.open.hasAudio = true;
      if (info.video) this.open.hasVideo = true;
      if (info.pts !== null && info.video) this.open.lastPts = info.pts;
    }
  }

  openChunk(at, reader, pts) {
    const seq = this.seq++;
    const file = path.join(this.dir(), `${String(seq).padStart(9, '0')}.ts`);
    const stream = fs.createWriteStream(file, { flags: 'w' });
    stream.on('error', (error) => this.fail('STORAGE_WRITE', error));
    const headers = reader.headers();
    const chunk = { seq, file, bytes: 0, firstAt: at, lastAt: at, firstPts: pts, lastPts: pts, keyframe: true, hasAudio: false, hasVideo: false, epoch: this.epoch, stream, written: null };
    if (headers) { stream.write(headers); chunk.bytes += headers.length; }
    this.open = chunk;
  }

  closeChunk() {
    const chunk = this.open;
    if (!chunk) return;
    this.open = null;
    chunk.written = new Promise((resolve) => chunk.stream.end(resolve));
    delete chunk.stream;
    this.chunks.push(chunk);
  }

  fail(code, error) {
    if (this.failure) return;
    this.failure = { code, message: error?.message || String(error) };
    this.emit('failure', this.failure);
    this.emit('status', this.status());
  }

  // Contiguous media span currently held (oldest buffered byte -> newest), in seconds.
  bufferedSeconds() {
    const first = this.chunks[0] || this.open;
    const last = this.open || this.chunks[this.chunks.length - 1];
    if (!first || !last) return 0;
    return Math.max(0, (last.lastAt - first.firstAt) / 1000);
  }

  // Ready = this epoch has already aged a full decodable A/V chunk past the delay (primed) and
  // nothing failed since. Once primed the buffer holds a rolling `delaySeconds` of media.
  status() {
    const avOk = this.sawVideo && this.sawAudio;
    return {
      configuredSeconds: this.delaySeconds,
      filledSeconds: this.primed ? this.delaySeconds : Math.min(this.delaySeconds, this.bufferedSeconds()),
      ready: Boolean(this.primed && avOk && !this.failure),
      primed: Boolean(this.primed),
      hasVideo: this.sawVideo,
      hasAudio: this.sawAudio,
      chunks: this.chunks.length,
      bytes: this.chunks.reduce((sum, c) => sum + c.bytes, 0) + (this.open?.bytes || 0),
      epoch: this.epoch,
      failure: this.failure
    };
  }

  // Release every chunk whose last byte is older than the delay. Never releases early.
  async release() {
    const delayMs = this.delaySeconds * 1000;
    while (this.chunks.length) {
      const chunk = this.chunks[0];
      if (chunk.epoch !== this.epoch) { this.chunks.shift(); continue; }
      const age = this.now() - chunk.lastAt;
      if (age < delayMs) break;
      // Zero-delay mode still waits until the chunk is complete (closed on the next keyframe).
      await chunk.written;
      if (chunk.epoch !== this.epoch || this.chunks[0] !== chunk) continue; // reset raced us
      const data = await fsp.readFile(chunk.file);
      if (chunk.epoch !== this.epoch) continue;
      this.chunks.shift();
      this.releasedSeq = chunk.seq;
      if (chunk.hasVideo && chunk.hasAudio) this.primed = true;
      this.emit('chunk', { seq: chunk.seq, epoch: chunk.epoch, data, firstPts: chunk.firstPts, lastPts: chunk.lastPts, capturedAt: chunk.firstAt, completedAt: chunk.lastAt, releasedAt: this.now(), ageMs: this.now() - chunk.lastAt, hasAudio: chunk.hasAudio, hasVideo: chunk.hasVideo });
      fsp.rm(chunk.file, { force: true }).catch(() => {});
    }
    this.emit('status', this.status());
  }

  async close() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.open) { this.open.stream.destroy(); this.open = null; }
    this.chunks = [];
    this.epoch += 1;
    await this.sweepStale(-1);
  }
}

module.exports = { DelayBuffer, PTS_HZ };
