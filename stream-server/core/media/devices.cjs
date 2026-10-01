'use strict';
// Capture devices, like OBS's "Video Capture Device": webcams, capture cards (Elgato, Magewell,
// AVerMedia...), virtual cameras (OBS Virtual Camera) and DeckLink through its DirectShow driver.
// FFmpeg backend per platform: Windows = dshow, Linux = v4l2 (+ PulseAudio), macOS = avfoundation.
// Enumeration only reads FFmpeg's device listing; nothing is captured while scanning.
const { execFile } = require('node:child_process');

const COMPRESSED = new Set(['mjpeg', 'h264', 'hevc', 'h265']);
const BACKEND = { win32: 'dshow', linux: 'v4l2', darwin: 'avfoundation' };

function backendFor(platform = process.platform) { return BACKEND[platform] || ''; }

function runText(file, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => resolve(`${stdout || ''}\n${stderr || ''}`));
  });
}

// `ffmpeg -sources <dev>` lines: "  <id> [<description>] (video, audio)"
function parseSources(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s+(\S.*?)\s+\[(.*)\]\s*\(([^)]*)\)\s*$/.exec(line);
    if (!m) continue;
    const kinds = m[3].split(/[,\s]+/).filter(Boolean);
    out.push({ id: m[1], name: m[2] || m[1], kinds });
  }
  return out;
}

// Classic `ffmpeg -list_devices true -f dshow -i dummy` output (older/newer FFmpeg both use it):
//   [dshow @ ..] "OBS Virtual Camera" (video)
//   [dshow @ ..]   Alternative name "@device_sw_{...}\{...}"
function parseDshowList(text) {
  const out = [];
  let section = '';
  for (const line of String(text).split(/\r?\n/)) {
    if (/DirectShow video devices/i.test(line)) { section = 'video'; continue; }
    if (/DirectShow audio devices/i.test(line)) { section = 'audio'; continue; }
    const alt = /Alternative name\s+"(.+)"/.exec(line);
    if (alt && out.length) { out[out.length - 1].alternative = alt[1]; continue; }
    const dev = /\]\s+"(.+)"(?:\s+\(([^)]*)\))?\s*$/.exec(line);
    if (!dev) continue;
    const kinds = dev[2] ? dev[2].split(/[,\s]+/).filter((k) => k === 'video' || k === 'audio') : (section ? [section] : []);
    if (!kinds.length) continue; // "(none)" = no usable pins
    out.push({ id: dev[1], name: dev[1], kinds });
  }
  return out;
}

// DirectShow pin options (`-list_options true`):
//   vcodec=mjpeg  min s=1920x1080 fps=30 max s=1920x1080 fps=60.0002
//   pixel_format=nv12  min s=1280x720 fps=5 max s=1280x720 fps=59.9402
function parseDshowOptions(text) {
  const modes = [];
  const seen = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /(vcodec|pixel_format)=(\S+)\s+min s=(\d+x\d+) fps=([\d.]+)\s+max s=(\d+x\d+) fps=([\d.]+)/.exec(line);
    if (!m) continue;
    const fps = tidyFps(Number(m[6]));
    const mode = { format: m[2], size: m[5], fps, label: `${m[5]} @ ${fps} fps · ${m[2]}` };
    const key = mode.label;
    if (!seen.has(key)) { seen.add(key); modes.push(mode); }
  }
  return sortModes(modes);
}

// v4l2 `-list_formats all`:
//   [video4linux2,v4l2 @ ..] Compressed:  mjpeg : Motion-JPEG : 640x480 1280x720 1920x1080
function parseV4l2Formats(text) {
  const modes = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /(Raw|Compressed)\s*:\s*(\S+)\s*:\s*[^:]*:\s*(.+)$/.exec(line);
    if (!m) continue;
    for (const size of m[3].trim().split(/\s+/)) {
      if (/^\d+x\d+$/.test(size)) modes.push({ format: m[2], size, fps: '', label: `${size} · ${m[2]}` });
    }
  }
  return sortModes(modes);
}

function tidyFps(f) {
  for (const known of [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 119.88, 120]) if (Math.abs(f - known) < 0.02) return known;
  return Math.round(f * 100) / 100;
}

function sortModes(modes) {
  const px = (s) => s.split('x').reduce((a, b) => a * Number(b), 1);
  return modes.sort((a, b) => px(b.size) - px(a.size) || (Number(b.fps) || 0) - (Number(a.fps) || 0));
}

// List capture devices. Returns { backend, video:[{id,name}], audio:[{id,name}], error }.
async function listDevices(ffmpegPath, { platform = process.platform, run = runText } = {}) {
  const backend = backendFor(platform);
  if (!backend) return { backend: '', video: [], audio: [], error: `Capture devices are not supported on ${platform}` };
  let found = [];
  if (backend === 'dshow') {
    found = parseSources(await run(ffmpegPath, ['-hide_banner', '-sources', 'dshow']));
    if (!found.length) found = parseDshowList(await run(ffmpegPath, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']));
    // dshow ids: prefer the friendly name; FFmpeg -sources gives the @device path as id, which is
    // stable even when two identical capture cards share a name.
  } else if (backend === 'v4l2') {
    found = parseSources(await run(ffmpegPath, ['-hide_banner', '-sources', 'v4l2'])).map((d) => ({ ...d, kinds: ['video'] }));
    const pulse = parseSources(await run(ffmpegPath, ['-hide_banner', '-sources', 'pulse'])).map((d) => ({ ...d, kinds: ['audio'] }));
    found = found.concat(pulse);
  } else {
    const text = await run(ffmpegPath, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
    let section = '';
    for (const line of text.split(/\r?\n/)) {
      if (/video devices/i.test(line)) section = 'video';
      else if (/audio devices/i.test(line)) section = 'audio';
      const m = /\]\s+\[(\d+)\]\s+(.+)$/.exec(line);
      if (m && section) found.push({ id: m[1], name: m[2].trim(), kinds: [section] });
    }
  }
  // Two identical cards share a friendly name: add the id so the operator can tell them apart.
  const pick = (kind) => {
    const list = found.filter((d) => d.kinds.includes(kind));
    const count = (n) => list.filter((d) => d.name === n).length;
    return list.map(({ id, name }) => ({ id, name: count(name) > 1 && id !== name ? `${name} (${id.length > 40 ? `…${id.slice(-24)}` : id})` : name }));
  };
  return { backend, video: pick('video'), audio: pick('audio'), error: '' };
}

// Modes (resolution / fps / pixel format) one video device offers. May fail if the device is
// already open in another app; the caller shows that error and "Device default" still works.
async function listModes(ffmpegPath, device, { platform = process.platform, run = runText } = {}) {
  const backend = backendFor(platform);
  if (!device) return [];
  if (backend === 'dshow') return parseDshowOptions(await run(ffmpegPath, ['-hide_banner', '-list_options', 'true', '-f', 'dshow', '-i', `video=${device}`]));
  if (backend === 'v4l2') return parseV4l2Formats(await run(ffmpegPath, ['-hide_banner', '-list_formats', 'all', '-f', 'v4l2', '-i', device]));
  return [];
}

// FFmpeg input arguments for a capture device + where its video/audio streams end up.
// Audio: same dshow input when possible (one clock, best sync), otherwise a second input, or
// generated silence when "None" so the program always carries an AAC track.
function deviceInput(input, { platform = process.platform } = {}) {
  const backend = backendFor(platform);
  const video = String(input.videoDevice || '').trim();
  const audio = String(input.audioDevice || '').trim();
  if (!video) throw Object.assign(new Error('Choose a video capture device (Source → Video capture device → Refresh)'), { code: 'NO_DEVICE' });
  if (!backend) throw new Error(`Capture devices are not supported on ${platform}`);
  const fmt = String(input.deviceFormat || '').trim().toLowerCase();
  const size = String(input.videoSize || '').trim();
  const rate = String(input.framerate || '').trim();
  const opts = [];
  if (size) opts.push('-video_size', size);
  if (rate) opts.push('-framerate', rate);
  const silence = ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
  if (backend === 'dshow') {
    if (/:/.test(video) || /:/.test(audio)) throw new Error('DirectShow device names cannot contain ":"; pick the device again from the list');
    if (fmt) opts.push(COMPRESSED.has(fmt) ? '-vcodec' : '-pixel_format', fmt);
    const target = audio ? `video=${video}:audio=${audio}` : `video=${video}`;
    // A/V sync, the way OBS's win-dshow/libdshowcapture does it:
    //  - video + audio in ONE dshow graph (same reference clock), never two inputs;
    //  - each sample keeps the device's own capture timestamp (NOT arrival time: arrival-time
    //    stamping made audio late by one audio buffer);
    //  - small audio buffers: OBS asks the pin for 10 ms (SetAudioBuffering). FFmpeg's default is the
    //    device default, typically 500 ms+, so audio arrived in big late lumps.
    const audioBufferMs = Math.max(5, Math.min(500, Number(input.audioBufferMs) || 10));
    const args = ['-f', 'dshow', '-rtbufsize', '256M', '-thread_queue_size', '1024', '-fflags', 'nobuffer', '-probesize', '1M', '-analyzeduration', '0', ...(audio ? ['-audio_buffer_size', String(audioBufferMs)] : []), ...opts, '-i', target];
    return audio ? { args, video: '0:v:0', audio: '0:a:0' } : { args: [...args, ...silence], video: '0:v:0', audio: '1:a:0' };
  }
  if (backend === 'v4l2') {
    if (fmt) opts.push('-input_format', fmt);
    const args = ['-f', 'v4l2', '-thread_queue_size', '1024', '-fflags', 'nobuffer', ...opts, '-i', video];
    return audio ? { args: [...args, '-f', 'pulse', '-thread_queue_size', '1024', '-i', audio], video: '0:v:0', audio: '1:a:0' } : { args: [...args, ...silence], video: '0:v:0', audio: '1:a:0' };
  }
  const args = ['-f', 'avfoundation', ...opts, '-i', `${video}:${audio || 'none'}`];
  return audio ? { args, video: '0:v:0', audio: '0:a:0' } : { args: [...args, ...silence], video: '0:v:0', audio: '1:a:0' };
}

module.exports = { listDevices, listModes, deviceInput, parseSources, parseDshowList, parseDshowOptions, parseV4l2Formats, backendFor, tidyFps };
