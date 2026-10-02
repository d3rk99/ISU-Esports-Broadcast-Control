const $ = id => document.getElementById(id);
let config;
let dirty = false;
let currentStatus;
const fieldIds = ['encoderName', 'mode', 'resolution', 'fps', 'videoBitrate', 'audioBitrate', 'delaySeconds', 'video', 'audio'];
const mb = (bytes) => `${((bytes || 0) / 1e6).toFixed(0)} MB`;
const time = value => { const seconds = Math.floor(value || 0); const h = Math.floor(seconds / 3600); const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0'); const ss = String(seconds % 60).padStart(2, '0'); return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`; };
function element(tag, props = {}) { return Object.assign(document.createElement(tag), props); }
function field(label, input) { const wrapper = element('label', { textContent: label }); wrapper.append(input); return wrapper; }
function renderConfig(view) {
  config = view.config;
  for (const kind of ['video', 'audio']) {
    $(kind).replaceChildren(...[...new Set([...view.devices[kind], config.input[kind]])].map(value => element('option', { value, textContent: value })));
    $(kind).value = config.input[kind];
  }
  const values = { ...config.encoder, encoderName: config.encoder.name, delaySeconds: config.delaySeconds };
  for (const id of fieldIds.filter(id => !['video', 'audio'].includes(id))) $(id).value = values[id];
  $('engine').value = config.engine; $('inputType').value = config.input.type || 'test';
  $('audioOffsetMs').value = config.input.audioOffsetMs || 0; $('audioBufferMs').value = config.input.audioBufferMs || 10;
  $('inputFile').value = config.input.file || ''; $('inputDevice').value = config.input.device || ''; $('inputFormat').value = config.input.formatCode || '';
  $('storageDir').value = config.storageDir || ''; $('ffmpegPath').value = config.ffmpegPath || '';
  const api = config.api || { enabled: false, port: 3180, lan: false };
  $('apiEnabled').checked = api.enabled; $('apiPort').value = api.port; $('apiLan').checked = api.lan; $('apiRegenerate').checked = false; $('apiKey').hidden = true;
  renderApi(view.api);
  $('troubleshooting').checked = Boolean(config.troubleshooting); $('recordDir').value = config.recording?.directory || ''; $('recordSegment').value = config.recording?.segmentMinutes || 30;
  captureDevices = view.devices?.capture || captureDevices; renderDevices();
  syncInputFields();
  $('destinations').replaceChildren(...config.destinations.map(destinationRow));
  dirty = false; renderStatus(view.status);
}
function destinationRow(d) {
  const row = element('article', { className: 'destination' }); row.dataset.id = d.id;
  const enabled = element('input', { type: 'checkbox', checked: d.enabled }); enabled.dataset.field = 'enabled'; row.append(field('On', enabled));
  for (const [key, label] of [['name', 'Name'], ['protocol', 'Protocol'], ['serverUrl', 'Server URL (key may go in here)'], ['streamKey', d.hasKey ? 'Key saved · blank keeps it' : 'Stream key (optional)']]) {
    let input;
    if (key === 'protocol') { input = element('select'); input.append(...['RTMP', 'RTMPS'].map(value => element('option', { value, textContent: value }))); input.value = d.protocol; }
    else input = element('input', { value: d[key] || '', type: key === 'streamKey' ? 'password' : 'text', required: key === 'name', maxLength: key === 'name' ? 100 : 2048, autocomplete: 'off' });
    input.dataset.field = key; row.append(field(label, input));
  }
  const actions = element('div', { className: 'actions' }); actions.append(element('span', { className: 'state', textContent: 'STOPPED' }));
  for (const [action, label] of [['start', 'Start'], ['stop', 'Stop'], ['fail', 'Simulate failure']]) { const b = element('button', { type: 'button', textContent: label }); b.dataset.action = action; b.onclick = () => command(action, { id: d.id }); actions.append(b); }
  const clear = element('input', { type: 'checkbox' }); clear.dataset.field = 'clearKey'; actions.append(field('Clear saved key', clear));
  const remove = element('button', { type: 'button', textContent: 'Remove' }); remove.onclick = () => { row.remove(); markDirty(); }; actions.append(remove); row.append(actions); return row;
}
let captureDevices = null;
let deviceModes = [];
const option = (value, text) => element('option', { value, textContent: text });
// Device lists from the server. Keeps the saved choice even if it's unplugged right now, so
// opening the app with a camera unplugged never silently changes the config.
function renderDevices() {
  const saved = config?.input || {};
  const obsEngine = $('inputType')?.value === 'obs-device';
  const cap = (obsEngine ? captureDevices?.obs : captureDevices) || { video: [], audio: [] };
  const vids = cap.video.map((d) => option(d.id, d.name));
  if (saved.videoDevice && !cap.video.some((d) => d.id === saved.videoDevice)) vids.unshift(option(saved.videoDevice, `${saved.videoDevice} (not found)`));
  $('videoDevice').replaceChildren(option('', vids.length ? 'Choose a device…' : 'No devices found · Refresh'), ...vids);
  $('videoDevice').value = saved.videoDevice || '';
  const auds = cap.audio.map((d) => option(d.id, d.name));
  if (saved.audioDevice && !cap.audio.some((d) => d.id === saved.audioDevice)) auds.unshift(option(saved.audioDevice, `${saved.audioDevice} (not found)`));
  $('audioDevice').replaceChildren(option('', 'None (silent audio)'), ...auds);
  $('audioDevice').value = saved.audioDevice || '';
  renderModes();
  $('deviceNote').textContent = cap.error ? `Device scan: ${cap.error}` : `${cap.video.length} video / ${cap.audio.length} audio device(s) found${cap.backend ? ` via ${cap.backend}` : ''}. Webcams, capture cards, OBS Virtual Camera and DeckLink all appear here.`;
}
function modeValue(m) { return [m.size, m.fps, m.format].join('|'); }
function renderModes() {
  const saved = config?.input || {};
  const current = [saved.videoSize || '', saved.framerate || '', saved.deviceFormat || ''].join('|');
  const opts = deviceModes.map((m) => option(modeValue(m), m.label));
  if (current !== '||' && !deviceModes.some((m) => modeValue(m) === current)) opts.unshift(option(current, current.split('|').filter(Boolean).join(' · ')));
  $('deviceMode').replaceChildren(option('', 'Device default'), ...opts);
  $('deviceMode').value = current === '||' ? '' : current;
}
async function scanDevices() {
  $('deviceNote').textContent = 'Scanning devices…';
  const result = await window.stream.command('scanDevices');
  if (!result.ok) { $('deviceNote').textContent = result.error; return; }
  captureDevices = result.view.devices.capture; renderDevices();
}
// DirectShow caps -> the same mode shape the FFmpeg path uses (size, fps, format). Interval is in
// 100 ns units; minInterval = the fastest fps the mode allows.
function obsModes(caps) {
  const seen = new Set(); const out = [];
  for (const c of caps) {
    if (!c.maxWidth || !c.minInterval || c.format === 'Any') continue;
    const raw = 1e7 / c.minInterval;
    const fps = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 119.88, 120].find((f) => Math.abs(f - raw) < 0.02) ?? Math.round(raw * 100) / 100;
    const m = { size: `${c.maxWidth}x${c.maxHeight}`, fps, format: c.format, label: `${c.maxWidth}x${c.maxHeight} @ ${fps} fps · ${c.format}` };
    if (!seen.has(m.label)) { seen.add(m.label); out.push(m); }
  }
  return out.sort((a, b) => b.size.split('x').reduce((x, y) => x * y) - a.size.split('x').reduce((x, y) => x * y) || b.fps - a.fps);
}
async function loadModes() {
  const device = $('videoDevice').value;
  if (!device) { $('deviceNote').textContent = 'Pick a video device first.'; return; }
  if ($('inputType').value === 'obs-device') {
    // OBS engine: modes come with isu-capture's device list (DirectShow caps), no extra probe.
    const dev = (captureDevices?.obs?.video || []).find((d) => d.id === device);
    deviceModes = obsModes(dev?.modes || []);
    renderModes();
    $('deviceNote').textContent = deviceModes.length ? `${deviceModes.length} mode(s) from the OBS engine. Pick one, or Device default.` : 'No modes listed. Device default still works.';
    return;
  }
  $('deviceNote').textContent = 'Asking the device for its modes…';
  const result = await window.stream.command('deviceModes', { device });
  if (!result.ok) { $('deviceNote').textContent = result.error; return; }
  deviceModes = result.view.modes || [];
  const keep = $('deviceMode').value; renderModes(); if ([...$('deviceMode').options].some((o) => o.value === keep)) $('deviceMode').value = keep;
  $('deviceNote').textContent = deviceModes.length ? `${deviceModes.length} mode(s). Pick one, or Device default.` : 'The device did not list its modes (it may be busy in another app). Device default still works.';
}
function syncInputFields() {
  for (const el of document.querySelectorAll('[data-input]')) el.hidden = !el.dataset.input.split(' ').includes($('inputType').value);
  renderDevices();
  $('simLab').hidden = $('engine').value !== 'simulation';
}
function collect() {
  return { version: 2, troubleshooting: $('troubleshooting').checked, engine: $('engine').value, ffmpegPath: $('ffmpegPath').value.trim(), storageDir: $('storageDir').value.trim(), recording: { directory: $('recordDir').value.trim(), segmentMinutes: Number($('recordSegment').value) || 30 }, api: { enabled: $('apiEnabled').checked, port: Number($('apiPort').value) || 3180, lan: $('apiLan').checked, regenerateKey: $('apiRegenerate').checked }, input: { type: $('inputType').value, video: $('video').value, audio: $('audio').value, file: $('inputFile').value.trim(), device: $('inputDevice').value.trim(), formatCode: $('inputFormat').value.trim(), videoDevice: $('videoDevice').value, audioOffsetMs: Number($('audioOffsetMs').value) || 0, audioBufferMs: Number($('audioBufferMs').value) || 10, audioDevice: $('audioDevice').value, videoSize: $('deviceMode').value.split('|')[0] || '', framerate: $('deviceMode').value.split('|')[1] || '', deviceFormat: $('deviceMode').value.split('|')[2] || '' }, encoder: { name: $('encoderName').value, mode: $('mode').value, resolution: $('resolution').value, fps: Number($('fps').value), videoBitrate: Number($('videoBitrate').value), audioBitrate: Number($('audioBitrate').value), codec: 'H.264', audioCodec: 'AAC' }, delaySeconds: Number($('delaySeconds').value), destinations: [...$('destinations').children].map(row => {
    const d = { id: row.dataset.id }; for (const input of row.querySelectorAll('[data-field]')) d[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value; return d;
  }) };
}
function renderStatus(s) {
  currentStatus = s;
  renderHealth(s);
  const sim = s.simulation;
  $('engineBadge').textContent = sim ? 'SIMULATION • NO MEDIA SENT' : s.engine === 'ERROR' ? 'REAL ENGINE • ERROR' : s.engine === 'RUNNING' ? 'REAL ENGINE • LIVE MEDIA' : `REAL ENGINE • ${s.engine}`;
  $('engineBadge').className = `badge ${sim ? '' : s.engine === 'ERROR' ? 'bad' : 'real'}`;
  $('engineError').hidden = !s.error; $('engineError').textContent = s.error || '';
  if (sim) $('inputStatus').textContent = s.input.connected ? `● SIGNAL · ${s.input.resolution}p${s.input.fps} (simulated)` : '● NO SIGNAL';
  else $('inputStatus').textContent = s.input.connected ? `● SIGNAL · ${s.input.type} · ${s.input.resolution} @ ${Number(s.input.fps || 0).toFixed(2)} fps measured` : `● NO SIGNAL · ${s.engine}`;
  $('ffmpegStatus').textContent = sim ? '' : s.ffmpeg ? `FFmpeg ${s.ffmpeg.version} · NVENC ${s.ffmpeg.nvenc ? 'yes' : 'no'} · x264 ${s.ffmpeg.x264 ? 'yes' : 'no'} · DeckLink ${s.ffmpeg.decklink ? 'yes' : 'no (needs a DeckLink-enabled FFmpeg)'} · RTMPS ${s.ffmpeg.rtmps ? 'yes' : 'no'}` : 'FFmpeg not available';
  $('encoderStatus').textContent = sim ? `${s.encoder} · simulated encoder` : `${s.encoder}${s.codec ? ` · ${s.codec}` : ''} · ${s.telemetry.currentBitrateKbps} kbps measured · ${Number(s.telemetry.fps || 0).toFixed(1)} fps · speed ${Number(s.telemetry.speed || 0).toFixed(2)}×`;
  const percent = s.buffer.configuredSeconds ? 100 * s.buffer.filledSeconds / s.buffer.configuredSeconds : s.buffer.ready ? 100 : 0;
  $('delayTime').textContent = `${time(s.buffer.filledSeconds)} / ${time(s.buffer.configuredSeconds)}`;
  $('bufferProgress').value = percent;
  $('bufferStatus').textContent = `${s.buffer.ready ? 'READY' : 'BUFFERING'} · ${Math.floor(percent)}%${sim ? '' : ` · ${mb(s.buffer.bytes)} on disk · audio ${s.buffer.hasAudio ? '✓' : '✗'} video ${s.buffer.hasVideo ? '✓' : '✗'}`}`;
  $('interlock').textContent = s.outputsLocked ? 'OUTPUTS LOCKED' : sim ? 'STREAMING AVAILABLE (SIMULATED)' : 'READY TO GO LIVE (DELAYED)';
  $('interlock').className = s.outputsLocked ? 'locked' : 'unlocked';
  $('startAll').disabled = s.outputsLocked || dirty;
  $('telemetry').textContent = sim
    ? `Uptime ${time(s.uptime)} · ${s.telemetry.currentBitrateKbps} kbps (fake) · Effective delay ${time(s.buffer.effectiveDelaySeconds)}`
    : `Uptime ${time(s.uptime)} · Frames ${s.telemetry.encodedFrames} · Dropped ${s.telemetry.droppedFrames} · Effective delay ${time(s.buffer.effectiveDelaySeconds)}${s.buffer.lastReleaseAgeMs !== null && s.buffer.lastReleaseAgeMs !== undefined ? ` · last chunk sent ${(s.buffer.lastReleaseAgeMs / 1000).toFixed(1)} s old` : ''}${s.telemetry.avSyncWarning ? ' · ⚠ NO AUDIO' : ''}`;
  const rec = s.recording;
  const recording = rec && ['RECORDING', 'WAITING_KEYFRAME'].includes(rec.state);
  $('recordToggle').hidden = sim;
  $('recordToggle').disabled = sim || s.encoder !== 'ENCODING';
  $('recordToggle').textContent = recording ? '■ STOP RECORDING' : '● RECORD';
  $('recordToggle').classList.toggle('on', Boolean(recording));
  $('recordStatus').hidden = sim || !rec || rec.state === 'STOPPED' && !rec.files?.length;
  if (rec && !sim) $('recordStatus').textContent = rec.state === 'ERROR' ? `● RECORDING STOPPED: ${rec.error}` : recording ? `● REC ${time(rec.seconds)} · ${mb(rec.bytes)} · LIVE (no delay) → ${rec.directory}` : `Last recording: ${rec.files?.slice(-1)[0] || ''} in ${rec.directory}`;
  if (rec) $('recordStatus').className = `record-status ${rec.state === 'ERROR' ? 'bad' : recording ? 'live' : ''}`;
  for (const row of $('destinations').children) {
    const output = s.outputs.find(o => o.id === row.dataset.id);
    const extra = output && !sim ? ` · ${mb(output.sentBytes)} sent${output.droppedChunks ? ` · ${output.droppedChunks} skipped` : ''}` : '';
    row.querySelector('.state').textContent = output ? `${output.state} · reconnects ${output.reconnectCount}${extra}${output.error ? ` · ${output.error}` : ''}` : 'UNSAVED';
    row.querySelector('.state').dataset.state = output?.state || '';
    row.querySelector('.state').dataset.health = output?.health || '';
    if (output?.health && !sim && output.state !== 'DISABLED') row.querySelector('.state').textContent = `${output.health} · ${row.querySelector('.state').textContent}`;
    row.querySelector('[data-action=start]').disabled = dirty || s.outputsLocked || !output || output.state === 'DISABLED';
    row.querySelector('[data-action=stop]').disabled = !output;
    row.querySelector('[data-action=fail]').hidden = !sim;
    row.querySelector('[data-action=fail]').disabled = output?.state !== 'CONNECTED';
  }
}
const PROBLEM_TEXT = { ENCODER: 'encoder stopped', LOW_FPS: 'low frame rate', DROPPED_FRAMES: 'dropping frames', NO_AUDIO: 'no audio', SILENT: 'audio silent', BUFFERING: 'delay still filling' };
function renderHealth(s) {
  const h = s.programHealth || { healthy: false, problems: [] };
  const badge = $('healthBadge');
  const severe = h.severe || h.problems.filter((p) => p !== 'BUFFERING');
  const onlyBuffering = !severe.length && h.problems.includes('BUFFERING');
  badge.textContent = h.healthy ? 'PROGRAM HEALTHY' : severe.length ? `PROGRAM PROBLEM: ${severe.map((p) => PROBLEM_TEXT[p] || p).join(', ').toUpperCase()}` : onlyBuffering ? 'BUFFERING' : 'CHECK AUDIO (SILENT)';
  badge.className = `health ${h.healthy ? 'ok' : severe.length ? 'bad' : 'warn'}`;
  $('healthText').textContent = h.problems.length ? `Problems: ${h.problems.map((p) => PROBLEM_TEXT[p] || p).join(', ')}` : 'Encoder, audio and delay all healthy.';
  if (!s.preview?.running || !s.preview?.videoLive) { $('previewImg').closest('.preview-box').classList.remove('live'); }
  if (!s.preview?.audioLive) setMeters({ peak: [-90, -90], rms: [-90, -90] });
}
function renderApi(api) {
  if (!api) return;
  $('apiStatus').textContent = api.listening ? `Listening on ${api.address}` : api.error ? `Not running: ${api.error}` : 'Off';
}
// dBFS -> bar height: -60 dB at the bottom, 0 dB at the top.
const level = (dbfs) => Math.max(0, Math.min(1, (dbfs + 60) / 60));
function setMeters(m) {
  for (const [i, ch] of [[0, 'L'], [1, 'R']]) {
    const box = $(`meter${ch}`).parentElement;
    $(`meter${ch}`).style.setProperty('--h', `${box.clientHeight}px`);
    $(`meter${ch}`).style.height = `${level(m.rms[i]) * 100}%`;
    $(`peak${ch}`).style.bottom = `${level(m.peak[i]) * 100}%`;
  }
  const f = (d) => d <= -89 ? '—' : d.toFixed(0);
  $('meterText').textContent = `L ${f(m.peak[0])} · R ${f(m.peak[1])} dBFS peak`;
}
// Latest-frame-wins: decode off the main thread, draw on the next animation frame, and drop
// any frame that arrives while one is still decoding, so the preview never lags or piles up.
let pendingFrame = null;
let decoding = false;
async function drawPreview() {
  if (decoding || !pendingFrame) return;
  decoding = true;
  const bytes = pendingFrame; pendingFrame = null;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const canvas = $('previewImg');
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) { canvas.width = bitmap.width; canvas.height = bitmap.height; }
    requestAnimationFrame(() => { canvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close(); canvas.closest('.preview-box').classList.add('live'); });
  } catch { /* a bad frame is skipped, never shown */ }
  decoding = false;
  if (pendingFrame) drawPreview();
}
window.stream.onPreview((bytes) => {
  if (!$('previewOn').checked) return;
  pendingFrame = bytes;
  drawPreview();
});
window.stream.onMeter(setMeters);
$('previewOn').onchange = () => { command('preview', { enabled: $('previewOn').checked }); if (!$('previewOn').checked) $('previewImg').closest('.preview-box').classList.remove('live'); };
$('apiShowKey').onclick = async () => { const key = await window.stream.apiKey(); $('apiKey').hidden = false; $('apiKey').textContent = key || 'No key yet: tick Enable and save settings first.'; if (key) navigator.clipboard?.writeText(key).catch(() => {}); };
function markDirty() { dirty = true; $('notice').textContent = 'Unsaved settings. Save to apply; this stops outputs and resets the delay.'; if (currentStatus) renderStatus(currentStatus); }
async function command(action, payload) {
  try {
    const result = await window.stream.command(action, payload);
    if (!result.ok) throw new Error(result.error);
    if (result.view.api) renderApi(result.view.api);
    if (action === 'save') { renderConfig(result.view); $('notice').textContent = 'Settings saved. Keys encrypted using Windows user credentials.'; }
    else { renderStatus(result.view.status); if (!dirty) $('notice').textContent = ''; }
  } catch (error) { $('notice').textContent = error.message; }
}
$('settings').addEventListener('input', markDirty);
$('settings').addEventListener('change', (event) => { if (event.target.id === 'inputType' || event.target.id === 'engine') syncInputFields(); });
$('settings').addEventListener('submit', event => { event.preventDefault(); command('save', collect()); });
$('scanDevices').onclick = scanDevices;
$('loadModes').onclick = loadModes;
$('videoDevice').addEventListener('change', () => { deviceModes = []; $('deviceMode').replaceChildren(option('', 'Device default')); });
$('add').onclick = () => { $('destinations').append(destinationRow({ id: crypto.randomUUID(), name: 'Custom RTMP', protocol: 'RTMPS', enabled: true })); markDirty(); };
for (const action of ['startAll', 'stopAll', 'signal', 'reset']) $(action).onclick = () => command(action);
$('recordToggle').onclick = () => command(currentStatus?.recording && ['RECORDING', 'WAITING_KEYFRAME'].includes(currentStatus.recording.state) ? 'stopRecording' : 'startRecording');
$('speed').onchange = () => command('speed', { value: Number($('speed').value) });
window.stream.onStatus(renderStatus);
window.stream.view().then(renderConfig).catch(() => { $('notice').textContent = 'Unable to load Stream Server state.'; });

window.stream.build?.().then((b) => { $('buildInfo').textContent = b.label; }).catch(() => { $('buildInfo').textContent = 'Version unknown'; });
