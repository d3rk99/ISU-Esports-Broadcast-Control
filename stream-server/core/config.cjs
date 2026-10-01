const fs = require('node:fs');
const path = require('node:path');
const { ICredentialStore } = require('./contracts.cjs');
const defaults = () => ({ version: 1, input: { video: 'Simulation SDI 1', audio: 'Simulation embedded audio' }, encoder: { name: 'NVENC H.264 (simulated)', mode: 'hardware', resolution: '1920x1080', fps: 59.94, videoBitrate: 12000, audioBitrate: 192, codec: 'H.264', audioCodec: 'AAC' }, delaySeconds: 300, destinations: ['Twitch', 'YouTube', 'League RTMP'].map((name, i) => ({ id: `output-${i + 1}`, name, enabled: true, protocol: 'RTMPS', serverUrl: '', credential: '' })) });
function validate(c) {
  if (c?.version !== 1 || !c.input || !c.encoder || !Array.isArray(c.destinations)) throw new Error('Invalid configuration schema');
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
      if (url.protocol !== `${d.protocol.toLowerCase()}:` || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error('Use a matching RTMP/RTMPS server URL without credentials or query parameters');
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
  load() {
    if (!fs.existsSync(this.file)) return defaults();
    // Fail closed: never overwrite a damaged/unknown config with defaults.
    return validate(JSON.parse(fs.readFileSync(this.file, 'utf8')));
  }
  save(config) {
    validate(config);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  publicConfig(c) { return { ...structuredClone(c), destinations: c.destinations.map(({ credential, ...d }) => ({ ...d, hasKey: Boolean(credential) })) }; }
  prepare(raw, previous) {
    const next = structuredClone(raw);
    next.destinations = next.destinations.map(({ streamKey, clearKey, hasKey, ...d }) => ({ ...d, credential: clearKey ? '' : streamKey ? this.credentials.seal(streamKey) : previous.destinations.find(p => p.id === d.id)?.credential || '' }));
    return validate(next);
  }
}
module.exports = { defaults, validate, ConfigStore, ElectronCredentialStore };
