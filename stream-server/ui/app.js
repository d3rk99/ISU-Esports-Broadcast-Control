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
  $('inputFile').value = config.input.file || ''; $('inputDevice').value = config.input.device || ''; $('inputFormat').value = config.input.formatCode || '';
  $('storageDir').value = config.storageDir || ''; $('ffmpegPath').value = config.ffmpegPath || '';
  $('recordDir').value = config.recording?.directory || ''; $('recordSegment').value = config.recording?.segmentMinutes || 30;
  syncInputFields();
  $('destinations').replaceChildren(...config.destinations.map(destinationRow));
  dirty = false; renderStatus(view.status);
}
function destinationRow(d) {
  const row = element('article', { className: 'destination' }); row.dataset.id = d.id;
  const enabled = element('input', { type: 'checkbox', checked: d.enabled }); enabled.dataset.field = 'enabled'; row.append(field('On', enabled));
  for (const [key, label] of [['name', 'Name'], ['protocol', 'Protocol'], ['serverUrl', 'Server URL'], ['streamKey', d.hasKey ? 'Key saved · blank keeps it' : 'Stream key']]) {
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
function syncInputFields() {
  for (const el of document.querySelectorAll('[data-input]')) el.hidden = el.dataset.input !== $('inputType').value;
  $('simLab').hidden = $('engine').value !== 'simulation';
}
function collect() {
  return { version: 2, engine: $('engine').value, ffmpegPath: $('ffmpegPath').value.trim(), storageDir: $('storageDir').value.trim(), recording: { directory: $('recordDir').value.trim(), segmentMinutes: Number($('recordSegment').value) || 30 }, input: { type: $('inputType').value, video: $('video').value, audio: $('audio').value, file: $('inputFile').value.trim(), device: $('inputDevice').value.trim(), formatCode: $('inputFormat').value.trim() }, encoder: { name: $('encoderName').value, mode: $('mode').value, resolution: $('resolution').value, fps: Number($('fps').value), videoBitrate: Number($('videoBitrate').value), audioBitrate: Number($('audioBitrate').value), codec: 'H.264', audioCodec: 'AAC' }, delaySeconds: Number($('delaySeconds').value), destinations: [...$('destinations').children].map(row => {
    const d = { id: row.dataset.id }; for (const input of row.querySelectorAll('[data-field]')) d[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value; return d;
  }) };
}
function renderStatus(s) {
  currentStatus = s;
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
    row.querySelector('[data-action=start]').disabled = dirty || s.outputsLocked || !output || output.state === 'DISABLED';
    row.querySelector('[data-action=stop]').disabled = !output;
    row.querySelector('[data-action=fail]').hidden = !sim;
    row.querySelector('[data-action=fail]').disabled = output?.state !== 'CONNECTED';
  }
}
function markDirty() { dirty = true; $('notice').textContent = 'Unsaved settings. Save to apply; this stops outputs and resets the delay.'; if (currentStatus) renderStatus(currentStatus); }
async function command(action, payload) {
  try {
    const result = await window.stream.command(action, payload);
    if (!result.ok) throw new Error(result.error);
    if (action === 'save') { renderConfig(result.view); $('notice').textContent = 'Settings saved. Keys encrypted using Windows user credentials.'; }
    else { renderStatus(result.view.status); if (!dirty) $('notice').textContent = ''; }
  } catch (error) { $('notice').textContent = error.message; }
}
$('settings').addEventListener('input', markDirty);
$('settings').addEventListener('change', (event) => { if (event.target.id === 'inputType' || event.target.id === 'engine') syncInputFields(); });
$('settings').addEventListener('submit', event => { event.preventDefault(); command('save', collect()); });
$('add').onclick = () => { $('destinations').append(destinationRow({ id: crypto.randomUUID(), name: 'Custom RTMP', protocol: 'RTMPS', enabled: true })); markDirty(); };
for (const action of ['startAll', 'stopAll', 'signal', 'reset']) $(action).onclick = () => command(action);
$('recordToggle').onclick = () => command(currentStatus?.recording && ['RECORDING', 'WAITING_KEYFRAME'].includes(currentStatus.recording.state) ? 'stopRecording' : 'startRecording');
$('speed').onchange = () => command('speed', { value: Number($('speed').value) });
window.stream.onStatus(renderStatus);
window.stream.view().then(renderConfig).catch(() => { $('notice').textContent = 'Unable to load Stream Server state.'; });
