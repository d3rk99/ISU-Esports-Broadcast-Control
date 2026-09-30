const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { WebSocketServer } = require('ws');

const STAGE_DISPLAY_MODES = Object.freeze({
  gameplay: 'gameplay',
  wall: 'wall',
  graphic: 'graphic',
  individual: 'individual',
  blackout: 'blackout',
  hold: 'hold'
});

const MODE_ALIASES = Object.freeze({
  mirror: 'graphic',
  mirror_graphic: 'graphic',
  'mirror-graphic': 'graphic',
  black: 'blackout',
  safe: 'hold'
});

const PRESET_LAYOUTS = Object.freeze({
  mirror: 'Mirror / single screen',
  'wall-5': '5-screen span',
  'wall-10': '10-screen span',
  any: 'Any layout'
});

const { CLIENT_VERSION: EXPECTED_CLIENT_VERSION, isOlderVersion } = require('./client-version.cjs');
const CLIENT_UPDATE_FILE = 'ISU-Stage-Display-Client-Update.exe';
const CLIENT_UPDATE_MANIFEST = 'stage-client-update.json';

function normalizeStageMode(mode = '') {
  const value = String(mode || '').trim().toLowerCase();
  const normalized = MODE_ALIASES[value] || value;
  return Object.hasOwn(STAGE_DISPLAY_MODES, normalized) ? normalized : '';
}

function stationNumber(value) {
  const station = Math.round(Number(value) || 0);
  return station >= 1 && station <= 11 ? station : null;
}

function normalizePresetLayout(value = '') {
  const layout = String(value || '').trim().toLowerCase();
  return Object.hasOwn(PRESET_LAYOUTS, layout) ? layout : 'any';
}

function stationRange(start, end) {
  const first = Math.max(1, Math.min(10, Math.round(Number(start) || 1)));
  const last = Math.max(first, Math.min(10, Math.round(Number(end) || first)));
  return Array.from({ length: last - first + 1 }, (_item, index) => first + index);
}

function safePresetName(value = '') {
  const name = String(value || '').trim();
  return /^[a-z0-9][a-z0-9_-]*$/i.test(name) ? name : '';
}

function slugPresetName(value = '') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return safePresetName(slug) || `preset-${Date.now()}`;
}

function titleFromName(value = '') {
  return String(value || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function safeCategory(value = '') {
  return String(value || 'General').trim().replace(/[<>:"/\\|?*]+/g, '').slice(0, 40) || 'General';
}

function safeTokenEqual(expected = '', provided = '') {
  const left = Buffer.from(String(expected));
  const right = Buffer.from(String(provided));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requestToken(request, requestUrl) {
  const header = String(request.headers?.['x-stage-token'] || '').trim();
  if (header) return header;
  const bearer = String(request.headers?.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  return String(requestUrl.searchParams.get('token') || '').trim();
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Stage-Token, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS'
  });
  response.end(JSON.stringify(payload));
}

function readRequestBody(request) {
  return new Promise((resolve) => {
    let body = '';
    let tooLarge = false;
    request.on('data', (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > 1024 * 1024) {
        // Resolve instead of destroying the socket so the caller still answers the request.
        tooLarge = true;
        body = '';
        resolve({ __tooLarge: true });
      }
    });
    request.on('end', () => {
      if (tooLarge) return;
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
    request.on('error', () => resolve({}));
  });
}

class StageDisplayManager {
  constructor({ port = 3178, host = '0.0.0.0', assetRoot = '', bundledAssetRoot = '', updateRoot = '', token = '', onStatus = () => {}, now = () => Date.now() } = {}) {
    this.port = Number(port) || 3178;
    // Shared stage key. Empty = open (legacy behaviour) so existing stations keep working until a key is set.
    this.token = String(token || '').trim();
    this.host = host || '0.0.0.0';
    this.assetRoot = assetRoot;
    this.bundledAssetRoot = bundledAssetRoot;
    this.updateRoot = updateRoot;
    this.onStatus = onStatus;
    this.now = now;
    this.wss = null;
    this.heartbeatTimer = null;
    this.stations = new Map();
    this.lastGlobalMode = 'blackout';
    this.pendingPreset = null;
    this.modeAssignments = this.loadModeAssignments();
    this.presets = new Map();
    this.eventLog = [];
    for (let station = 1; station <= 11; station += 1) {
      this.stations.set(station, this.emptyStation(station));
    }
  }

  setToken(token = '') {
    this.token = String(token || '').trim();
    this.recordEvent('stage_key_changed', { enabled: Boolean(this.token) });
    this.emitStatus();
    return { ok: true, keyRequired: Boolean(this.token) };
  }

  tokenAccepted(provided = '') {
    return !this.token || safeTokenEqual(this.token, provided);
  }

  updateManifestPath() {
    return this.updateRoot ? path.join(this.updateRoot, CLIENT_UPDATE_MANIFEST) : '';
  }

  updateFilePath() {
    return this.updateRoot ? path.join(this.updateRoot, CLIENT_UPDATE_FILE) : '';
  }

  modeAssignmentsPath() {
    return this.assetRoot ? path.join(this.assetRoot, 'stage-mode-assignments.json') : '';
  }

  defaultModeAssignments() {
    return {
      wall: { preset: '', wallTotal: 10, wallGroup: '10' },
      graphic: { preset: '' }
    };
  }

  normalizeModeAssignment(mode = '', assignment = {}) {
    const normalized = normalizeStageMode(mode);
    if (!['wall', 'graphic'].includes(normalized)) return null;
    const preset = safePresetName(assignment.preset || '');
    if (!preset) return normalized === 'wall' ? { preset: '', wallTotal: 10, wallGroup: '10' } : { preset: '' };
    const wallTotal = Math.max(1, Math.min(10, Math.round(Number(assignment.wallTotal) || 10)));
    const wallGroup = ['1-5', '6-10', 'mirror-5', '10'].includes(String(assignment.wallGroup || '')) ? String(assignment.wallGroup || '') : (wallTotal === 5 ? 'mirror-5' : '10');
    return normalized === 'wall'
      ? { preset, wallTotal, wallGroup }
      : { preset };
  }

  loadModeAssignments() {
    const defaults = this.defaultModeAssignments();
    const settingsPath = this.modeAssignmentsPath();
    try {
      if (!settingsPath || !fs.existsSync(settingsPath)) return defaults;
      const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return {
        wall: this.normalizeModeAssignment('wall', saved.wall) || defaults.wall,
        graphic: this.normalizeModeAssignment('graphic', saved.graphic) || defaults.graphic
      };
    } catch {
      return defaults;
    }
  }

  saveModeAssignments() {
    const settingsPath = this.modeAssignmentsPath();
    if (!settingsPath) return;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(this.modeAssignments, null, 2), 'utf8');
  }

  assignedPresetForMode(mode = '') {
    const normalized = normalizeStageMode(mode);
    const assignment = this.modeAssignments?.[normalized];
    if (!assignment?.preset) return null;
    const details = this.presetDetails(assignment.preset);
    if (!details) return null;
    return { ...assignment, details };
  }

  assignModePreset(mode = '', preset = '', options = {}) {
    const normalized = normalizeStageMode(mode);
    if (!['wall', 'graphic'].includes(normalized)) return { ok: false, error: 'Only Wall and Mirror Graphic modes can have assigned presets' };
    const details = this.presetDetails(preset);
    if (!details) return { ok: false, error: 'Preset not found' };
    const assignment = this.normalizeModeAssignment(normalized, {
      preset: details.name,
      wallTotal: options.wallTotal,
      wallGroup: options.wallGroup
    });
    this.modeAssignments = {
      ...this.defaultModeAssignments(),
      ...this.modeAssignments,
      [normalized]: assignment
    };
    this.saveModeAssignments();
    this.recordEvent('mode_preset_assigned', { mode: normalized, preset: details.name, wallTotal: assignment.wallTotal || null, wallGroup: assignment.wallGroup || '' });
    this.emitStatus();
    return { ok: true, mode: normalized, preset: details.name, title: details.title, assignment };
  }

  publishedClientUpdate() {
    const manifestPath = this.updateManifestPath();
    const filePath = this.updateFilePath();
    try {
      if (!manifestPath || !filePath || !fs.existsSync(manifestPath) || !fs.existsSync(filePath)) return null;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const size = fs.statSync(filePath).size;
      return {
        available: true,
        version: String(manifest.version || EXPECTED_CLIENT_VERSION),
        fileName: CLIENT_UPDATE_FILE,
        size,
        sha256: String(manifest.sha256 || ''),
        publishedAt: manifest.publishedAt || null,
        manifestUrl: '/api/stage/client-update/manifest',
        downloadUrl: '/api/stage/client-update/download'
      };
    } catch {
      return null;
    }
  }

  publishClientUpdateFromFile(filePath = '', options = {}) {
    if (!this.updateRoot) return { ok: false, error: 'Client update library is not configured' };
    const sourcePath = path.resolve(String(filePath || ''));
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) return { ok: false, error: 'Client update file not found' };
    if (path.extname(sourcePath).toLowerCase() !== '.exe') return { ok: false, error: 'Stage client update must be a Windows .exe build' };
    fs.mkdirSync(this.updateRoot, { recursive: true });
    const destination = this.updateFilePath();
    fs.copyFileSync(sourcePath, destination);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex');
    const manifest = {
      version: String(options.version || EXPECTED_CLIENT_VERSION),
      expectedVersion: EXPECTED_CLIENT_VERSION,
      fileName: CLIENT_UPDATE_FILE,
      sha256: hash,
      size: fs.statSync(destination).size,
      publishedAt: new Date(this.now()).toISOString()
    };
    fs.writeFileSync(this.updateManifestPath(), JSON.stringify(manifest, null, 2), 'utf8');
    this.recordEvent('client_update_published', { version: manifest.version, size: manifest.size });
    this.emitStatus();
    return { ok: true, update: this.publishedClientUpdate() };
  }

  serveClientUpdate(response, requestUrl) {
    const update = this.publishedClientUpdate();
    if (!update) {
      writeJson(response, 404, { ok: false, error: 'No Stage Display Client update has been published' });
      return true;
    }
    if (requestUrl.pathname === '/api/stage/client-update/manifest') {
      writeJson(response, 200, { ok: true, update });
      return true;
    }
    if (requestUrl.pathname === '/api/stage/client-update/download') {
      const filePath = this.updateFilePath();
      response.writeHead(200, {
        'Content-Type': 'application/vnd.microsoft.portable-executable',
        'Content-Length': String(fs.statSync(filePath).size),
        'Content-Disposition': `attachment; filename="${CLIENT_UPDATE_FILE}"`,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(filePath).pipe(response);
      return true;
    }
    return false;
  }

  updateTargetStations(target = 'outdated', stationId = null) {
    if (stationId) return [Number(stationId)].filter((station) => stationNumber(station));
    const stations = Array.from(this.stations.values()).filter((station) => station.online && station.station <= 10);
    if (target === 'all') return stations.map((station) => station.station);
    return stations
      .filter((station) => isOlderVersion(station.clientVersion, this.publishedClientUpdate()?.version))
      .map((station) => station.station);
  }

  sendClientUpdate(target = 'outdated', stationId = null) {
    const update = this.publishedClientUpdate();
    if (!update) return { ok: false, error: 'Publish a Stage Display Client update first' };
    const targets = this.updateTargetStations(target, stationId);
    let sent = 0;
    for (const station of targets) {
      const didSend = this.sendToStation(station, {
        command: 'install_update',
        update: {
          version: update.version,
          manifestUrl: update.manifestUrl,
          downloadUrl: update.downloadUrl,
          sha256: update.sha256,
          size: update.size,
          fileName: update.fileName
        }
      });
      if (didSend) {
        sent += 1;
        const current = this.stations.get(station) || this.emptyStation(station);
        current.updating = true;
        current.updateStatus = `Downloading client ${update.version}`;
        this.stations.set(station, current);
      }
    }
    this.recordEvent('client_update_sent', { target, sent, version: update.version });
    this.emitStatus();
    return { ok: true, sent, targets, update };
  }

  presetRoots() {
    return [this.bundledAssetRoot, this.assetRoot]
      .filter(Boolean)
      .map((root) => path.resolve(root));
  }

  readPresetMetadata(root, name) {
    const metadataPath = path.join(root, name, 'preset.json');
    try {
      if (fs.existsSync(metadataPath)) return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    } catch {}
    return {};
  }

  writablePresetRoot(name = '') {
    const presetName = safePresetName(name);
    if (!presetName || !this.assetRoot) return '';
    const presetRoot = path.resolve(this.assetRoot, presetName);
    const libraryRoot = path.resolve(this.assetRoot);
    if (presetRoot === libraryRoot || !presetRoot.startsWith(`${libraryRoot}${path.sep}`)) return '';
    return presetRoot;
  }

  writePresetMetadata(name = '', updates = {}) {
    const presetRoot = this.writablePresetRoot(name);
    if (!presetRoot || !fs.existsSync(presetRoot)) return { ok: false, error: 'Imported preset was not found' };
    const current = this.readPresetMetadata(this.assetRoot, name);
    const metadata = {
      ...current,
      ...updates,
      title: String(updates.title ?? current.title ?? titleFromName(name)).trim() || titleFromName(name),
      category: safeCategory(updates.category ?? current.category),
      layout: normalizePresetLayout(updates.layout ?? current.layout),
      updatedAt: new Date(this.now()).toISOString()
    };
    fs.writeFileSync(path.join(presetRoot, 'preset.json'), JSON.stringify(metadata, null, 2), 'utf8');
    this.recordEvent('preset_updated', { preset: name, title: metadata.title, category: metadata.category });
    this.emitStatus();
    return { ok: true, preset: this.presetDetails(name) };
  }

  listPresets() {
    const presets = new Map();
    for (const root of this.presetRoots()) {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !safePresetName(entry.name)) continue;
        const indexPath = path.join(root, entry.name, 'index.html');
        if (!fs.existsSync(indexPath)) continue;
        const metadata = this.readPresetMetadata(root, entry.name);
        presets.set(entry.name, {
          name: entry.name,
          title: metadata.title || titleFromName(entry.name),
          layout: metadata.layout || 'any',
          layoutLabel: PRESET_LAYOUTS[normalizePresetLayout(metadata.layout)] || PRESET_LAYOUTS.any,
          kind: metadata.kind || 'html',
          category: metadata.category || 'General',
          width: Number(metadata.width) || null,
          height: Number(metadata.height) || null,
          source: root === path.resolve(this.assetRoot || '') ? 'library' : 'built-in',
          assetPath: `/stage-assets/${encodeURIComponent(entry.name)}/index.html`
        });
      }
    }
    return Array.from(presets.values())
      .sort((left, right) => left.title.localeCompare(right.title));
  }

  presetDetails(name = '') {
    const presetName = safePresetName(name);
    if (!presetName) return null;
    return this.listPresets().find((preset) => preset.name === presetName) || null;
  }

  deletePreset(name = '') {
    const presetName = safePresetName(name);
    if (!presetName) return { ok: false, error: 'Invalid preset name' };
    if (!this.assetRoot) return { ok: false, error: 'Stage asset library is not configured' };
    const presetRoot = this.writablePresetRoot(presetName);
    if (!presetRoot) return { ok: false, error: 'Preset path is outside the stage asset library' };
    if (!fs.existsSync(presetRoot)) return { ok: false, error: 'Imported preset was not found' };
    fs.rmSync(presetRoot, { recursive: true, force: true });
    if (this.pendingPreset?.preset === presetName) this.pendingPreset = null;
    for (const [stationId, station] of this.stations) {
      if (station.preset === presetName || station.preparedPreset === presetName) {
        this.stations.set(stationId, {
          ...station,
          preset: station.preset === presetName ? '' : station.preset,
          preparedPreset: station.preparedPreset === presetName ? '' : station.preparedPreset,
          preparedPlayId: station.preparedPreset === presetName ? '' : station.preparedPlayId,
          preparing: false
        });
      }
    }
    this.recordEvent('preset_deleted', { preset: presetName });
    this.emitStatus();
    return { ok: true, preset: presetName };
  }

  updatePreset(name = '', updates = {}) {
    const presetName = safePresetName(name);
    if (!presetName) return { ok: false, error: 'Invalid preset name' };
    return this.writePresetMetadata(presetName, {
      title: updates.title,
      category: updates.category,
      layout: updates.layout
    });
  }

  resolveAssetPath(relativePath = '') {
    const cleanPath = decodeURIComponent(String(relativePath || '')).replace(/^[/\\]+/, '');
    for (const root of [this.assetRoot, this.bundledAssetRoot].filter(Boolean).map((item) => path.resolve(item))) {
      const target = path.resolve(root, cleanPath);
      if ((target === root || target.startsWith(`${root}${path.sep}`)) && fs.existsSync(target)) return target;
    }
    return '';
  }

  uniquePresetName(baseName = '') {
    const base = slugPresetName(baseName);
    const existing = new Set(this.listPresets().map((preset) => preset.name));
    if (!existing.has(base)) return base;
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${base}-${index}`;
      if (!existing.has(candidate)) return candidate;
    }
    return `${base}-${Date.now()}`;
  }

  importPresetFromFile(filePath = '', options = {}) {
    if (!this.assetRoot) return { ok: false, error: 'Stage asset library is not configured' };
    const sourcePath = path.resolve(String(filePath || ''));
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) return { ok: false, error: 'Source file not found' };
    const extension = path.extname(sourcePath).toLowerCase();
    const supported = new Set(['.html', '.htm', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov']);
    if (!supported.has(extension)) return { ok: false, error: 'Unsupported stage preset file' };
    fs.mkdirSync(this.assetRoot, { recursive: true });
    const title = String(options.title || titleFromName(path.basename(sourcePath))).trim() || 'Stage Preset';
    const name = this.uniquePresetName(options.name || title);
    const presetRoot = path.join(this.assetRoot, name);
    fs.mkdirSync(presetRoot, { recursive: true });
    const metadata = {
      title,
      layout: normalizePresetLayout(options.layout),
      category: safeCategory(options.category),
      kind: extension === '.html' || extension === '.htm' ? 'html' : ['.mp4', '.webm', '.mov'].includes(extension) ? 'video' : 'image',
      width: Number(options.width) || null,
      height: Number(options.height) || null,
      createdAt: new Date(this.now()).toISOString()
    };
    if (metadata.kind === 'html') {
      fs.copyFileSync(sourcePath, path.join(presetRoot, 'index.html'));
    } else {
      const assetName = `asset${extension === '.jpeg' ? '.jpg' : extension}`;
      fs.copyFileSync(sourcePath, path.join(presetRoot, assetName));
      fs.writeFileSync(path.join(presetRoot, 'index.html'), this.renderMediaPresetHtml({ title, assetName, kind: metadata.kind }), 'utf8');
    }
    fs.writeFileSync(path.join(presetRoot, 'preset.json'), JSON.stringify(metadata, null, 2), 'utf8');
    const preset = this.presetDetails(name);
    this.recordEvent('preset_imported', { preset: name, title, layout: metadata.layout });
    this.emitStatus();
    return { ok: true, preset };
  }

  replacePresetFromFile(name = '', filePath = '', options = {}) {
    const presetName = safePresetName(name);
    const presetRoot = this.writablePresetRoot(presetName);
    if (!presetRoot || !fs.existsSync(presetRoot)) return { ok: false, error: 'Imported preset was not found' };
    const sourcePath = path.resolve(String(filePath || ''));
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) return { ok: false, error: 'Source file not found' };
    const extension = path.extname(sourcePath).toLowerCase();
    const supported = new Set(['.html', '.htm', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov']);
    if (!supported.has(extension)) return { ok: false, error: 'Unsupported stage preset file' };
    for (const entry of fs.readdirSync(presetRoot, { withFileTypes: true })) {
      if (entry.name === 'preset.json') continue;
      fs.rmSync(path.join(presetRoot, entry.name), { recursive: true, force: true });
    }
    const current = this.readPresetMetadata(this.assetRoot, presetName);
    const kind = extension === '.html' || extension === '.htm' ? 'html' : ['.mp4', '.webm', '.mov'].includes(extension) ? 'video' : 'image';
    if (kind === 'html') {
      fs.copyFileSync(sourcePath, path.join(presetRoot, 'index.html'));
    } else {
      const assetName = `asset${extension === '.jpeg' ? '.jpg' : extension}`;
      fs.copyFileSync(sourcePath, path.join(presetRoot, assetName));
      fs.writeFileSync(path.join(presetRoot, 'index.html'), this.renderMediaPresetHtml({ title: current.title || titleFromName(presetName), assetName, kind }), 'utf8');
    }
    const metadata = {
      ...current,
      kind,
      width: Number(options.width) || Number(current.width) || null,
      height: Number(options.height) || Number(current.height) || null,
      replacedAt: new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString()
    };
    fs.writeFileSync(path.join(presetRoot, 'preset.json'), JSON.stringify(metadata, null, 2), 'utf8');
    this.recordEvent('preset_replaced', { preset: presetName, kind });
    this.emitStatus();
    return { ok: true, preset: this.presetDetails(presetName) };
  }

  clearStationPreviews() {
    for (const [stationId, station] of this.stations) {
      this.stations.set(stationId, { ...station, preview: '', previewUpdatedAt: null });
    }
    this.recordEvent('previews_cleared', {});
    this.emitStatus();
    return { ok: true };
  }

  renderMediaPresetHtml({ title, assetName, kind }) {
    const safeTitle = String(title || 'Stage Preset').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
    const safeAsset = encodeURI(String(assetName || 'asset.png'));
    const media = kind === 'video'
      ? `<video src="./${safeAsset}" autoplay muted loop playsinline></video>`
      : `<img src="./${safeAsset}" alt="${safeTitle}">`;
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${safeTitle}</title>
    <style>
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #000; }
      body { display: grid; place-items: center; }
      img, video { width: 100%; height: 100%; object-fit: cover; display: block; }
    </style>
  </head>
  <body>${media}</body>
</html>
`;
  }

  emptyStation(station) {
    return {
      station,
      online: false,
      mode: 'offline',
      hostname: '',
      clientVersion: '',
      wallPosition: station === 11 ? 1 : station,
      lastSeen: null,
      connectedAt: null,
      ready: false,
      preparing: false,
      preset: '',
      preparedPreset: '',
      preparedPlayId: '',
      preview: '',
      previewUpdatedAt: null,
      events: [],
      updating: false,
      updateStatus: '',
      clockOffsetMs: null,
      clockRttMs: null,
      conflict: null,
      error: ''
    };
  }

  recordEvent(type, details = {}) {
    const event = {
      time: this.now(),
      type,
      ...details
    };
    this.eventLog.push(event);
    if (this.eventLog.length > 120) this.eventLog.splice(0, this.eventLog.length - 120);
  }

  async start() {
    if (this.wss) return this.status();
    this.wss = new WebSocketServer({ port: this.port, host: this.host });
    this.wss.on('connection', (socket) => this.handleConnection(socket));
    this.wss.on('error', (error) => this.emitStatus({ error: error?.message || String(error) }));
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), 2500);
    this.emitStatus();
    return this.status();
  }

  shutdown() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.wss) {
      for (const client of this.wss.clients) client.close();
      this.wss.close();
      this.wss = null;
    }
  }

  handleConnection(socket) {
    let registeredStation = null;
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('message', (data) => {
      let message = null;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message?.type === 'register') {
        const station = stationNumber(message.station);
        if (!station) {
          socket.close(1008, 'Invalid station');
          return;
        }
        if (!this.tokenAccepted(message.token)) {
          this.recordEvent('client_rejected', { station, reason: 'bad stage key', hostname: String(message.hostname || '') });
          this.emitStatus();
          socket.close(1008, 'Stage key rejected');
          return;
        }
        const current = this.stations.get(station) || this.emptyStation(station);
        const hostname = String(message.hostname || '');
        const existing = current.socket;
        if (existing && existing !== socket && existing.readyState === 1 && current.hostname && hostname && current.hostname !== hostname) {
          // Another PC already owns this station number. Refuse instead of letting the two kick each other off.
          current.conflict = { hostname, at: this.now() };
          this.stations.set(station, current);
          this.recordEvent('station_conflict', { station, owner: current.hostname, rejected: hostname });
          this.emitStatus();
          socket.close(4009, `Station ${station} is already in use by ${current.hostname}`);
          return;
        }
        if (existing && existing !== socket && existing.readyState === 1) {
          // Same PC reconnecting (e.g. network blip): replace its stale socket cleanly.
          try { existing.close(4000, 'Replaced by a new connection from the same station'); } catch {}
        }
        registeredStation = station;
        current.conflict = null;
        current.socket = socket;
        current.online = true;
        current.mode = normalizeStageMode(message.mode) || current.mode || 'hold';
        current.hostname = hostname;
        current.clientVersion = String(message.clientVersion || '');
        current.outdated = isOlderVersion(current.clientVersion, this.publishedClientUpdate()?.version);
        current.wallPosition = stationNumber(message.wallPosition) || station;
        current.connectedAt = this.now();
        current.lastSeen = this.now();
        current.ready = Boolean(message.ready);
        current.error = '';
        this.stations.set(station, current);
        this.recordEvent('client_online', { station, hostname: current.hostname, clientVersion: current.clientVersion });
        this.sendToStation(station, {
          command: 'registered',
          station,
          heartbeatMs: 2500
        });
        this.emitStatus();
        return;
      }
      if (!registeredStation) return;
      this.handleClientMessage(registeredStation, message);
    });
    socket.on('close', () => {
      if (!registeredStation) return;
      const station = this.stations.get(registeredStation) || this.emptyStation(registeredStation);
      if (station.socket === socket) {
        this.stations.set(registeredStation, {
          ...station,
          socket: null,
          online: false,
          ready: false,
          mode: 'offline',
          lastSeen: this.now()
        });
        this.recordEvent('client_offline', { station: registeredStation });
        this.emitStatus();
      }
    });
  }

  handleClientMessage(stationId, message) {
    const station = this.stations.get(stationId) || this.emptyStation(stationId);
    station.lastSeen = this.now();
    if (message.type === 'time_sync') {
      // Echo the client's send time with ours so it can compute its clock offset (NTP-style, ms).
      this.sendToStation(stationId, { command: 'time_sync', clientSentAt: Number(message.clientSentAt) || 0, serverAt: this.now() });
      if (Number.isFinite(Number(message.offsetMs))) station.clockOffsetMs = Math.round(Number(message.offsetMs));
      if (Number.isFinite(Number(message.rttMs))) station.clockRttMs = Math.round(Number(message.rttMs));
      this.stations.set(stationId, station);
      return;
    }
    if (message.type === 'heartbeat' || message.type === 'status') {
      const mode = normalizeStageMode(message.mode);
      if (mode) station.mode = mode;
      station.ready = Boolean(message.ready ?? station.ready);
      station.error = String(message.error || '');
      if (station.error) this.recordEvent('client_error', { station: stationId, error: station.error });
    }
    if (message.type === 'update') {
      station.updating = !['failed', 'relaunching', 'complete'].includes(String(message.status || ''));
      station.updateStatus = String(message.message || message.status || '');
      if (message.status === 'failed') {
        station.error = String(message.error || station.updateStatus || 'Client update failed');
        this.recordEvent('client_update_failed', { station: stationId, error: station.error });
      } else {
        this.recordEvent('client_update_status', { station: stationId, status: message.status || '', message: station.updateStatus });
      }
    }
    if (message.type === 'prepared') {
      station.ready = message.ready !== false && !message.error;
      station.preparing = false;
      station.preparedPreset = String(message.preset || '');
      station.preparedPlayId = String(message.playId || '');
      station.error = String(message.error || '');
      if (station.error) this.recordEvent('prepare_error', { station: stationId, preset: station.preparedPreset, error: station.error });
    }
    if (message.type === 'ready') {
      station.ready = true;
      station.preparing = false;
      station.preset = String(message.preset || station.preset || '');
    }
    if (message.type === 'preview') {
      const preview = String(message.preview || '');
      if (preview.startsWith('data:image/jpeg;base64,') && preview.length < 350000) {
        station.preview = preview;
        station.previewUpdatedAt = this.now();
      }
    }
    this.stations.set(stationId, station);
    this.emitStatus();
  }

  checkHeartbeats() {
    const staleAfter = 10000;
    for (const [stationId, station] of this.stations) {
      if (station.socket?.readyState === 1) {
        if (this.now() - Number(station.lastSeen || 0) > staleAfter) {
          station.socket.terminate();
          this.stations.set(stationId, {
            ...station,
          socket: null,
          online: false,
          ready: false,
          preparing: false,
          mode: 'offline',
          lastSeen: this.now()
          });
        } else {
          station.socket.isAlive = false;
          station.socket.ping();
        }
      }
    }
    this.emitStatus();
  }

  sendToStation(stationId, payload) {
    const station = this.stations.get(Number(stationId));
    if (!station?.socket || station.socket.readyState !== 1) return false;
    station.socket.send(JSON.stringify({
      ...payload,
      serverTime: this.now() / 1000
    }));
    return true;
  }

  targetStationsForOptions(options = {}) {
    if (Array.isArray(options.targetStations) && options.targetStations.length) {
      const targets = [...new Set(options.targetStations.map(stationNumber).filter(Boolean))];
      if (targets.length) return targets;
    }
    if (options.wallGroup === '1-5') return stationRange(1, 5);
    if (options.wallGroup === '6-10') return stationRange(6, 10);
    return stationRange(1, 10);
  }

  wallPositionForStation(stationId, options = {}) {
    const station = Number(stationId);
    if (options.wallGroup === '6-10') return Math.max(1, station - 5);
    if (options.wallGroup === 'mirror-5') return ((station - 1) % 5) + 1;
    return station;
  }

  setStationMode(stationId, mode, options = {}) {
    const station = stationNumber(stationId);
    const normalized = normalizeStageMode(mode);
    if (!station || !normalized) return { ok: false, error: 'Invalid station or mode' };
    const current = this.stations.get(station) || this.emptyStation(station);
    current.mode = current.online ? normalized : current.mode;
    current.ready = false;
    current.preparing = false;
    current.preset = options.preset || '';
    current.preparedPreset = '';
    current.preparedPlayId = '';
    this.stations.set(station, current);
    this.sendToStation(station, {
      command: 'set_mode',
      mode: normalized,
      preset: options.preset || '',
      assetPath: options.assetPath || '',
      individualContent: options.individualContent || null,
      wallPosition: Number(options.wallPosition) || current.wallPosition || station,
      wallTotal: Number(options.wallTotal) || 10,
      executeAt: options.executeAt || null
    });
    this.recordEvent('mode_sent', { station, mode: normalized, preset: options.preset || '' });
    this.emitStatus();
    return { ok: true, station, mode: normalized };
  }

  setGlobalMode(mode, options = {}) {
    const normalized = normalizeStageMode(mode);
    if (!normalized) return { ok: false, error: 'Invalid mode' };
    const assigned = !options.preset ? this.assignedPresetForMode(normalized) : null;
    if (assigned) {
      return this.setGlobalMode(normalized, {
        ...options,
        preset: assigned.details.name,
        assetPath: assigned.details.assetPath,
        wallTotal: assigned.wallTotal || options.wallTotal || 10,
        wallGroup: assigned.wallGroup || options.wallGroup || ''
      });
    }
    this.lastGlobalMode = normalized;
    this.pendingPreset = null;
    const results = [];
    const targets = this.targetStationsForOptions(options);
    for (const station of targets) {
      const wallPosition = normalized === 'wall' ? this.wallPositionForStation(station, options) : station;
      const individualContent = normalized === 'individual'
        ? (options.individualAssignments?.[station] || options.individualAssignments?.[String(station)] || null)
        : options.individualContent;
      results.push(this.setStationMode(station, normalized, { ...options, wallPosition, individualContent }));
      const current = this.stations.get(station);
      if (current && normalized === 'wall') {
        current.wallPosition = wallPosition;
        this.stations.set(station, current);
      }
    }
    this.emitStatus();
    return { ok: true, mode: normalized, results };
  }

  waitForPrepared(playId, timeoutMs = 3500, targetStations = null) {
    const startedAt = this.now();
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const targetSet = targetStations ? new Set(targetStations.map(Number)) : null;
        const onlineStations = Array.from(this.stations.values())
          .filter((station) => station.online && (!targetSet || targetSet.has(Number(station.station))));
        const readyStations = onlineStations.filter((station) => station.ready && !station.error && station.preparedPlayId === playId);
        if (!onlineStations.length || readyStations.length === onlineStations.length || this.now() - startedAt >= timeoutMs) {
          clearInterval(timer);
          resolve({
            online: onlineStations.length,
            ready: readyStations.length,
            timedOut: Boolean(onlineStations.length && readyStations.length < onlineStations.length)
          });
        }
      }, 100);
    });
  }

  readinessForPlay(playId = '', targetStations = null) {
    const targetSet = targetStations ? new Set(targetStations.map(Number)) : null;
    const onlineStations = Array.from(this.stations.values())
      .filter((station) => station.online && (!targetSet || targetSet.has(Number(station.station))));
    const readyStations = onlineStations.filter((station) => station.ready && !station.error && station.preparedPlayId === playId);
    const preparingStations = onlineStations.filter((station) => station.preparing);
    return {
      online: onlineStations.length,
      ready: readyStations.length,
      preparing: preparingStations.length,
      allReady: Boolean(onlineStations.length && readyStations.length === onlineStations.length)
    };
  }

  preparePreset(preset = '', options = {}) {
    const details = this.presetDetails(preset);
    if (!details) return { ok: false, error: 'Preset not found' };
    const mode = normalizeStageMode(options.mode) || 'graphic';
    const wallTotal = Math.max(1, Math.min(10, Number(options.wallTotal) || 10));
    const targetStations = this.targetStationsForOptions(options);
    if (targetStations.includes(11)) return { ok: false, error: 'Use Test Station 11 playback; test clients cannot join a prepared stage cue' };
    const playId = `${details.name}-${this.now()}-${Math.round(Math.random() * 100000)}`;
    this.lastGlobalMode = mode;
    this.pendingPreset = {
      playId,
      preset: details.name,
      title: details.title,
      mode,
      wallTotal,
      wallGroup: options.wallGroup || '',
      targetStations,
      assetPath: details.assetPath,
      requestedAt: this.now()
    };
    for (const station of targetStations) {
      const current = this.stations.get(station) || this.emptyStation(station);
      current.mode = current.online ? mode : current.mode;
      current.ready = false;
      current.preparing = Boolean(current.online);
      current.preset = details.name;
      current.preparedPreset = '';
      current.preparedPlayId = '';
      current.error = '';
      this.stations.set(station, current);
      this.sendToStation(station, {
        command: 'prepare_preset',
        playId,
        preset: details.name,
        assetPath: details.assetPath,
        mode,
        wallPosition: this.wallPositionForStation(station, options),
        wallTotal
      });
    }
    this.emitStatus();
    return {
      ok: true,
      ...this.pendingPreset,
      readiness: this.readinessForPlay(playId, targetStations)
    };
  }

  async playPreparedPreset(options = {}) {
    const pending = this.pendingPreset;
    if (!pending?.playId) return { ok: false, error: 'No stage preset is prepared' };
    const timeoutMs = Math.max(0, Number(options.prepareTimeoutMs) || 3500);
    const readiness = timeoutMs ? await this.waitForPrepared(pending.playId, timeoutMs, pending.targetStations) : this.readinessForPlay(pending.playId, pending.targetStations);
    if (options.requireReady !== false && readiness.online && readiness.ready < readiness.online) {
      this.emitStatus();
      return { ok: false, error: `Only ${readiness.ready} of ${readiness.online} online stations are ready`, readiness, pending };
    }
    const requestedExecuteAt = Number(options.executeAt);
    const executeAt = Number.isFinite(requestedExecuteAt) && requestedExecuteAt > 0
      ? requestedExecuteAt
      : (this.now() / 1000) + 1.0;
    for (const station of pending.targetStations || stationRange(1, 10)) {
      const current = this.stations.get(station) || this.emptyStation(station);
      current.preparing = false;
      this.stations.set(station, current);
      this.sendToStation(station, {
        command: 'play_preset',
        playId: pending.playId,
        preset: pending.preset,
        assetPath: pending.assetPath,
        mode: pending.mode,
        wallPosition: this.wallPositionForStation(station, pending),
        wallTotal: pending.wallTotal,
        executeAt
      });
    }
    this.pendingPreset = null;
    this.emitStatus();
    return {
      ok: true,
      preset: pending.preset,
      mode: pending.mode,
      wallTotal: pending.wallTotal,
      assetPath: pending.assetPath,
      executeAt,
      readiness
    };
  }

  async playPreset(preset = '', options = {}) {
    // Test playback never alters the live stage's prepared cue or global mode.
    if (Array.isArray(options.targetStations) && options.targetStations.length === 1 && Number(options.targetStations[0]) === 11) {
      const details = this.presetDetails(preset);
      if (!details) return { ok: false, error: 'Preset not found' };
      if (!this.stations.get(11)?.online) return { ok: false, error: 'Test Station 11 is offline' };
      const wallTotal = Math.max(1, Math.min(10, Math.round(Number(options.wallTotal) || 1)));
      const wallPosition = Math.max(1, Math.min(wallTotal, Math.round(Number(options.wallPosition) || 1)));
      const result = this.setStationMode(11, options.mode || 'graphic', {
        preset: details.name, assetPath: details.assetPath, wallTotal, wallPosition
      });
      return { ...result, preset: details.name };
    }
    const prepared = this.preparePreset(preset, options);
    if (!prepared.ok) return prepared;
    return this.playPreparedPreset({
      ...options,
      requireReady: false
    });
  }

  status() {
    const update = this.publishedClientUpdate();
    const stations = Array.from(this.stations.values())
      .sort((left, right) => left.station - right.station)
      .map((station) => {
        const { socket: _socket, ...publicStation } = station;
        return { ...publicStation, outdated: isOlderVersion(publicStation.clientVersion, update?.version) };
      });
    return {
      enabled: Boolean(this.wss),
      port: this.port,
      host: this.host,
      wsPath: '/stage',
      modes: Object.values(STAGE_DISPLAY_MODES),
      lastGlobalMode: this.lastGlobalMode,
      onlineCount: stations.filter((station) => station.online && station.station <= 10).length,
      testOnline: Boolean(stations.find((station) => station.station === 11)?.online),
      pendingPreset: this.pendingPreset ? {
        ...this.pendingPreset,
        readiness: this.readinessForPlay(this.pendingPreset.playId, this.pendingPreset.targetStations)
      } : null,
      modeAssignments: {
        wall: this.assignedPresetForMode('wall') ? {
          ...this.modeAssignments.wall,
          title: this.assignedPresetForMode('wall').details.title
        } : this.modeAssignments.wall,
        graphic: this.assignedPresetForMode('graphic') ? {
          ...this.modeAssignments.graphic,
          title: this.assignedPresetForMode('graphic').details.title
        } : this.modeAssignments.graphic
      },
      expectedClientVersion: EXPECTED_CLIENT_VERSION,
      clientUpdate: update || { available: false, version: EXPECTED_CLIENT_VERSION },
      keyRequired: Boolean(this.token),
      warnings: [
        ...stations
          .filter((station) => station.online && station.outdated)
          .map((station) => `Station ${String(station.station).padStart(2, '0')} client ${station.clientVersion} has a newer published update available`),
        ...stations
          .filter((station) => station.conflict && this.now() - Number(station.conflict.at || 0) < 60000)
          .map((station) => `Station ${String(station.station).padStart(2, '0')} is set on two PCs: ${station.hostname || 'this PC'} kept it, ${station.conflict.hostname} was refused`),
        ...stations
          .filter((station) => station.online && Math.abs(Number(station.clockOffsetMs) || 0) > 2000)
          .map((station) => `Station ${String(station.station).padStart(2, '0')} clock is ${Math.round(Number(station.clockOffsetMs) / 1000)}s off the controller (corrected automatically)`)
      ],
      eventLog: this.eventLog.slice(-40),
      stations
    };
  }

  emitStatus(extra = {}) {
    this.onStatus({ ...this.status(), ...extra });
  }

  async handleHttp(request, response, requestUrl) {
    if (!requestUrl.pathname.startsWith('/api/stage')) return false;
    if (request.method === 'OPTIONS') {
      writeJson(response, 204, {});
      return true;
    }
    if (!this.tokenAccepted(requestToken(request, requestUrl))) {
      writeJson(response, 401, { ok: false, error: 'Stage key required (X-Stage-Token header or ?token=)' });
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/stage/status') {
      writeJson(response, 200, this.status());
      return true;
    }
    if (request.method === 'GET' && requestUrl.pathname.startsWith('/api/stage/client-update/')) {
      if (this.serveClientUpdate(response, requestUrl)) return true;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/stage/presets') {
      writeJson(response, 200, { presets: this.listPresets() });
      return true;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/stage/previews/clear') {
      writeJson(response, 200, this.clearStationPreviews());
      return true;
    }
    if (request.method === 'DELETE') {
      const deletePreset = requestUrl.pathname.match(/^\/api\/stage\/preset\/([^/]+)$/);
      if (deletePreset) {
        const result = this.deletePreset(decodeURIComponent(deletePreset[1]));
        writeJson(response, result.ok ? 200 : 400, result);
        return true;
      }
    }
    if (request.method !== 'POST') {
      writeJson(response, 405, { error: 'Method not allowed' });
      return true;
    }
    const body = await readRequestBody(request);
    if (body.__tooLarge) {
      writeJson(response, 413, { ok: false, error: 'Request body too large' });
      return true;
    }
    if (requestUrl.pathname === '/api/stage/prepared/play') {
      const result = await this.playPreparedPreset(body);
      writeJson(response, result.ok ? 200 : 409, result);
      return true;
    }
    if (requestUrl.pathname === '/api/stage/client-update/send') {
      const result = this.sendClientUpdate(body.target || 'outdated', body.station || null);
      writeJson(response, result.ok ? 200 : 400, result);
      return true;
    }
    const updatePreset = requestUrl.pathname.match(/^\/api\/stage\/preset\/([^/]+)\/update$/);
    if (updatePreset) {
      const result = this.updatePreset(decodeURIComponent(updatePreset[1]), body);
      writeJson(response, result.ok ? 200 : 400, result);
      return true;
    }
    const flatPreparePreset = requestUrl.pathname.match(/^\/api\/stage\/prepare\/([^/]+)$/);
    if (flatPreparePreset) {
      const result = this.preparePreset(decodeURIComponent(flatPreparePreset[1]), body);
      writeJson(response, result.ok ? 200 : 400, result);
      return true;
    }
    const globalMode = requestUrl.pathname.match(/^\/api\/stage\/mode\/([^/]+)$/);
    if (globalMode) {
      const result = this.setGlobalMode(globalMode[1], body);
      writeJson(response, result.ok ? 200 : 400, result);
      return true;
    }
    const modePreset = requestUrl.pathname.match(/^\/api\/stage\/mode\/([^/]+)\/preset\/([^/]+)$/);
    if (modePreset) {
      const result = this.assignModePreset(modePreset[1], decodeURIComponent(modePreset[2]), body);
      writeJson(response, result.ok ? 200 : 400, result);
      return true;
    }
    const preset = requestUrl.pathname.match(/^\/api\/stage\/preset\/([^/]+)$/);
    if (preset) {
      const result = this.playPreset(decodeURIComponent(preset[1]), body);
      const resolved = result && typeof result.then === 'function' ? await result : result;
      writeJson(response, resolved.ok ? 200 : 400, resolved);
      return true;
    }
    const preparePreset = requestUrl.pathname.match(/^\/api\/stage\/preset\/([^/]+)\/prepare$/);
    if (preparePreset) {
      const result = this.preparePreset(decodeURIComponent(preparePreset[1]), body);
      writeJson(response, result.ok ? 200 : 400, result);
      return true;
    }
    const deletePreset = requestUrl.pathname.match(/^\/api\/stage\/preset\/([^/]+)\/delete$/);
    if (deletePreset) {
      const result = this.deletePreset(decodeURIComponent(deletePreset[1]));
      writeJson(response, result.ok ? 200 : 400, result);
      return true;
    }
    const stationMode = requestUrl.pathname.match(/^\/api\/stage\/station\/(\d+)\/mode\/([^/]+)$/);
    if (stationMode) {
      const result = this.setStationMode(Number(stationMode[1]), stationMode[2], body);
      writeJson(response, result.ok ? 200 : 400, result);
      return true;
    }
    writeJson(response, 404, { error: 'Stage endpoint not found' });
    return true;
  }
}

module.exports = {
  StageDisplayManager,
  safeTokenEqual,
  STAGE_DISPLAY_MODES,
  normalizeStageMode
};
