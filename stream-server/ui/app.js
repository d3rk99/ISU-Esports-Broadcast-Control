const $ = id => document.getElementById(id);
let config;
let dirty = false;
let currentStatus;
const fieldIds = ['encoderName', 'mode', 'resolution', 'fps', 'videoBitrate', 'audioBitrate', 'delaySeconds', 'video', 'audio'];
const time = value => { const seconds = Math.floor(value || 0); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; };
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
function collect() {
  return { version: 1, input: { video: $('video').value, audio: $('audio').value }, encoder: { name: $('encoderName').value, mode: $('mode').value, resolution: $('resolution').value, fps: Number($('fps').value), videoBitrate: Number($('videoBitrate').value), audioBitrate: Number($('audioBitrate').value), codec: 'H.264', audioCodec: 'AAC' }, delaySeconds: Number($('delaySeconds').value), destinations: [...$('destinations').children].map(row => {
    const d = { id: row.dataset.id }; for (const input of row.querySelectorAll('[data-field]')) d[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value; return d;
  }) };
}
function renderStatus(s) {
  currentStatus = s;
  $('inputStatus').textContent = s.input.connected ? `● SIGNAL · ${s.input.resolution}p${s.input.fps} (simulated)` : '● NO SIGNAL';
  $('encoderStatus').textContent = `${s.encoder} · simulated encoder`;
  const percent = s.buffer.configuredSeconds ? 100 * s.buffer.filledSeconds / s.buffer.configuredSeconds : s.buffer.ready ? 100 : 0;
  $('delayTime').textContent = `${time(s.buffer.filledSeconds)} / ${time(s.buffer.configuredSeconds)}`;
  $('bufferProgress').value = percent;
  $('bufferStatus').textContent = `${s.buffer.ready ? 'READY' : 'BUFFERING'} · ${Math.floor(percent)}%`;
  $('interlock').textContent = s.outputsLocked ? 'OUTPUTS LOCKED' : 'STREAMING AVAILABLE (SIMULATED)';
  $('startAll').disabled = s.outputsLocked || dirty;
  $('telemetry').textContent = `Uptime ${time(s.uptime)} · ${s.telemetry.currentBitrateKbps} kbps (fake) · Frames ${s.telemetry.encodedFrames} · Dropped ${s.telemetry.droppedFrames} · A/V sync ${s.telemetry.avSyncWarning ? 'WARNING' : 'OK (fake)'} · Effective delay ${time(s.buffer.effectiveDelaySeconds)}`;
  for (const row of $('destinations').children) {
    const output = s.outputs.find(o => o.id === row.dataset.id);
    row.querySelector('.state').textContent = output ? `${output.state} · reconnects ${output.reconnectCount}` : 'UNSAVED';
    row.querySelector('[data-action=start]').disabled = dirty || s.outputsLocked || !output || output.state === 'DISABLED';
    row.querySelector('[data-action=stop]').disabled = !output;
    row.querySelector('[data-action=fail]').disabled = output?.state !== 'CONNECTED';
  }
}
function markDirty() { dirty = true; $('notice').textContent = 'Unsaved settings. Save to apply; this stops outputs and resets the delay.'; if (currentStatus) renderStatus(currentStatus); }
async function command(action, payload) {
  try {
    const result = await window.stream.command(action, payload);
    if (!result.ok) throw new Error(result.error);
    if (action === 'save') { renderConfig(result.view); $('notice').textContent = 'Settings saved. Keys encrypted using Windows user credentials.'; }
    else { renderStatus(result.view.status); if (!dirty) $('notice').textContent = 'Simulation only. No media is being sent.'; }
  } catch (error) { $('notice').textContent = error.message; }
}
$('settings').addEventListener('input', markDirty);
$('settings').addEventListener('submit', event => { event.preventDefault(); command('save', collect()); });
$('add').onclick = () => { $('destinations').append(destinationRow({ id: crypto.randomUUID(), name: 'Custom RTMP', protocol: 'RTMPS', enabled: true })); markDirty(); };
for (const action of ['startAll', 'stopAll', 'signal', 'reset']) $(action).onclick = () => command(action);
$('speed').onchange = () => command('speed', { value: Number($('speed').value) });
window.stream.onStatus(renderStatus);
window.stream.view().then(renderConfig).catch(() => { $('notice').textContent = 'Unable to load Stream Server state.'; });
