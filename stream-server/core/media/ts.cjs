'use strict';
// Minimal MPEG-TS reader for the encoded program stream. It never rewrites media: it only
// learns the PIDs (PAT/PMT), spots video random-access points and PTS so the delay buffer
// can cut chunks on keyframes and prove the stream is contiguous, synchronized A/V.
const PACKET = 188;
const STREAM_VIDEO = new Set([0x1b, 0x24]); // H.264, HEVC
const STREAM_AUDIO = new Set([0x0f, 0x11, 0x03, 0x04, 0x81]); // AAC ADTS/LATM, MPEG audio, AC-3

function readPts(buf, at) {
  // 33-bit PTS spread over 5 bytes; returns a Number (safe: < 2^53).
  return ((buf[at] & 0x0e) * 536870912) + (buf[at + 1] << 22) + ((buf[at + 2] & 0xfe) << 14) + (buf[at + 3] << 7) + (buf[at + 4] >> 1);
}

class TsReader {
  constructor() {
    this.pmtPid = -1;
    this.videoPid = -1;
    this.audioPid = -1;
    this.pat = null; // latest PAT packet (Buffer copy)
    this.pmt = null; // latest PMT packet
    this.continuity = new Map();
    this.continuityErrors = 0;
  }

  // Inspect one 188-byte packet. Returns { pid, video, audio, keyframe, pts }.
  inspect(packet) {
    if (packet[0] !== 0x47) throw new Error('MPEG-TS sync lost');
    const pid = ((packet[1] & 0x1f) << 8) | packet[2];
    const pusi = (packet[1] & 0x40) !== 0;
    const afc = (packet[3] >> 4) & 0x3;
    const cc = packet[3] & 0x0f;
    let offset = 4;
    let keyframe = false;
    if (afc & 0x2) {
      const afLength = packet[4];
      if (afLength > 0) keyframe = (packet[5] & 0x40) !== 0; // random_access_indicator
      offset = 5 + afLength;
    }
    if ((afc & 0x1) && pid !== 0x1fff) {
      const last = this.continuity.get(pid);
      if (last !== undefined && ((last + 1) & 0x0f) !== cc) this.continuityErrors += 1;
      this.continuity.set(pid, cc);
    }
    const info = { pid, video: false, audio: false, keyframe: false, pts: null };
    if (!(afc & 0x1) || offset >= PACKET) return info;
    if (pid === 0) { this.parsePat(packet, offset, pusi); this.pat = Buffer.from(packet); return info; }
    if (pid === this.pmtPid) { this.parsePmt(packet, offset, pusi); this.pmt = Buffer.from(packet); return info; }
    if (pid === this.videoPid) { info.video = true; info.keyframe = keyframe && pusi; }
    else if (pid === this.audioPid) info.audio = true;
    else return info;
    if (pusi && packet[offset] === 0 && packet[offset + 1] === 0 && packet[offset + 2] === 1 && (packet[offset + 7] & 0x80)) info.pts = readPts(packet, offset + 9);
    return info;
  }

  parsePat(packet, offset, pusi) {
    if (!pusi) return;
    const start = offset + 1 + packet[offset];
    const sectionLength = ((packet[start + 1] & 0x0f) << 8) | packet[start + 2];
    const end = Math.min(start + 3 + sectionLength - 4, PACKET);
    for (let at = start + 8; at + 4 <= end; at += 4) {
      const program = (packet[at] << 8) | packet[at + 1];
      if (program !== 0) { this.pmtPid = ((packet[at + 2] & 0x1f) << 8) | packet[at + 3]; return; }
    }
  }

  parsePmt(packet, offset, pusi) {
    if (!pusi) return;
    const start = offset + 1 + packet[offset];
    const sectionLength = ((packet[start + 1] & 0x0f) << 8) | packet[start + 2];
    const end = Math.min(start + 3 + sectionLength - 4, PACKET);
    const infoLength = ((packet[start + 10] & 0x0f) << 8) | packet[start + 11];
    for (let at = start + 12 + infoLength; at + 5 <= end;) {
      const type = packet[at];
      const pid = ((packet[at + 1] & 0x1f) << 8) | packet[at + 2];
      const esLength = ((packet[at + 3] & 0x0f) << 8) | packet[at + 4];
      if (STREAM_VIDEO.has(type) && this.videoPid < 0) this.videoPid = pid;
      if (STREAM_AUDIO.has(type) && this.audioPid < 0) this.audioPid = pid;
      at += 5 + esLength;
    }
  }

  // PAT + PMT to prepend when an output joins mid-stream.
  headers() { return this.pat && this.pmt ? Buffer.concat([this.pat, this.pmt]) : null; }
}

module.exports = { TsReader, PACKET };
