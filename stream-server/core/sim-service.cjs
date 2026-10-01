const { EventEmitter } = require('node:events');
const { SimCapture, SimEncoder, SimDelay, SimOutputManager } = require('./simulation.cjs');
// SIMULATION ONLY (Codex scaffold). Selected explicitly with engine: 'simulation'; never a fallback.
class SimStreamService extends EventEmitter {
  constructor(store, logger) {
    super(); this.store = store; this.logger = logger; this.config = store.load();
    this.capture = new SimCapture(); this.encoder = new SimEncoder(); this.delay = new SimDelay();
    this.input = { connected: false }; this.encoderState = 'READY'; this.buffer = { ready: false, filledSeconds: 0 }; this.uptime = 0; this.speed = 1;
    this.outputs = new SimOutputManager(() => this.input.connected && this.buffer.ready, logger);
    this.outputs.configure(this.config.destinations);
    this.capture.on('signal', signal => { this.input = signal; logger.write('input.state', { state: signal.connected ? 'CONNECTED' : 'NO_SIGNAL' }); });
    this.encoder.on('state', state => { this.encoderState = state; logger.write('encoder.state', { state }); });
    this.delay.on('status', status => { if (this.buffer.ready !== status.ready) logger.write('delay.state', { state: status.ready ? 'READY' : 'BUFFERING', seconds: status.filledSeconds }); this.buffer = status; });
    this.outputs.on('change', () => this.emit('status', this.status()));
  }
  async initialize() { this.devices = await this.capture.discover(); this.logger.write('device.discovery', { count: this.devices.video.length }); await this.delay.configure(this.config.delaySeconds); await this.capture.start(this.config.input); await this.encoder.start(this.config.encoder); this.tick(0); }
  tick(seconds) { this.uptime += seconds; if (this.input.connected) this.delay.tick(seconds * this.speed); this.outputs.tick(seconds); this.emit('status', this.status()); }
  status() { return { simulation: true, engine: 'SIMULATION', input: this.input, encoder: this.encoderState, buffer: this.buffer, outputsLocked: !this.input.connected || !this.buffer.ready, outputs: this.outputs.snapshot(), uptime: this.uptime, speed: this.speed, telemetry: { currentBitrateKbps: this.input.connected ? this.config.encoder.videoBitrate : 0, droppedFrames: 0, encodedFrames: 0, avSyncWarning: false } }; }
  view() { return { config: this.store.publicConfig(this.config), devices: this.devices, status: this.status() }; }
  async command(action, payload = {}) {
    switch (action) {
      case 'startAll': await this.outputs.startAll(); break;
      case 'stopAll': await this.outputs.stopAll(); break;
      case 'start': await this.outputs.start(payload.id); break;
      case 'stop': await this.outputs.stop(payload.id); break;
      case 'save': {
        const next = this.store.prepare(payload, this.config);
        // A settings change invalidates every connection and the readiness proof.
        await this.outputs.stopAll(); this.store.save(next); this.config = next;
        this.outputs.configure(next.destinations); await this.delay.configure(next.delaySeconds);
        await this.encoder.stop(); await this.capture.stop(); await this.capture.start(next.input); await this.encoder.start(next.encoder); this.tick(0); break;
      }
      case 'speed': if (![1, 30, 60].includes(payload.value)) throw new Error('Invalid simulation speed'); this.speed = payload.value; break;
      case 'signal':
        await this.outputs.stopAll(); await this.delay.reset();
        if (this.input.connected) { await this.capture.stop(); await this.encoder.stop(); } else { await this.capture.start(this.config.input); await this.encoder.start(this.config.encoder); this.tick(0); } break;
      case 'reset': await this.outputs.stopAll(); await this.delay.reset(); this.tick(0); break;
      case 'fail': { const output = this.outputs.outputs.get(payload.id); if (!output) throw new Error('Unknown destination'); output.fail(); break; }
      default: throw new Error('Unknown command');
    }
    this.emit('status', this.status()); return this.view();
  }
  async close() { await this.outputs.stopAll(); await this.encoder.stop(); await this.capture.stop(); await this.delay.close(); }
}
module.exports = { SimStreamService };
