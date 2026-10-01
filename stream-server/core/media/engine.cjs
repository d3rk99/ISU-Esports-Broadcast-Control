'use strict';
const { EventEmitter } = require('node:events');
const { ProgramEncoder } = require('./encoder.cjs');
const { DelayBuffer } = require('./delay.cjs');
const { Destination } = require('./output.cjs');

// Real media engine: one program encoder -> one delay buffer -> N stream-copy destinations.
// The interlock lives HERE, at the byte boundary: a chunk reaches a destination only if it came
// out of DelayBuffer.release() for the current epoch, which only happens after it aged.
class RealEngine extends EventEmitter {
  constructor({ ffmpeg, storageDir, credentials, logger }) {
    super();
    this.ffmpeg = ffmpeg;
    this.credentials = credentials;
    this.logger = logger;
    this.encoder = new ProgramEncoder(ffmpeg);
    this.delay = new DelayBuffer({ directory: storageDir });
    this.destinations = new Map();
    this.state = 'STOPPED'; // STOPPED | STARTING | RUNNING | ERROR
    this.error = '';
    this.instance = 0;

    this.encoder.on('data', (packet) => { if (packet.instance === this.instance) this.delay.write(packet); });
    this.encoder.on('stats', () => this.emit('status'));
    this.encoder.on('exit', ({ expected, message, code }) => {
      if (expected) return;
      // Encoder/input died: fail closed. Stop outputs, discard the buffer, report the error.
      this.logger.write('encoder.state', { state: 'CRASHED', code: 'ENCODER_EXIT' });
      this.state = 'ERROR';
      this.error = `Encoder stopped unexpectedly (code ${code}). ${message}`.trim();
      this.stopAllOutputs().then(() => this.delay.reset()).finally(() => this.emit('status'));
    });
    this.delay.on('chunk', (chunk) => {
      if (chunk.epoch !== this.delay.epoch || !this.delay.primed) return;
      for (const destination of this.destinations.values()) destination.push({ ...chunk, instance: this.instance });
      this.lastRelease = chunk;
    });
    this.delay.on('failure', (failure) => {
      this.logger.write('delay.state', { state: 'FAILED', code: failure.code });
      this.state = 'ERROR';
      this.error = `Delay storage failed: ${failure.message}`;
      this.stopAllOutputs().finally(() => this.emit('status'));
    });
    this.delay.on('status', () => this.emit('status'));
  }

  async init() { await this.delay.init(); }

  configureDestinations(definitions) {
    for (const [id, destination] of this.destinations) {
      if (!definitions.some((d) => d.id === id)) { destination.stop(); this.destinations.delete(id); }
    }
    for (const d of definitions) {
      const existing = this.destinations.get(d.id);
      if (existing) { existing.definition = d; continue; }
      const destination = new Destination({ ffmpegPath: this.ffmpeg.path, definition: d, getKey: () => this.credentials.open(this.lookup(d.id)?.credential || '') });
      destination.on('state', (state) => {
        const index = definitions.findIndex((x) => x.id === d.id) + 1;
        this.logger.write(state === 'ERROR' ? 'destination.error' : state === 'RECONNECTING' ? 'reconnect.attempt' : `destination.${state.toLowerCase()}`, { state, destinationIndex: index });
        this.emit('status');
      });
      this.destinations.set(d.id, destination);
    }
    this.definitions = definitions;
  }

  lookup(id) { return this.definitions?.find((d) => d.id === id); }

  // (Re)start capture + encode with a fresh, empty delay epoch.
  async startProgram(config) {
    this.state = 'STARTING';
    this.error = '';
    this.emit('status');
    await this.stopAllOutputs();
    await this.encoder.stop();
    await this.delay.preflight(config.delaySeconds, config.encoder.videoBitrate, config.encoder.audioBitrate);
    await this.delay.reset(config.delaySeconds);
    try {
      this.instance = await this.encoder.start(config.input, config.encoder);
      this.state = 'RUNNING';
      this.logger.write('encoder.state', { state: 'ENCODING' });
    } catch (error) {
      this.state = 'ERROR';
      this.error = error.message;
      this.logger.write('encoder.state', { state: 'FAILED', code: error.code || 'ENCODER_START' });
      throw error;
    } finally { this.emit('status'); }
  }

  async stopProgram() {
    await this.stopAllOutputs();
    await this.encoder.stop();
    await this.delay.reset();
    this.state = 'STOPPED';
    this.emit('status');
  }

  ready() { return this.state === 'RUNNING' && this.encoder.running && this.delay.status().ready; }

  assertReady() {
    if (!this.ready()) throw new Error(this.state !== 'RUNNING' ? 'Outputs locked: the program encoder is not running' : 'Outputs locked: the delay buffer has not filled with decodable audio and video yet');
  }

  async startOutput(id) {
    this.assertReady();
    const destination = this.destinations.get(id);
    const definition = this.lookup(id);
    if (!destination || !definition) throw new Error('Unknown destination');
    if (!definition.enabled) throw new Error('Destination is disabled');
    if (!definition.serverUrl) throw new Error(`${definition.name}: set a server URL before starting`);
    destination.start();
  }

  async stopOutput(id) {
    const destination = this.destinations.get(id);
    if (!destination) throw new Error('Unknown destination');
    await destination.stop();
  }

  async startAll() {
    this.assertReady();
    const failures = [];
    for (const d of this.definitions.filter((x) => x.enabled)) {
      try { await this.startOutput(d.id); } catch (error) { failures.push(error.message); }
    }
    if (failures.length) throw new Error(failures.join(' · '));
  }

  async stopAllOutputs() { await Promise.all([...this.destinations.values()].map((d) => d.stop())); }

  snapshot() {
    const delay = this.delay.status();
    const stats = this.encoder.stats;
    return {
      engine: this.state,
      error: this.error,
      encoderInstance: this.instance,
      encoder: { running: this.encoder.running, codec: stats.codec, fps: stats.fps, frames: stats.frames, dropped: stats.dropped, duplicated: stats.duplicated, bitrateKbps: stats.bitrateKbps, speed: stats.speed, uptimeSeconds: stats.startedAt && this.encoder.running ? (Date.now() - stats.startedAt) / 1000 : 0 },
      delay,
      lastReleaseAgeMs: this.lastRelease ? Math.round(this.lastRelease.ageMs) : null,
      outputs: [...this.destinations.entries()].map(([id, d]) => ({ id, ...d.snapshot() }))
    };
  }

  async close() {
    await this.stopAllOutputs();
    await this.encoder.stop();
    await this.delay.close();
  }
}

module.exports = { RealEngine };
