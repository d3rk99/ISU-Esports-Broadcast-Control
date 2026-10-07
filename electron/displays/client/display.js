// Full-screen display page. Game mirror = live capture of the player monitor.
// NDI = frames from the main process (RGBX), newest frame wins, drawn once per animation frame.
const mirror = document.getElementById('mirror');
const canvas = document.getElementById('ndi');
const ctx = canvas.getContext('2d', { alpha: false });
const $ = (id) => document.getElementById(id);
let config = null; let mode = { mode: 'ndi', source: '' }; let link = { state: 'connecting' }; let ndi = { state: 'idle' };
let stream = null; let pending = null; let lastFrameAt = 0;

function stopMirror() { for (const t of stream?.getTracks() || []) t.stop(); stream = null; mirror.srcObject = null; }
async function startMirror() {
  try {
    const source = await window.display.getMirrorSource();
    if (!source) throw new Error('Player monitor not found');
    const next = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id, maxFrameRate: 60 } } });
    if (mode.mode !== 'mirror') { for (const t of next.getTracks()) t.stop(); return; }
    stopMirror(); stream = next; mirror.srcObject = next; await mirror.play();
    document.body.classList.add('live');
    window.display.mirrorStatus({ fps: next.getVideoTracks()[0]?.getSettings?.().frameRate || 0 });
  } catch (error) {
    document.body.classList.remove('live');
    window.display.mirrorStatus({ error: error.message || String(error) });
    paint();
  }
}

function draw() {
  const frame = pending; pending = null;
  if (!frame || mode.mode !== 'ndi') return;
  const { width, height, stride } = frame;
  const src = new Uint8Array(frame.data.buffer || frame.data, frame.data.byteOffset || 0, frame.data.byteLength ?? frame.data.length);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const image = ctx.createImageData(width, height);
  const out = image.data;
  for (let y = 0; y < height; y += 1) out.set(src.subarray(y * stride, y * stride + width * 4), y * width * 4);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  ctx.putImageData(image, 0, 0);
  lastFrameAt = Date.now();
  if (!document.body.classList.contains('live')) { document.body.classList.add('live'); paint(); }
}

function paint() {
  const station = String(config?.station || 1).padStart(2, '0');
  document.body.classList.toggle('mode-mirror', mode.mode === 'mirror');
  document.body.classList.toggle('mode-ndi', mode.mode === 'ndi');
  $('wait-title').textContent = `STATION ${station}`;
  const problems = [];
  if (link.state !== 'connected') problems.push(link.error || 'Controller not connected');
  if (mode.mode === 'ndi' && ndi.state !== 'receiving') problems.push(ndi.error || `Looking for ${ndi.source || mode.source || 'NDI feed'}…`);
  $('wait-detail').textContent = problems[0] || (mode.mode === 'mirror' ? 'Game mirror' : `NDI · ${ndi.source || mode.source}`);
  const badge = $('badge');
  badge.textContent = problems.join(' · ');
  badge.classList.toggle('show', document.body.classList.contains('live') && problems.length > 0);
}

window.display.onMode((next) => {
  const changed = next.mode !== mode.mode;
  mode = next;
  if (changed) document.body.classList.remove('live');
  if (mode.mode === 'mirror') startMirror(); else stopMirror();
  paint();
});
window.display.onLink((next) => { link = next; paint(); });
window.display.onNdiStatus((next) => { ndi = next; if (next.state !== 'receiving' && Date.now() - lastFrameAt > 3000 && mode.mode === 'ndi') document.body.classList.remove('live'); paint(); });
window.display.onFrame((frame) => { const first = !pending; pending = frame; if (first) requestAnimationFrame(draw); });
window.display.getConfig().then((c) => { config = c; paint(); });

// Pink noise (headset masking): controller says on/off + volume, settings pick the headset.
window.pinkNoise.onStatus((status) => window.display.noiseStatus(status));
window.display.onNoiseDevice((device) => window.pinkNoise.setDevice(device));
window.display.onNoise((next) => window.pinkNoise.set(next));
