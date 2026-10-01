'use strict';
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { findKeyframe } = require('./recorder.cjs');

// Confidence monitor: DECODES the already-encoded live program (no second program encode) into
// small JPEG thumbnails (a few per second) plus low-rate PCM for audio meters. It only reads the
// encoder output; it has no route to any destination and never affects the delay buffer.
// If the decoder falls behind, chunks are dropped and it resumes on the next keyframe, so the
// preview can never back up memory or slow the program path.
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const AUDIO_RATE = 16000;
const WINDOW_SAMPLES = AUDIO_RATE / 10; // 100 ms meter windows
const SILENCE_DB = -60;
const MAX_BACKLOG_BYTES = 3 * 1024 * 1024; // ~3-4 s of a 6 Mbps program; beyond that the preview resyncs

// Byte offset of the first video packet that STARTS a new frame (PES start), or -1.
function findFrameStart(packets, videoPid) {
  if (videoPid < 0) return -1;
  for (let at = 0; at + 188 <= packets.length; at += 188) {
    const pid = ((packets[at + 1] & 0x1f) << 8) | packets[at + 2];
    if (pid === videoPid && (packets[at + 1] & 0x40)) return at;
  }
  return -1;
}

function db(linear) { return linear > 0 ? Math.max(-90, 20 * Math.log10(linear)) : -90; }

class Preview extends EventEmitter {
  constructor({ ffmpegPath, spawnFn = spawn, fps = 30, width = 854 }) {
    super();
    this.ffmpegPath = ffmpegPath;
    this.spawn = spawnFn;
    this.fps = fps;
    this.width = width;
    this.enabled = true;
    this.child = null;
    this.instance = null;
    this.waitingKeyframe = true;
    this.congested = false;
    this.frames = 0;
    this.lastFrameAt = 0;
    this.meter = { peak: [-90, -90], rms: [-90, -90], at: 0 };
    this.silentSince = 0;
    this.lastAudioAt = 0;
    this.restartAfter = 0;
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    if (!this.enabled) this.close();
  }

  spawnDecoder() {
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', '0', '-fflags', '+discardcorrupt', '-flags', '-output_corrupt', '-f', 'mpegts', '-i', 'pipe:0',
      '-map', '0:v:0', '-an', '-vf', `fps=${this.fps},scale=${this.width}:-2:flags=fast_bilinear`, '-c:v', 'mjpeg', '-q:v', '5', '-f', 'image2pipe', 'pipe:1',
      '-map', '0:a:0?', '-vn', '-ac', '2', '-ar', String(AUDIO_RATE), '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:3'];
    const child = this.spawn(this.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'ignore', 'pipe'], windowsHide: true });
    let jpeg = Buffer.alloc(0);
    child.stdout.on('data', (data) => {
      jpeg = jpeg.length ? Buffer.concat([jpeg, data]) : data;
      for (;;) {
        const start = jpeg.indexOf(SOI);
        if (start < 0) { jpeg = Buffer.alloc(0); break; }
        const end = jpeg.indexOf(EOI, start + 2);
        if (end < 0) { jpeg = jpeg.subarray(start); break; }
        const frame = jpeg.subarray(start, end + 2);
        jpeg = jpeg.subarray(end + 2);
        this.frames += 1;
        this.lastFrameAt = Date.now();
        this.emit('frame', Buffer.from(frame));
      }
      if (jpeg.length > 4 * 1024 * 1024) jpeg = Buffer.alloc(0);
    });
    let pcm = Buffer.alloc(0);
    child.stdio[3].on('data', (data) => {
      pcm = pcm.length ? Buffer.concat([pcm, data]) : data;
      const bytes = WINDOW_SAMPLES * 4;
      while (pcm.length >= bytes) {
        this.measure(pcm.subarray(0, bytes));
        pcm = pcm.subarray(bytes);
      }
    });
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    child.stdio[3].on('error', () => {});
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      this.waitingKeyframe = true;
      this.restartAfter = Date.now() + 2000; // decoder died: retry shortly, never crash the program
    });
    this.child = child;
  }

  measure(window) {
    const peak = [0, 0];
    const sum = [0, 0];
    for (let at = 0; at + 4 <= window.length; at += 4) {
      for (let ch = 0; ch < 2; ch += 1) {
        const v = Math.abs(window.readInt16LE(at + ch * 2)) / 32768;
        if (v > peak[ch]) peak[ch] = v;
        sum[ch] += v * v;
      }
    }
    const n = window.length / 4;
    const now = Date.now();
    this.meter = { peak: peak.map(db), rms: sum.map((s) => db(Math.sqrt(s / n))), at: now };
    this.lastAudioAt = now;
    const loud = Math.max(...this.meter.peak) > SILENCE_DB;
    if (loud) this.silentSince = 0; else if (!this.silentSince) this.silentSince = now;
    this.emit('meter', this.meter);
  }

  // Called with every encoded TS chunk straight from the program encoder.
  feed({ instance, packets, reader }) {
    if (!this.enabled) return;
    if (this.instance !== null && instance !== this.instance) { this.close(); }
    if (!this.child) {
      if (Date.now() < this.restartAfter) return;
      const at = findKeyframe(packets, reader.videoPid);
      const headers = reader.headers();
      if (at < 0 || !headers) return;
      this.instance = instance;
      this.spawnDecoder();
      this.waitingKeyframe = false;
      this.write(Buffer.concat([headers, packets.subarray(at)]));
      return;
    }
    if (this.congested) {
      // Behind: complete the frame in flight (up to the next video frame start) so the decoder never
      // gets half a picture, then drop until the backlog clears and rejoin on a keyframe.
      if (!this.waitingKeyframe) {
        const cut = findFrameStart(packets, reader.videoPid);
        this.child.stdin.write(cut < 0 ? packets : packets.subarray(0, cut));
        if (cut < 0) return;
        this.waitingKeyframe = true;
      }
      if (this.backlog() > MAX_BACKLOG_BYTES / 4) return;
      this.congested = false;
    }
    if (this.waitingKeyframe) {
      const at = findKeyframe(packets, reader.videoPid);
      if (at < 0) return;
      this.waitingKeyframe = false;
      this.write(packets.subarray(at));
      return;
    }
    this.write(packets);
  }

  // Real backlog in bytes queued for the decoder. stdin.write() returning false is NOT "behind":
  // on Windows pipes it returns false on nearly every write, which used to make the preview skip
  // to the next keyframe constantly (choppy) and cut frames in half (grey smears).
  backlog() { return this.child ? this.child.stdin.writableLength || 0 : 0; }

  write(data) {
    if (!this.child) return;
    this.child.stdin.write(data);
    if (this.backlog() > MAX_BACKLOG_BYTES) this.congested = true;
  }

  close() {
    const child = this.child;
    this.child = null;
    this.instance = null;
    this.waitingKeyframe = true;
    this.congested = false;
    if (child) { try { child.stdin.end(); } catch {} setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1500).unref?.(); }
  }

  snapshot() {
    const now = Date.now();
    const audioLive = now - this.lastAudioAt < 1500;
    return {
      enabled: this.enabled,
      running: Boolean(this.child),
      videoLive: now - this.lastFrameAt < 3000,
      audioLive,
      peakDb: audioLive ? this.meter.peak : [-90, -90],
      rmsDb: audioLive ? this.meter.rms : [-90, -90],
      silentSeconds: audioLive && this.silentSince ? Math.round((now - this.silentSince) / 1000) : (audioLive ? 0 : null)
    };
  }
}

module.exports = { Preview, SILENCE_DB, MAX_BACKLOG_BYTES, findFrameStart };
