'use strict';
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Locate FFmpeg: explicit setting, then ISU_FFMPEG, then a copy next to the app, then PATH.
function ffmpegCandidates(configured = '') {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const list = [];
  if (configured) list.push(configured);
  if (process.env.ISU_FFMPEG) list.push(process.env.ISU_FFMPEG);
  const resources = process.resourcesPath || '';
  if (resources) list.push(path.join(resources, 'ffmpeg', exe));
  list.push(path.join(__dirname, '..', '..', 'vendor', 'ffmpeg', exe));
  list.push(exe); // PATH
  return list;
}

function run(file, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error && !stdout) return reject(error);
      resolve(`${stdout}\n${stderr}`);
    });
  });
}

// Probe one FFmpeg binary for everything the real engine needs. Never assumes support.
async function probeFfmpeg(file) {
  const version = await run(file, ['-hide_banner', '-version']);
  const encoders = await run(file, ['-hide_banner', '-encoders']);
  const protocols = await run(file, ['-hide_banner', '-protocols']);
  const formats = await run(file, ['-hide_banner', '-formats']);
  const has = (text, name) => new RegExp(`\\s${name}\\s`).test(text);
  const caps = {
    path: file,
    version: (version.match(/ffmpeg version (\S+)/) || [])[1] || 'unknown',
    libx264: has(encoders, 'libx264'),
    h264Nvenc: has(encoders, 'h264_nvenc'),
    aac: has(encoders, 'aac'),
    rtmp: /\brtmp\b/.test(protocols),
    rtmps: /\brtmps\b/.test(protocols),
    decklink: /\bdecklink\b/.test(formats),
    dshow: /\bdshow\b/.test(formats),
    lavfi: /\blavfi\b/.test(formats),
    nvencUsable: false
  };
  if (caps.h264Nvenc) caps.nvencUsable = await nvencWorks(file);
  return caps;
}

// NVENC can be compiled in yet unusable (no GPU / old driver). Encode a few frames to be sure.
async function nvencWorks(file) {
  try {
    await run(file, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x144:r=30', '-frames:v', '5', '-c:v', 'h264_nvenc', '-f', 'null', '-'], 20000);
    return true;
  } catch { return false; }
}

async function findFfmpeg(configured = '') {
  const tried = [];
  for (const candidate of ffmpegCandidates(configured)) {
    if (candidate.includes(path.sep) && !fs.existsSync(candidate)) { tried.push(`${candidate} (missing)`); continue; }
    try {
      const caps = await probeFfmpeg(candidate);
      if (!caps.aac || !(caps.libx264 || caps.h264Nvenc)) { tried.push(`${candidate} (no H.264/AAC encoder)`); continue; }
      return caps;
    } catch (error) { tried.push(`${candidate} (${error.code || 'failed to run'})`); }
  }
  const error = new Error(`FFmpeg not found or unusable. Install an FFmpeg build with libx264/h264_nvenc, aac and rtmp(s), then set its path in Settings or ISU_FFMPEG. Tried: ${tried.join('; ')}`);
  error.code = 'FFMPEG_MISSING';
  throw error;
}

module.exports = { findFfmpeg, probeFfmpeg, run };
