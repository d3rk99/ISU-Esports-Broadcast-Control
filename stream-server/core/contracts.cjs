const { EventEmitter } = require('node:events');
// Ports only: implementations must supply lifecycle and backpressure semantics.
// Event payloads and ownership rules are specified in ARCHITECTURE.md.
class ICaptureSource extends EventEmitter {
  async discover() { throw new Error('Not implemented'); }
  async start(settings) { throw new Error('Not implemented'); }
  async stop() { throw new Error('Not implemented'); }
}
class IEncoder extends EventEmitter {
  async start(settings) { throw new Error('Not implemented'); }
  async write(frame) { throw new Error('Not implemented'); }
  async stop() { throw new Error('Not implemented'); }
}
class IDelayBuffer extends EventEmitter {
  async configure(seconds) { throw new Error('Not implemented'); }
  async write(packet) { throw new Error('Not implemented'); }
  async reset() { throw new Error('Not implemented'); }
  async close() { throw new Error('Not implemented'); }
}
class IStreamMuxer {
  async write(packet) { throw new Error('Not implemented'); }
  async close() { throw new Error('Not implemented'); }
}
class IStreamDestination extends EventEmitter {
  async start(definition, credential) { throw new Error('Not implemented'); }
  async write(packet) { throw new Error('Not implemented'); }
  async stop() { throw new Error('Not implemented'); }
}
class IStreamOutputManager extends EventEmitter {
  async start(id) { throw new Error('Not implemented'); }
  async stop(id) { throw new Error('Not implemented'); }
  async startAll() { throw new Error('Not implemented'); }
  async stopAll() { throw new Error('Not implemented'); }
  async publish(packet) { throw new Error('Not implemented'); }
}
class ICredentialStore {
  seal(secret) { throw new Error('Not implemented'); }
  open(reference) { throw new Error('Not implemented'); }
}
module.exports = { ICaptureSource, IEncoder, IDelayBuffer, IStreamMuxer, IStreamDestination, IStreamOutputManager, ICredentialStore };
