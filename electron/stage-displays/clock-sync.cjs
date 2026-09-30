'use strict';

// NTP-style clock offset between a stage station and the controller.
// offsetMs = controllerClock - localClock. A controller timestamp T maps to local time T - offsetMs.
// Keeps the best (lowest round-trip) samples, since those have the least network noise.
const MAX_SAMPLES = 8;
const MAX_TRUSTED_RTT_MS = 1000;

class ClockSync {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.samples = [];
  }

  // clientSentAt: our clock when we sent the ping; serverAt: controller clock when it answered.
  addSample(clientSentAt, serverAt, receivedAt = this.now()) {
    const sent = Number(clientSentAt);
    const server = Number(serverAt);
    const received = Number(receivedAt);
    if (!Number.isFinite(sent) || !Number.isFinite(server) || !Number.isFinite(received) || received < sent) return null;
    const rttMs = received - sent;
    if (rttMs > MAX_TRUSTED_RTT_MS) return null;
    const offsetMs = server - (sent + rttMs / 2);
    this.samples.push({ offsetMs, rttMs });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    return { offsetMs, rttMs };
  }

  get ready() {
    return this.samples.length > 0;
  }

  // Median offset of the best half of samples by round-trip time.
  get offsetMs() {
    if (!this.samples.length) return 0;
    const best = [...this.samples].sort((a, b) => a.rttMs - b.rttMs).slice(0, Math.max(1, Math.ceil(this.samples.length / 2)));
    const offsets = best.map((sample) => sample.offsetMs).sort((a, b) => a - b);
    const mid = Math.floor(offsets.length / 2);
    return offsets.length % 2 ? offsets[mid] : (offsets[mid - 1] + offsets[mid]) / 2;
  }

  get rttMs() {
    if (!this.samples.length) return null;
    return Math.min(...this.samples.map((sample) => sample.rttMs));
  }

  // Controller executeAt (seconds, controller clock) -> local executeAt (seconds, local clock).
  toLocalSeconds(controllerSeconds) {
    const value = Number(controllerSeconds);
    if (!Number.isFinite(value) || value <= 0) return null;
    return (value * 1000 - this.offsetMs) / 1000;
  }

  reset() {
    this.samples = [];
  }
}

module.exports = { ClockSync, MAX_TRUSTED_RTT_MS };
