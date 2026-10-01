'use strict';
// Local RTMP test receiver: an FFmpeg listening on 127.0.0.1 that records whatever is published
// to it. Used instead of any public platform. Records arrival time of first media.
const { spawn } = require('node:child_process');
const net = require('node:net');

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

async function startReceiver(file, { ffmpeg = 'ffmpeg' } = {}) {
  const port = await freePort();
  const url = `rtmp://127.0.0.1:${port}/live`;
  const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-listen', '1', '-timeout', '600', '-i', `${url}/test-key`, '-c', 'copy', '-f', 'mpegts', '-y', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const receiver = { port, url, file, child, firstMediaAt: null, get stderr() { return err; } };
  // Poll file growth to time the first received bytes.
  const fs = require('node:fs');
  receiver.watch = setInterval(() => { try { if (!receiver.firstMediaAt && fs.statSync(file).size > 0) receiver.firstMediaAt = performance.now(); } catch {} }, 20);
  await new Promise((r) => setTimeout(r, 400));
  receiver.stop = () => new Promise((resolve) => { clearInterval(receiver.watch); if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill('SIGINT'); setTimeout(() => child.kill('SIGKILL'), 3000); });
  return receiver;
}

module.exports = { startReceiver };
