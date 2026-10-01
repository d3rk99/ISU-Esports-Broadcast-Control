'use strict';
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { sourceArgs, rationalFps } = require('./sources.cjs');
const { TsReader, PACKET } = require('./ts.cjs');

// THE program encoder: exactly one FFmpeg process captures the input and encodes H.264/AAC
// once into MPEG-TS on stdout. Every destination later re-muxes these same bytes (stream copy).
class ProgramEncoder extends EventEmitter {
  constructor(ffmpeg) {
    super();
    this.ffmpeg = ffmpeg; // capabilities from findFfmpeg()
    this.child = null;
    this.instanceId = 0; // increments per encoder process; outputs record it as proof of encode-once
    this.stats = this.blankStats();
  }

  blankStats() { return { frames: 0, fps: 0, bitrateKbps: 0, speed: 0, dropped: 0, duplicated: 0, bytes: 0, startedAt: 0, video: null, audio: null, codec: '' }; }

  args(input, encoder) {
    const fps = rationalFps(encoder.fps);
    const gop = Math.max(1, Math.round(Number(encoder.fps) * 2)); // 2 s keyframes (Twitch/YouTube)
    const v = Number(encoder.videoBitrate);
    const useNvenc = encoder.mode === 'hardware';
    if (useNvenc && !this.ffmpeg.nvencUsable) throw Object.assign(new Error('NVENC is not usable on this machine (no supported NVIDIA GPU/driver). Switch the encoder to Software (x264).'), { code: 'NVENC_UNAVAILABLE' });
    if (!useNvenc && !this.ffmpeg.libx264) throw Object.assign(new Error('This FFmpeg has no libx264 software encoder.'), { code: 'X264_UNAVAILABLE' });
    const video = useNvenc
      ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'll', '-rc', 'cbr']
      : ['-c:v', 'libx264', '-preset', encoder.x264Preset || 'veryfast', '-tune', 'zerolatency', '-x264-params', 'nal-hrd=cbr'];
    const [width, height] = encoder.resolution.split('x');
    return [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-stats_period', '1', '-progress', 'pipe:2',
      ...sourceArgs(input, encoder),
      '-map', '0:v:0', '-map', input.type === 'test' ? '1:a:0' : '0:a:0?',
      '-vf', `scale=${width}:${height}:flags=bicubic,fps=${fps},format=yuv420p`,
      ...video,
      '-b:v', `${v}k`, '-maxrate', `${v}k`, '-bufsize', `${v * 2}k`,
      '-g', String(gop), '-keyint_min', String(gop), '-bf', '0', '-forced-idr', '1', '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', `${Number(encoder.audioBitrate)}k`, '-ar', '48000', '-ac', '2',
      '-af', 'aresample=async=1000',
      '-f', 'mpegts', '-mpegts_flags', '+resend_headers', '-muxdelay', '0', '-pat_period', '0.2',
      'pipe:1'
    ];
  }

  async start(input, encoder) {
    if (this.child) throw new Error('Program encoder already running');
    const args = this.args(input, encoder);
    this.instanceId += 1;
    const instance = this.instanceId;
    this.stats = this.blankStats();
    this.stats.startedAt = Date.now();
    this.stats.codec = encoder.mode === 'hardware' ? 'h264_nvenc' : 'libx264';
    const reader = new TsReader();
    this.reader = reader;
    const child = spawn(this.ffmpeg.path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    let carry = Buffer.alloc(0);
    let lastBytes = 0;
    let lastAt = Date.now();
    child.stdout.on('data', (data) => {
      const chunk = carry.length ? Buffer.concat([carry, data]) : data;
      const whole = chunk.length - (chunk.length % PACKET);
      carry = chunk.subarray(whole);
      if (!whole) return;
      const packets = chunk.subarray(0, whole);
      this.stats.bytes += packets.length;
      const now = Date.now();
      if (now - lastAt >= 1000) { this.stats.bitrateKbps = Math.round(((this.stats.bytes - lastBytes) * 8) / (now - lastAt)); lastBytes = this.stats.bytes; lastAt = now; }
      this.emit('data', { instance, packets, reader, receivedAt: now });
    });
    let progress = {};
    let errorText = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text) => {
      for (const line of text.split(/\r?\n/)) {
        const m = /^(\w+)=(.*)$/.exec(line.trim());
        if (m) {
          progress[m[1]] = m[2].trim();
          if (m[1] === 'progress') {
            this.stats.frames = Number(progress.frame) || this.stats.frames;
            this.stats.fps = Number(progress.fps) || 0;
            this.stats.dropped = Number(progress.drop_frames) || 0;
            this.stats.duplicated = Number(progress.dup_frames) || 0;
            this.stats.speed = Number(String(progress.speed || '').replace('x', '')) || 0;
            progress = {};
            this.emit('stats', this.stats);
          }
        } else if (line.trim()) errorText = `${errorText}\n${line}`.slice(-2000);
      }
    });
    await new Promise((resolve, reject) => {
      const fail = (error) => { cleanup(); reject(error); };
      const ok = () => { cleanup(); resolve(); };
      const cleanup = () => { child.off('error', fail); child.off('exit', early); child.stdout.off('data', firstData); };
      const early = (code) => fail(Object.assign(new Error(`Encoder exited during startup (code ${code}). ${errorText.trim().split('\n').pop() || ''}`.trim()), { code: 'ENCODER_EXIT' }));
      const firstData = () => ok();
      child.once('error', fail);
      child.once('exit', early);
      child.stdout.once('data', firstData);
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.emit('exit', { code, signal, expected: this.stopping, message: errorText.trim().split('\n').pop() || '' });
    });
    return instance;
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      try { child.kill('SIGTERM'); } catch { resolve(); }
    });
    this.child = null;
    this.stopping = false;
  }

  get running() { return Boolean(this.child); }
}

module.exports = { ProgramEncoder };
