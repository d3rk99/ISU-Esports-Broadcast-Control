const fs = require('node:fs');
const path = require('node:path');
const { ICredentialStore } = require('./contracts.cjs');
const defaults = () => ({ version: 2, engine: 'real', ffmpegPath: '', storageDir: '', input: { type: 'test', video: 'Test pattern (clock + tone)', audio: 'Test tone', file: '', device: '', formatCode: '' }, encoder: { name: 'H.264 / AAC', mode: 'hardware', resolution: '1920x1080', fps: 59.94, videoBitrate: 6000, audioBitrate: 160, codec: 'H.264', audioCodec: 'AAC' }, recording: { directory: '', segmentMinutes: 30 }, api: { enabled: false, port: 3180, lan: false, key: '' }, delaySeconds: 300, destinations: ['Twitch', 'YouTube', 'League RTMP'].map((name, i) => ({ id: `output-${i + 1}`, name, enabled: true, protocol: 'RTMPS', serverUrl: '', credential: '' })) });
// v1 (Codex scaffold) -> v2: adds engine selection, input type, FFmpeg path, delay storage.
function migrate(c) {
  if (c?.version === 1) {
    const d = defaults();
    return { ...c, version: 2, engine: 'simulation', ffmpegPath: '', storageDir: '', recording: d.recording, input: { ...d.input, ...c.input, type: 'test' } };
  }
  return c;
}
function validate(c) {
  if (c?.version !== 2 || !c.input || !c.encoder || !Array.isArray(c.destinations)) throw new Error('Invalid configuration schema');
  if (!['real', 'simulation'].includes(c.engine)) throw new Error('Engine must be real or simulation');
  if (!['test', 'file', 'decklink', 'device', 'obs-device'].includes(c.input.type)) throw new Error('Input type must be test, file, decklink, device or obs-device');
  if (typeof c.ffmpegPath !== 'string' || c.ffmpegPath.length > 1024 || typeof c.storageDir !== 'string' || c.storageDir.length > 1024) throw new Error('Invalid FFmpeg or storage path');
  if (c.troubleshooting !== undefined && typeof c.troubleshooting !== 'boolean') throw new Error('Invalid troubleshooting setting');
  if (c.recording !== undefined && (typeof c.recording !== 'object' || typeof c.recording.directory !== 'string' || c.recording.directory.length > 1024 || !(Number.isFinite(c.recording.segmentMinutes) && c.recording.segmentMinutes >= 1 && c.recording.segmentMinutes <= 720))) throw new Error('Invalid recording settings (segment 1-720 minutes)');
  if (c.api !== undefined) {
    const a = c.api;
    // 3174-3178 belong to the Broadcast Controller / bridges; never share a listener with them.
    if (typeof a !== 'object' || typeof a.enabled !== 'boolean' || typeof a.lan !== 'boolean' || typeof a.key !== 'string' || a.key.length > 16000 || !Number.isInteger(a.port) || a.port < 1024 || a.port > 65535 || [3174, 3175, 3176, 3177, 3178].includes(a.port)) throw new Error('Invalid Companion API settings (port 1024-65535, not 3174-3178)');
  }
  for (const k of ['file', 'device', 'formatCode', 'videoDevice', 'audioDevice', 'deviceFormat', 'videoSize', 'framerate']) if (c.input[k] !== undefined && (typeof c.input[k] !== 'string' || c.input[k].length > 1024)) throw new Error('Invalid input setting');
  if (c.input.videoSize && !/^\d{2,5}x\d{2,5}$/.test(c.input.videoSize)) throw new Error('Capture resolution must look like 1920x1080 (or blank for device default)');
  if (c.input.framerate && !/^\d{1,6}(\.\d{1,4})?(\/\d{1,5})?$/.test(c.input.framerate)) throw new Error('Capture frame rate must be a number like 59.94 or 60000/1001 (or blank)');
  if (c.input.deviceFormat && !/^[a-z0-9_]{1,32}$/i.test(c.input.deviceFormat)) throw new Error('Invalid capture pixel format');
  for (const [k, lo, hi] of [['audioOffsetMs', -2000, 2000], ['audioBufferMs', 5, 500]]) if (c.input[k] !== undefined && c.input[k] !== '' && !(Number.isFinite(Number(c.input[k])) && Number(c.input[k]) >= lo && Number(c.input[k]) <= hi)) throw new Error(`${k === 'audioOffsetMs' ? 'Audio sync offset' : 'Audio buffer'} must be ${lo} to ${hi} ms`);
  if (c.input.captureExe !== undefined && (typeof c.input.captureExe !== 'string' || c.input.captureExe.length > 1024)) throw new Error('Invalid isu-capture path');
  if (c.input.deviceFormat && c.input.type === 'obs-device' && !/^(NV12|YUY2|UYVY|I420|YV12|MJPEG|ARGB|XRGB|HDYC|YVYU)$/i.test(c.input.deviceFormat)) throw new Error('OBS engine format must be NV12, YUY2, UYVY, I420, YV12, MJPEG, ARGB or XRGB');
  if (['device', 'obs-device'].includes(c.input.type) && !c.input.videoDevice) throw new Error('Pick a video capture device before saving');
  const num = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  const str = (v, max = 512) => typeof v === 'string' && v.length <= max;
  if (!num(c.delaySeconds, 0, 86400) || !str(c.input.video) || !str(c.input.audio)) throw new Error('Invalid input or delay (0–86400 seconds)');
  const e = c.encoder;
  if (!str(e.name) || !['hardware', 'software'].includes(e.mode) || !/^\d{2,5}x\d{2,5}$/.test(e.resolution) || !num(e.fps, 1, 240) || !num(e.videoBitrate, 100, 200000) || !num(e.audioBitrate, 32, 1024) || e.codec !== 'H.264' || e.audioCodec !== 'AAC') throw new Error('Invalid encoder settings');
  const ids = new Set();
  for (const d of c.destinations) {
    if (!str(d.id, 100) || !d.id || ids.has(d.id) || !str(d.name, 100) || !d.name.trim() || typeof d.enabled !== 'boolean' || !['RTMP', 'RTMPS'].includes(d.protocol) || !str(d.serverUrl, 2048) || !str(d.credential, 16000)) throw new Error('Invalid destination');
    ids.add(d.id);
    if (d.serverUrl) {
      let url; try { url = new URL(d.serverUrl); } catch { throw new Error('Invalid server URL'); }
      // A full publish URL with the key inside (rtmps://host/app/live_xxx?bandwidthtest=true) is fine.
      if (url.protocol !== `${d.protocol.toLowerCase()}:` || !url.hostname || url.username || url.password || url.hash) throw new Error('Use an rtmp:// or rtmps:// URL (the key may be inside it); no user:password@ or #');
      if (/\s/.test(d.serverUrl)) throw new Error('The server URL has a space or line break in it');
    }
  }
  return c;
}
class ElectronCredentialStore extends ICredentialStore {
  constructor(safeStorage) { super(); this.storage = safeStorage; }
  seal(secret) {
    if (!secret) return '';
    if (!this.storage.isEncryptionAvailable()) throw new Error('Windows credential encryption unavailable; key was not saved');
    return this.storage.encryptString(secret).toString('base64');
  }
  open(blob) { return blob ? this.storage.decryptString(Buffer.from(blob, 'base64')) : ''; }
}
class ConfigStore {
  constructor(directory, credentials) { this.file = path.join(directory, 'config.json'); this.credentials = credentials; }
  apiKey(c) { return c.api?.key ? this.credentials.open(c.api.key) : ''; }
  load() {
    if (!fs.existsSync(this.file)) return defaults();
    // Fail closed: never overwrite a damaged/unknown config with defaults.
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const migrated = validate(migrate(raw));
    if (raw.version !== migrated.version) { fs.copyFileSync(this.file, `${this.file}.v${raw.version}.bak`); this.save(migrated); }
    return migrated;
  }
  save(config) {
    validate(config);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  publicConfig(c) { const api = c.api || defaults().api; return { ...structuredClone(c), api: { enabled: api.enabled, port: api.port, lan: api.lan, hasKey: Boolean(api.key) }, destinations: c.destinations.map(({ credential, ...d }) => ({ ...d, hasKey: Boolean(credential) })) }; }
  prepare(raw, previous) {
    const next = structuredClone(raw);
    // API key: kept from the previous config unless regenerated; a new one is made when first enabled.
    const prevApi = previous.api || defaults().api;
    if (next.api) {
      const { hasKey, regenerateKey, ...api } = next.api;
      let key = regenerateKey ? '' : prevApi.key || '';
      if (api.enabled && !key) key = this.credentials.seal(require('node:crypto').randomBytes(24).toString('hex'));
      next.api = { enabled: Boolean(api.enabled), port: Number(api.port) || 3180, lan: Boolean(api.lan), key };
    } else next.api = prevApi;
    // Pasted keys often carry a trailing space/newline; Twitch then refuses with only a generic I/O error.
    next.destinations = next.destinations.map(({ streamKey, clearKey, hasKey, ...d }) => ({ ...d, serverUrl: String(d.serverUrl || '').trim(), protocol: /^rtmps:/i.test(String(d.serverUrl || '').trim()) ? 'RTMPS' : /^rtmp:/i.test(String(d.serverUrl || '').trim()) ? 'RTMP' : d.protocol, credential: clearKey ? '' : String(streamKey || '').trim() ? this.credentials.seal(String(streamKey).trim()) : previous.destinations.find(p => p.id === d.id)?.credential || '' }));
    return validate(next);
  }
}
module.exports = { defaults, validate, migrate, ConfigStore, ElectronCredentialStore };
