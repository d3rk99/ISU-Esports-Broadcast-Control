'use strict';
// Health = measured facts, not requested settings. Shared by the UI and the Companion API so a
// Stream Deck button and the app always agree.
//
// Destination LIVE    : state CONNECTED.
// Destination HEALTHY : LIVE and its sent-byte counter advanced in the last STALL_MS, and it has
//                       not skipped chunks (fell behind) in the last WINDOW_MS.
// Program HEALTHY     : encoder running at >= 90% of the target fps, no new dropped frames in the
//                       last WINDOW_MS, audio present, not silent for >= SILENCE_S, delay ready.
const STALL_MS = 5000;
const WINDOW_MS = 30000;
const SILENCE_S = 10;

class HealthTracker {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.outputs = new Map(); // id -> { bytes, progressAt, dropped, droppedAt }
    this.dropped = { frames: 0, at: 0 };
  }

  output(o) {
    const t = this.now();
    let h = this.outputs.get(o.id);
    // bytes start at 0 so the first sighting of a moving counter counts as progress; null = never moved.
    if (!h) { h = { bytes: 0, progressAt: null, dropped: o.droppedChunks || 0, droppedAt: 0 }; this.outputs.set(o.id, h); }
    if ((o.sentBytes || 0) > h.bytes) { h.bytes = o.sentBytes; h.progressAt = t; }
    if ((o.sentBytes || 0) < h.bytes) h.bytes = o.sentBytes || 0; // counter reset (restart)
    if ((o.droppedChunks || 0) > h.dropped) { h.dropped = o.droppedChunks; h.droppedAt = t; }
    const live = o.state === 'CONNECTED';
    const flowing = live && h.progressAt !== null && t - h.progressAt < STALL_MS;
    const lagging = live && h.droppedAt && t - h.droppedAt < WINDOW_MS;
    let health = 'OFF';
    if (o.state === 'DISABLED') health = 'DISABLED';
    else if (o.state === 'ERROR' || o.state === 'RECONNECTING') health = 'FAILED';
    else if (o.state === 'CONNECTING') health = 'STARTING';
    else if (live) health = !flowing ? 'STALLED' : lagging ? 'LAGGING' : 'HEALTHY';
    return { live, healthy: health === 'HEALTHY', health };
  }

  program(s, targetFps) {
    const t = this.now();
    const frames = s.telemetry?.droppedFrames || 0;
    if (frames > this.dropped.frames) this.dropped = { frames, at: t };
    if (frames < this.dropped.frames) this.dropped = { frames, at: 0 };
    const problems = [];
    if (s.encoder !== 'ENCODING') problems.push('ENCODER');
    else {
      if ((s.telemetry?.fps || 0) < targetFps * 0.9) problems.push('LOW_FPS');
      if (this.dropped.at && t - this.dropped.at < WINDOW_MS) problems.push('DROPPED_FRAMES');
      const p = s.preview;
      if (p?.running && p.audioLive === false) problems.push('NO_AUDIO');
      else if (p?.silentSeconds >= SILENCE_S) problems.push('SILENT');
      if (s.telemetry?.avSyncWarning) problems.push('NO_AUDIO');
    }
    if (!s.buffer?.ready) problems.push('BUFFERING');
    return { healthy: !problems.length, problems: [...new Set(problems)] };
  }

  forget(ids) { for (const id of this.outputs.keys()) if (!ids.includes(id)) this.outputs.delete(id); }
}

module.exports = { HealthTracker, STALL_MS, WINDOW_MS, SILENCE_S };
