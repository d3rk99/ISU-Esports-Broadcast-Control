const { ICaptureSource, IEncoder, IDelayBuffer, IStreamDestination, IStreamOutputManager } = require('./contracts.cjs');
class SimCapture extends ICaptureSource {
  async discover() { return { video: ['Simulation SDI 1', 'Simulation camera'], audio: ['Simulation embedded audio', 'Simulation microphone'] }; }
  async start(settings) { this.emit('signal', { connected: true, resolution: '1920x1080', fps: 59.94 }); }
  async stop() { this.emit('signal', { connected: false }); }
}
class SimEncoder extends IEncoder {
  async start(settings) { this.emit('state', 'ENCODING'); }
  async write(frame) {} // No actual frames or encoded packets are generated.
  async stop() { this.emit('state', 'READY'); }
}
class SimDelay extends IDelayBuffer {
  constructor() { super(); this.seconds = 300; this.filled = 0; this.valid = false; }
  async configure(seconds) { this.seconds = seconds; await this.reset(); }
  async reset() { this.filled = 0; this.valid = false; this.report(); }
  tick(seconds) { this.valid = true; this.filled = Math.min(this.seconds, this.filled + seconds); this.report(); }
  report() { this.emit('status', { filledSeconds: this.filled, configuredSeconds: this.seconds, ready: this.valid && this.filled >= this.seconds, effectiveDelaySeconds: this.filled }); }
  async write(packet) {}
  async close() { await this.reset(); }
}
class SimDestination extends IStreamDestination {
  constructor() { super(); this.state = 'STOPPED'; this.reconnectCount = 0; this.elapsed = 0; }
  set(state) { this.state = state; this.elapsed = 0; this.emit('state', state); }
  async start() { if (!['CONNECTED', 'CONNECTING', 'RECONNECTING'].includes(this.state)) this.set('CONNECTING'); }
  async stop() { this.set('STOPPED'); }
  async write(packet) {}
  fail() { if (this.state === 'CONNECTED') this.set('ERROR'); }
  tick(seconds) {
    this.elapsed += seconds;
    if (this.state === 'ERROR' && this.elapsed >= 1) { this.reconnectCount++; this.set('RECONNECTING'); }
    else if (['CONNECTING', 'RECONNECTING'].includes(this.state) && this.elapsed >= 1) this.set('CONNECTED');
  }
}
class SimOutputManager extends IStreamOutputManager {
  constructor(canStart, logger) { super(); this.canStart = canStart; this.logger = logger; this.outputs = new Map(); }
  configure(definitions) {
    this.definitions = definitions;
    this.outputs.clear();
    for (const [index, d] of definitions.entries()) {
      const output = new SimDestination();
      output.on('state', state => { this.logger.write(state === 'RECONNECTING' ? 'reconnect.attempt' : state === 'CONNECTING' ? 'destination.connect' : state === 'CONNECTED' ? 'stream.start' : state === 'ERROR' ? 'destination.error' : 'stream.stop', { state, destinationIndex: index + 1 }); this.emit('change'); });
      this.outputs.set(d.id, output);
    }
  }
  async start(id) {
    if (!this.canStart()) throw new Error('Outputs locked: input and delay buffer must be ready');
    const d = this.definitions.find(d => d.id === id);
    if (!d || !d.enabled) throw new Error('Destination missing or disabled');
    await this.outputs.get(id).start();
  }
  async stop(id) { if (!this.outputs.has(id)) throw new Error('Unknown destination'); await this.outputs.get(id).stop(); }
  async startAll() { if (!this.canStart()) throw new Error('Outputs locked: input and delay buffer must be ready'); for (const d of this.definitions.filter(d => d.enabled)) await this.start(d.id); }
  async stopAll() { for (const o of this.outputs.values()) await o.stop(); }
  async publish(packet) { /* Future bounded per-output queues; never instantiate an encoder here. */ }
  tick(seconds) { for (const o of this.outputs.values()) o.tick(seconds); }
  snapshot() { return this.definitions.map(d => ({ id: d.id, state: d.enabled ? this.outputs.get(d.id).state : 'DISABLED', reconnectCount: this.outputs.get(d.id).reconnectCount })); }
}
module.exports = { SimCapture, SimEncoder, SimDelay, SimOutputManager };
