'use strict';
const { deviceInput } = require('./devices.cjs');
const { obsCaptureInput } = require('./obs-capture.cjs');
// Capture sources expressed as FFmpeg input arguments. The encoder process owns capture, so
// raw frames never pass through Node or Electron.

function parseResolution(text) {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(String(text || ''));
  if (!m) throw new Error('Resolution must look like 1920x1080');
  return { width: Number(m[1]), height: Number(m[2]) };
}

// Rational frame rates: 59.94 -> 60000/1001, so timestamps never drift.
function rationalFps(fps) {
  const known = { 23.976: '24000/1001', 29.97: '30000/1001', 59.94: '60000/1001', 119.88: '120000/1001' };
  const rounded = Math.round(Number(fps) * 1000) / 1000;
  return known[rounded] || String(Number(fps));
}

// Deterministic real media: moving test pattern with a burnt-in wall clock + frame number,
// and a tone that beeps once per second (sync marker), so receivers can be checked for content.
function testSourceArgs({ resolution, fps }) {
  const { width, height } = parseResolution(resolution);
  const rate = rationalFps(fps);
  const font = Math.round(height / 14);
  const text = `drawtext=text='ISU TEST %{localtime\\:%H\\\\\\:%M\\\\\\:%S} F%{frame_num}':x=40:y=40:fontsize=${font}:fontcolor=white:box=1:boxcolor=black@0.6`;
  return [
    '-re', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${rate},${text}`,
    '-re', '-f', 'lavfi', '-i', `sine=frequency=1000:sample_rate=48000:beep_factor=4`
  ];
}

function fileSourceArgs({ file }) {
  if (!file) throw new Error('Choose a media file for the file source');
  return ['-re', '-stream_loop', '-1', '-i', file];
}

// Blackmagic DeckLink via FFmpeg's decklink input (needs an FFmpeg built with --enable-decklink
// and the Desktop Video driver). Embedded SDI audio comes in on the same device.
function decklinkSourceArgs({ device, formatCode }) {
  if (!device) throw new Error('Choose a DeckLink device');
  const args = ['-f', 'decklink', '-audio_input', 'embedded', '-channels', '2'];
  if (formatCode) args.push('-format_code', formatCode);
  args.push('-i', device);
  return args;
}

// Every source = FFmpeg input args + which input streams carry the program video and audio.
function sourceInput(input, encoder, options = {}) {
  switch (input.type) {
    case 'test': return { args: testSourceArgs(encoder), video: '0:v:0', audio: '1:a:0' };
    case 'file': return { args: fileSourceArgs(input), video: '0:v:0', audio: '0:a:0?' };
    case 'decklink': return { args: decklinkSourceArgs(input), video: '0:v:0', audio: '0:a:0?' };
    // Webcams, capture cards, OBS Virtual Camera... (DirectShow on Windows, v4l2 on Linux).
    case 'device': return deviceInput(input, options);
    // Same devices, captured by OBS's libdshowcapture through the isu-capture helper (Windows).
    case 'obs-device': return obsCaptureInput(input, options);
    default: throw new Error(`Unknown input type: ${input.type}`);
  }
}

function sourceArgs(input, encoder, options) { return sourceInput(input, encoder, options).args; }

module.exports = { sourceInput, sourceArgs, rationalFps, parseResolution };
