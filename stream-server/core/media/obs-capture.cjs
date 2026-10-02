'use strict';
// "OBS engine" capture: runs isu-capture.exe (native/capture, built on OBS's libdshowcapture) which
// writes raw video + PCM with each sample's real capture time as live Matroska on stdout. That
// stdout is piped straight into the program encoder's stdin (OS pipe, never through Node).
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function captureExeCandidates(configured = '') {
  const list = [];
  if (configured) list.push(configured);
  if (process.env.ISU_CAPTURE) list.push(process.env.ISU_CAPTURE);
  if (process.resourcesPath) list.push(path.join(process.resourcesPath, 'capture', 'isu-capture.exe'));
  list.push(path.join(__dirname, '..', '..', 'vendor', 'capture', 'isu-capture.exe'));
  return list;
}

function findCaptureExe(configured = '') {
  for (const candidate of captureExeCandidates(configured)) if (fs.existsSync(candidate)) return candidate;
  return '';
}

// Helper command + the FFmpeg input that reads it. Audio is always present in the program: device
// audio when chosen, otherwise generated silence on a second input.
function obsCaptureInput(input, { exe = findCaptureExe(input.captureExe), platform = process.platform } = {}) {
  if (platform !== 'win32') throw Object.assign(new Error('The OBS capture engine is Windows-only. Use "Video capture device" on this computer.'), { code: 'OBS_CAPTURE_PLATFORM' });
  if (!exe) throw Object.assign(new Error('isu-capture.exe was not found. Build it (stream-server/native/capture/README.md) and put isu-capture.exe + libdshowcapture.dll in stream-server/vendor/capture/.'), { code: 'OBS_CAPTURE_MISSING' });
  const video = String(input.videoDevice || '').trim();
  if (!video) throw Object.assign(new Error('Choose a video capture device'), { code: 'NO_DEVICE' });
  const args = ['--video', video];
  const audio = String(input.audioDevice || '').trim();
  if (audio) args.push('--audio', audio);
  if (input.videoSize) args.push('--size', String(input.videoSize));
  if (input.framerate) args.push('--fps', String(input.framerate));
  if (input.deviceFormat) args.push('--format', String(input.deviceFormat).toUpperCase());
  args.push('--audio-buffer', String(Math.max(1, Math.min(500, Number(input.audioBufferMs) || 10))));
  // The helper serves the stream on a Windows named pipe and FFmpeg opens it by name. (Passing a
  // Node-created pipe to FFmpeg's stdin fails on Windows with "Error opening input files: I/O error".)
  const pipe = `\\\\.\\pipe\\isu-capture-${process.pid}-${Date.now().toString(36)}`;
  args.push('--pipe', pipe, '--parent-pid', String(process.pid));
  const ffInput = ['-f', 'matroska', '-thread_queue_size', '1024', '-probesize', '32M', '-analyzeduration', '0', '-fflags', 'nobuffer', '-i', pipe];
  return audio
    ? { args: ffInput, video: '0:v:0', audio: '0:a:0', helper: { command: exe, args, pipe } }
    : { args: [...ffInput, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'], video: '0:v:0', audio: '1:a:0', helper: { command: exe, args, pipe } };
}

// Device list from the helper (DirectShow names exactly as libdshowcapture sees them).
function listObsDevices(exe = findCaptureExe()) {
  return new Promise((resolve) => {
    if (!exe) return resolve({ backend: 'obs', video: [], audio: [], error: 'isu-capture.exe not found' });
    execFile(exe, ['--list'], { timeout: 15000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      try {
        const data = JSON.parse(String(stdout));
        resolve({ backend: 'obs', error: '', video: data.video.map((d) => ({ id: d.name, name: d.name, modes: d.modes })), audio: data.audio.map((d) => ({ id: d.name, name: d.name })) });
      } catch { resolve({ backend: 'obs', video: [], audio: [], error: error ? error.message : 'isu-capture --list returned bad output' }); }
    });
  });
}

module.exports = { obsCaptureInput, listObsDevices, findCaptureExe, captureExeCandidates };
