const { DEFAULT_PROFILE_ID, FIELD_IDS, getValorantOcrProfile, listValorantOcrProfiles } = require('./valorant-ocr-profiles.cjs');
const { ValorantOcrState, parseScore, parseTimer } = require('./valorant-ocr-state.cjs');
const { WebSocketServer } = require('ws');

const DEFAULTS = Object.freeze({
  enabled: false,
  source: 'local',
  windowName: 'VALORANT',
  captureBackend: 'auto',
  captureFps: 8,
  profileId: DEFAULT_PROFILE_ID,
  language: 'eng',
  scoreboardMode: 'manual',
  recordedVideoMode: false,
  debugRois: true,
  bridgePort: 3175,
  bridgeToken: '',
  roiOverrides: {},
  scoreboardTableOverrides: {},
  observerScanIntervalMs: 25
});

const OBSERVER_CELL_MIN_CONFIDENCE = 0.72;
const OBSERVER_NAME_LOCK_CONFIDENCE = 0.85;
const TIMELINE_SHAPE_GRID_SIZE = 12;
const TIMELINE_ICON_TEMPLATES = Object.freeze({
  'spike-defuse': [
    '..###.###...',
    '..###.####..',
    '.#########..',
    '..########..',
    '..#######...',
    '..#######...',
    '.#########..',
    '###########.',
    '####...####.',
    '###.....####',
    '##.......###',
    '#..........#'
  ],
  elimination: [
    '########.###',
    '############',
    '###########.',
    '###########.',
    '###########.',
    '########.##.',
    '###########.',
    '###########.',
    '.####.####..',
    '############',
    '###.###..###',
    '##.......##.'
  ],
  'spike-detonation': [
    '.....##.....',
    '.....##.....',
    '....###.....',
    '....###.....',
    '.##.####.#..',
    '..########..',
    '.#########..',
    '.#########..',
    '#####.######',
    '#####.#####.',
    '####...####.',
    '.###...####.'
  ]
});

function safePort(value, fallback = DEFAULTS.bridgePort) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

function normalizeSettings(settings = {}) {
  const captureFps = Number(settings.captureFps);
  const observerScanIntervalMs = Number(settings.observerScanIntervalMs);
  const profile = getValorantOcrProfile(settings.profileId, {
    ...(settings.roiOverrides || {}),
    scoreboardTable: settings.scoreboardTableOverrides || {}
  });
  return {
    ...DEFAULTS,
    ...settings,
    enabled: Boolean(settings.enabled),
    source: ['remote', 'simulator'].includes(settings.source) ? settings.source : 'local',
    windowName: String(settings.windowName || DEFAULTS.windowName).trim() || DEFAULTS.windowName,
    captureBackend: ['native', 'electron'].includes(settings.captureBackend) ? settings.captureBackend : 'auto',
    captureFps: Number.isFinite(captureFps) ? Math.max(1, Math.min(15, Math.round(captureFps))) : DEFAULTS.captureFps,
    profileId: profile.id,
    language: 'eng',
    scoreboardMode: ['manual', 'swapped'].includes(settings.scoreboardMode) ? settings.scoreboardMode : 'manual',
    recordedVideoMode: Boolean(settings.recordedVideoMode),
    debugRois: settings.debugRois !== false,
    bridgePort: safePort(settings.bridgePort),
    bridgeToken: String(settings.bridgeToken || '').trim(),
    roiOverrides: Object.fromEntries(FIELD_IDS.map((id) => [id, { ...profile.fields[id].roi }])),
    observerScanIntervalMs: Number.isFinite(observerScanIntervalMs)
      ? Math.max(5, Math.min(100, Math.round(observerScanIntervalMs)))
      : DEFAULTS.observerScanIntervalMs,
    scoreboardTableOverrides: settings.scoreboardTableOverrides && typeof settings.scoreboardTableOverrides === 'object'
      ? JSON.parse(JSON.stringify(settings.scoreboardTableOverrides))
      : {}
  };
}

function chooseOcrConsensus(results = [], kind = 'timer') {
  const parser = kind === 'timer' ? parseTimer : parseScore;
  const candidates = results.map((result) => ({ result, parsed: parser(result?.text) })).filter((candidate) => candidate.parsed.valid);
  if (!candidates.length) {
    const fallback = [...results].sort((left, right) => Number(right?.confidence || 0) - Number(left?.confidence || 0))[0] || { text: '', confidence: 0 };
    return { ...fallback, confidence: Math.min(0.55, Number(fallback.confidence) || 0), consensus: 0, variants: results.length };
  }
  const groups = new Map();
  for (const candidate of candidates) {
    const key = String(candidate.parsed.value);
    const group = groups.get(key) || [];
    group.push(candidate);
    groups.set(key, group);
  }
  const ranked = [...groups.values()].sort((left, right) => right.length - left.length
    || Math.max(...right.map((item) => item.result.confidence || 0)) - Math.max(...left.map((item) => item.result.confidence || 0)));
  const winners = ranked[0];
  const best = [...winners].sort((left, right) => Number(right.result.confidence || 0) - Number(left.result.confidence || 0))[0];
  const agreed = winners.length >= 2;
  const confidence = agreed
    ? winners.reduce((sum, item) => sum + Number(item.result.confidence || 0), 0) / winners.length
    : Math.min(0.55, Number(best.result.confidence) || 0);
  return {
    ...best.result,
    text: best.parsed.normalized,
    confidence,
    latencyMs: results.reduce((sum, result) => sum + (Number(result?.latencyMs) || 0), 0),
    consensus: winners.length,
    variants: results.length
  };
}

function emptyObserverPlayer(index, side) {
  return {
    index,
    side,
    name: '',
    teamTag: '',
    fullName: '',
    ultimate: '',
    ultimateState: { status: 'unknown', current: null, required: null, display: '' },
    kda: { kills: null, deaths: null, assists: null },
    loadout: { weapon: '', confidence: 0, status: 'pending' },
    credits: null,
    ping: null,
    updatedAt: null,
    confidence: 0,
    nameConfidence: 0,
    nameLocked: false,
    nameManual: false,
    raw: {}
  };
}

function emptyObserver3State() {
  return {
    enabled: false,
    profileId: null,
    updatedAt: null,
    nextCellIndex: 0,
    nextNameCellIndex: 0,
    initialNameScanComplete: false,
    activeCell: null,
    roundTimeline: {
      currentRound: null,
      topRole: 'defense',
      bottomRole: 'attack',
      sideSwapAfter: 12,
      rounds: Array.from({ length: 24 }, (_item, index) => ({
        round: index + 1,
        winnerRow: null,
        winnerRole: null,
        method: null,
        current: false,
        confidence: 0,
        updatedAt: null
      }))
    },
    teams: {
      home: { players: Array.from({ length: 5 }, (_item, index) => emptyObserverPlayer(index, 'home')) },
      away: { players: Array.from({ length: 5 }, (_item, index) => emptyObserverPlayer(index, 'away')) }
    }
  };
}

function parseObserverInteger(text, max = 9999) {
  const normalized = String(text ?? '').replace(/[OQD]/gi, '0').replace(/[IL|!]/g, '1').replace(/[^0-9]/g, '');
  if (!normalized) return null;
  const value = Number(normalized);
  return Number.isFinite(value) && value <= max ? value : null;
}

function parseObserverCredits(text) {
  const normalized = String(text ?? '').replace(/[OQD]/gi, '0').replace(/[IL|!]/g, '1').replace(/[^0-9]/g, '');
  if (!normalized) return null;
  const value = Number(normalized);
  if (normalized.length >= 5) {
    const likelyValue = Number(normalized.slice(-4));
    if (Number.isFinite(likelyValue) && likelyValue <= 9000 && likelyValue % 50 === 0) return likelyValue;
  }
  if (Number.isFinite(value) && value <= 9000) {
    if (value < 50) return 0;
    if (value % 50 === 0) return value;
  }
  return null;
}

function cleanObserverText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function acceptedObserverText(result) {
  const cleaned = cleanObserverText(result?.text);
  const confidence = Number(result?.confidence) || 0;
  return confidence >= OBSERVER_CELL_MIN_CONFIDENCE && cleaned ? { cleaned, confidence } : null;
}

function parseObserverUltimate(text) {
  const compact = String(text ?? '').toUpperCase().replace(/\s+/g, '');
  if (!compact) return null;
  if (compact.includes('READY') || compact === 'RFAOY' || compact === 'REAOY') {
    return { status: 'ready', current: null, required: null, display: 'READY' };
  }
  const match = compact.replace(/[OQD]/g, '0').replace(/[IL|!]/g, '1').match(/(\d{1,2})\D+(\d{1,2})/);
  if (!match) return null;
  const current = Number(match[1]);
  const required = Number(match[2]);
  if (!Number.isFinite(current) || !Number.isFinite(required) || required < 1 || required > 12 || current < 0 || current > required) return null;
  return { status: current >= required ? 'ready' : 'charging', current, required, display: current >= required ? 'READY' : `${current}/${required}` };
}

function parseObserverPlayerName(text) {
  const cleaned = cleanObserverText(text)
    .replace(/\s*\|\s*/g, '|')
    .replace(/[^A-Za-z0-9|_.\-[\] ]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const parts = cleaned.split('|').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return {
      teamTag: parts[0].replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 12),
      name: parts.slice(1).join('|').trim().replace(/[^A-Za-z0-9_.\-[\] ]/g, ''),
      fullName: cleaned
    };
  }
  return { teamTag: '', name: cleaned, fullName: cleaned };
}

function emptyTimelineRound(round) {
  return {
    round,
    winnerRow: null,
    winnerRole: null,
    method: null,
    current: false,
    confidence: 0,
    updatedAt: null
  };
}

function selectTimelineComponent(pixels = []) {
  if (!pixels.length) return { pixels: [], bounds: null };
  const byKey = new Map(pixels.map((pixel) => [`${pixel.x},${pixel.y}`, pixel]));
  const visited = new Set();
  let best = [];
  for (const pixel of pixels) {
    const startKey = `${pixel.x},${pixel.y}`;
    if (visited.has(startKey)) continue;
    const queue = [pixel];
    const component = [];
    visited.add(startKey);
    while (queue.length) {
      const current = queue.pop();
      component.push(current);
      for (let y = current.y - 1; y <= current.y + 1; y += 1) {
        for (let x = current.x - 1; x <= current.x + 1; x += 1) {
          if (x === current.x && y === current.y) continue;
          const key = `${x},${y}`;
          if (visited.has(key)) continue;
          const next = byKey.get(key);
          if (!next) continue;
          visited.add(key);
          queue.push(next);
        }
      }
    }
    if (component.length > best.length) best = component;
  }
  if (!best.length) return { pixels: [], bounds: null };
  const xs = best.map((pixel) => pixel.x);
  const ys = best.map((pixel) => pixel.y);
  const teal = best.filter((pixel) => pixel.color === 'teal').length;
  const red = best.filter((pixel) => pixel.color === 'red').length;
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    pixels: best,
    bounds: { minX, maxX, minY, maxY, w: maxX - minX + 1, h: maxY - minY + 1 },
    teal,
    red
  };
}

function pixelStatsFromImage(image) {
  const size = image?.getSize?.() || { width: 0, height: 0 };
  if (!size.width || !size.height || !image?.toBitmap) {
    return {
      width: 0,
      height: 0,
      teal: 0,
      red: 0,
      yellow: 0,
      visible: 0,
      tealTop: 0,
      tealBottom: 0,
      redTop: 0,
      redBottom: 0,
      coloredTop: 0,
      coloredBottom: 0,
      coloredLeft: 0,
      coloredRight: 0,
      coloredCenter: 0,
      coloredCorners: 0,
      shapeGrid: [],
      colorBounds: null
    };
  }
  const bitmap = Buffer.from(image.toBitmap());
  let teal = 0;
  let red = 0;
  let yellow = 0;
  let visible = 0;
  let tealTop = 0;
  let tealBottom = 0;
  let redTop = 0;
  let redBottom = 0;
  let coloredTop = 0;
  let coloredBottom = 0;
  let coloredLeft = 0;
  let coloredRight = 0;
  let coloredCenter = 0;
  let coloredCorners = 0;
  const coloredPixels = [];
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const offset = (y * size.width + x) * 4;
      const blue = bitmap[offset];
      const green = bitmap[offset + 1];
      const redChannel = bitmap[offset + 2];
      const alpha = bitmap[offset + 3];
      if (alpha < 32) continue;
      visible += 1;
      const isTeal = green >= 100 && blue >= 70 && redChannel <= 120 && green > redChannel * 1.25;
      const isRed = redChannel >= 135 && redChannel > green * 1.25 && redChannel > blue * 1.25;
      const isYellow = redChannel >= 165 && green >= 135 && blue <= 130 && redChannel > blue * 1.35;
      const isColoredIcon = isTeal || isRed;
      if (isColoredIcon) {
        coloredPixels.push({ x, y, color: isTeal ? 'teal' : 'red' });
        if (y < size.height / 2) coloredTop += 1;
        else coloredBottom += 1;
        if (x < size.width / 2) coloredLeft += 1;
        else coloredRight += 1;
        if (x > size.width * 0.28 && x < size.width * 0.72 && y > size.height * 0.28 && y < size.height * 0.72) coloredCenter += 1;
        if ((x < size.width * 0.3 || x > size.width * 0.7) && (y < size.height * 0.3 || y > size.height * 0.7)) coloredCorners += 1;
      }
      if (isTeal) {
        teal += 1;
        if (y < size.height / 2) tealTop += 1;
        else tealBottom += 1;
      }
      if (isRed) {
        red += 1;
        if (y < size.height / 2) redTop += 1;
        else redBottom += 1;
      }
      if (isYellow) yellow += 1;
    }
  }
  const shapeRows = Array.from({ length: TIMELINE_SHAPE_GRID_SIZE }, () => '.'.repeat(TIMELINE_SHAPE_GRID_SIZE));
  const component = selectTimelineComponent(coloredPixels);
  if (component.bounds && component.pixels.length) {
    const { minX, minY } = component.bounds;
    const boundsWidth = component.bounds.w;
    const boundsHeight = component.bounds.h;
    const cells = Array.from({ length: TIMELINE_SHAPE_GRID_SIZE }, () => Array(TIMELINE_SHAPE_GRID_SIZE).fill(false));
    for (const pixel of component.pixels) {
      const gx = Math.min(TIMELINE_SHAPE_GRID_SIZE - 1, Math.floor(((pixel.x - minX) * TIMELINE_SHAPE_GRID_SIZE) / boundsWidth));
      const gy = Math.min(TIMELINE_SHAPE_GRID_SIZE - 1, Math.floor(((pixel.y - minY) * TIMELINE_SHAPE_GRID_SIZE) / boundsHeight));
      cells[gy][gx] = true;
    }
    for (let row = 0; row < TIMELINE_SHAPE_GRID_SIZE; row += 1) {
      shapeRows[row] = cells[row].map((filled) => (filled ? '#' : '.')).join('');
    }
  }
  return {
    width: size.width,
    height: size.height,
    teal,
    red,
    yellow,
    visible,
    tealTop,
    tealBottom,
    redTop,
    redBottom,
    coloredTop,
    coloredBottom,
    coloredLeft,
    coloredRight,
    coloredCenter,
    coloredCorners,
    shapeGrid: shapeRows,
    colorBounds: component.bounds,
    componentPixels: component.pixels.length,
    componentTeal: component.teal || 0,
    componentRed: component.red || 0
  };
}

function timelineShapeSimilarity(grid = [], template = []) {
  let overlap = 0;
  let union = 0;
  for (let row = 0; row < TIMELINE_SHAPE_GRID_SIZE; row += 1) {
    const gridRow = grid[row] || '';
    const templateRow = template[row] || '';
    for (let column = 0; column < TIMELINE_SHAPE_GRID_SIZE; column += 1) {
      const sourceFilled = gridRow[column] === '#';
      const templateFilled = templateRow[column] === '#';
      if (sourceFilled && templateFilled) overlap += 1;
      if (sourceFilled || templateFilled) union += 1;
    }
  }
  return union ? overlap / union : 0;
}

function rankedTimelineShapeScores(stats) {
  return Object.entries(TIMELINE_ICON_TEMPLATES)
    .map(([method, template]) => ({ method, score: timelineShapeSimilarity(stats.shapeGrid, template) }))
    .sort((left, right) => right.score - left.score);
}

function classifyTimelineMethodByShape(stats) {
  const ranked = rankedTimelineShapeScores(stats);
  const best = ranked[0];
  const second = ranked[1];
  if (best && best.score >= 0.58 && best.score - (second?.score || 0) >= 0.035) return best.method;
  return null;
}

function timelineIconPresence(stats) {
  if (!stats?.colorBounds) return { present: false, method: null, confidence: 0, color: null };
  const visible = Math.max(1, stats.visible || (stats.width * stats.height) || 1);
  const colored = Number(stats.componentPixels) || ((Number(stats.teal) || 0) + (Number(stats.red) || 0));
  const colorRatio = colored / visible;
  const bounds = stats.colorBounds;
  const width = Math.max(1, stats.width);
  const height = Math.max(1, stats.height);
  const boxWidthRatio = bounds.w / width;
  const boxHeightRatio = bounds.h / height;
  const ranked = rankedTimelineShapeScores(stats);
  const best = ranked[0] || { method: null, score: 0 };
  const second = ranked[1] || { score: 0 };
  const margin = best.score - second.score;
  const teal = Number(stats.componentTeal) || Number(stats.teal) || 0;
  const red = Number(stats.componentRed) || Number(stats.red) || 0;
  const color = teal > red * 1.25 ? 'teal' : red > teal * 1.25 ? 'red' : null;
  const method = classifyTimelineMethod(stats, colorRatio);
  const isLargeBackground = boxWidthRatio > 0.78 || boxHeightRatio > 0.92;
  const isTinyNoise = colored < 8 || boxWidthRatio < 0.08 || boxHeightRatio < 0.14;
  const hasTemplateShape = best.score >= 0.50 && margin >= 0.02;
  const hasGeometryShape = method && method !== 'unknown' && colorRatio >= 0.018 && boxWidthRatio >= 0.16 && boxHeightRatio >= 0.22;
  const present = Boolean(color && !isLargeBackground && !isTinyNoise && (hasTemplateShape || hasGeometryShape));
  return {
    present,
    method: present ? (hasTemplateShape ? best.method : method) : null,
    confidence: present ? Math.min(1, Math.max(colorRatio * 18, best.score)) : 0,
    color,
    colorRatio,
    shapeScore: best.score,
    shapeMargin: margin,
    colorBounds: bounds
  };
}

function timelineShapeScores(stats) {
  return Object.fromEntries(Object.entries(TIMELINE_ICON_TEMPLATES)
    .map(([method, template]) => [method, Math.round(timelineShapeSimilarity(stats.shapeGrid, template) * 1000) / 1000]));
}

function classifyTimelineMethod(stats, confidence) {
  if (!stats?.colorBounds || confidence < 0.03) return null;
  const templateMethod = classifyTimelineMethodByShape(stats);
  if (templateMethod) return templateMethod;
  const bounds = stats.colorBounds;
  const width = Math.max(1, stats.width);
  const height = Math.max(1, stats.height);
  const colored = Math.max(1, (Number(stats.teal) || 0) + (Number(stats.red) || 0));
  const boxWidthRatio = bounds.w / width;
  const boxHeightRatio = bounds.h / height;
  const aspect = bounds.w / Math.max(1, bounds.h);
  const centerRatio = (Number(stats.coloredCenter) || 0) / colored;
  const cornerRatio = (Number(stats.coloredCorners) || 0) / colored;
  const verticalBalance = Math.min(Number(stats.coloredTop) || 0, Number(stats.coloredBottom) || 0)
    / Math.max(1, Math.max(Number(stats.coloredTop) || 0, Number(stats.coloredBottom) || 0));
  const horizontalBalance = Math.min(Number(stats.coloredLeft) || 0, Number(stats.coloredRight) || 0)
    / Math.max(1, Math.max(Number(stats.coloredLeft) || 0, Number(stats.coloredRight) || 0));

  // Known VALORANT timeline icons:
  // elimination = circle/X crossed icon, detonation = burst/explosion,
  // defuse = clippers/pliers, unknown = star/special or ambiguous shape.
  if (boxHeightRatio > 0.48 && aspect < 0.55 && verticalBalance < 0.68) return 'spike-defuse';
  if (boxWidthRatio > 0.46 && boxHeightRatio > 0.42 && centerRatio < 0.34 && cornerRatio > 0.12) return 'elimination';
  if (aspect > 0.82 && aspect < 1.45 && centerRatio >= 0.20 && verticalBalance >= 0.46 && horizontalBalance >= 0.46) return 'spike-detonation';
  if (boxWidthRatio > 0.40 && boxHeightRatio > 0.36) return 'elimination';
  return 'unknown';
}

class ValorantOcrService {
  constructor({ capture = null, ocr = null, onState = () => {}, onStatus = () => {}, now = () => Date.now() } = {}) {
    this.capture = capture;
    this.ocr = ocr;
    this.onState = onState;
    this.onStatus = onStatus;
    this.now = now;
    this.settings = { ...DEFAULTS };
    this.validator = new ValorantOcrState();
    this.captureTimer = null;
    this.ocrTimer = null;
    this.watchdogTimer = null;
    this.simulatorTimer = null;
    this.server = null;
    this.bridgeClients = new Set();
    this.remoteState = null;
    this.remoteSequence = 0;
    this.lastRemoteAt = 0;
    this.captureBusy = false;
    this.ocrBusy = false;
    this.generation = 0;
    this.lastScannedAt = Object.fromEntries(FIELD_IDS.map((id) => [id, 0]));
    this.lastScannedFrameAt = Object.fromEntries(FIELD_IDS.map((id) => [id, 0]));
    this.observer3 = emptyObserver3State();
    this.lastObserverTableScannedAt = 0;
    this.latestFrame = null;
    this.frameTimestamps = [];
    this.scanTimestamps = [];
    this.latencies = [];
    this.captureFailures = 0;
    this.consecutiveCaptureFailures = 0;
    this.lastCaptureErrorAt = 0;
    this.lastCaptureRecoveredAt = 0;
    this.status = this.makeStatus('disabled', 'VALORANT OCR is off');
  }

  makeStatus(state, message, extra = {}) {
    const now = this.now();
    const snapshot = this.settings.source === 'remote'
      ? this.remoteSnapshot(now)
      : this.validator.snapshot(now);
    const lastTrustedAt = Math.max(0, ...FIELD_IDS.map((id) => snapshot.fields[id].updatedAt || 0));
    return {
      state,
      message,
      enabled: Boolean(this.settings.enabled),
      source: this.settings.source,
      profileId: this.settings.profileId,
      windowName: this.settings.windowName,
      captureBackend: this.latestFrame?.backend || this.settings.captureBackend,
      captureFps: this.frameRate(now),
      captureWidth: this.latestFrame?.width || null,
      captureHeight: this.latestFrame?.height || null,
      scans: snapshot.metrics.observations,
      scansPerSecond: this.scanRate(now),
      accepted: snapshot.metrics.accepted,
      rejected: snapshot.metrics.rejected,
      avgOcrLatencyMs: this.latencies.length ? Math.round(this.latencies.reduce((sum, value) => sum + value, 0) / this.latencies.length) : null,
      lastFrameAt: this.latestFrame?.capturedAt || null,
      frameAgeMs: this.latestFrame ? now - this.latestFrame.capturedAt : null,
      captureFailures: this.captureFailures,
      consecutiveCaptureFailures: this.consecutiveCaptureFailures,
      lastCaptureErrorAt: this.lastCaptureErrorAt || null,
      lastCaptureRecoveredAt: this.lastCaptureRecoveredAt || null,
      usingLastGoodFrame: this.consecutiveCaptureFailures > 0 && Boolean(this.latestFrame),
      lastTrustedAt: lastTrustedAt || null,
      trustedAgeMs: lastTrustedAt ? now - lastTrustedAt : null,
      bridgeClients: this.bridgeClients.size,
      lastPacketAt: this.lastRemoteAt || null,
      dataAgeMs: this.lastRemoteAt ? now - this.lastRemoteAt : null,
      updatedAt: now,
      ...extra
    };
  }

  emitStatus(state = this.status.state, message = this.status.message, extra = {}) {
    this.status = this.makeStatus(state, message, extra);
    this.onStatus({ ...this.status });
    return this.status;
  }

  emitState(now = this.now()) {
    if (this.settings.source === 'remote') {
      const state = this.remoteSnapshot(now);
      this.onState(state);
      return state;
    }
    const snapshot = this.validator.snapshot(now);
    const state = this.normalizedState(snapshot, now);
    this.onState(state);
    return state;
  }

  remoteSnapshot(now = this.now()) {
    if (!this.remoteState) {
      const state = this.normalizedState(new ValorantOcrState().snapshot(now), now);
      state.connected = false;
      state.capture = { width: 1920, height: 1080, fps: 0, lastFrameAt: null, windowName: this.settings.windowName };
      return state;
    }
    const state = JSON.parse(JSON.stringify(this.remoteState));
    const networkStale = !this.lastRemoteAt || now - this.lastRemoteAt > 1500;
    state.connected = !networkStale && this.bridgeClients.size > 0;
    state.receivedAt = this.lastRemoteAt || null;
    state.networkAgeMs = this.lastRemoteAt ? now - this.lastRemoteAt : null;
    if (networkStale && state.fields) {
      for (const field of Object.values(state.fields)) field.stale = true;
    }
    return state;
  }

  normalizedState(snapshot = this.validator.snapshot(this.now()), now = this.now()) {
    const homeScore = snapshot.fields.homeScore;
    const timer = snapshot.fields.timer;
    const awayScore = snapshot.fields.awayScore;
    return {
      source: 'valorant-ocr',
      connected: Boolean(this.settings.enabled && (this.settings.source === 'simulator' || (this.latestFrame && now - this.latestFrame.capturedAt <= 2500))),
      capture: {
        width: this.latestFrame?.width || 1920,
        height: this.latestFrame?.height || 1080,
        fps: this.frameRate(now),
        lastFrameAt: this.latestFrame?.capturedAt || null,
        windowName: this.latestFrame?.sourceName || this.settings.windowName,
        backend: this.latestFrame?.backend || this.settings.captureBackend,
        failures: this.captureFailures,
        consecutiveFailures: this.consecutiveCaptureFailures,
        recovering: this.consecutiveCaptureFailures > 0,
        usingLastGoodFrame: this.consecutiveCaptureFailures > 0 && Boolean(this.latestFrame)
      },
      match: { timerSeconds: timer.value, timerDisplay: timer.displayValue },
      teams: {
        home: { score: homeScore.value },
        away: { score: awayScore.value }
      },
      observer3: JSON.parse(JSON.stringify(this.observer3)),
      ...snapshot
    };
  }

  configure(nextSettings = {}) {
    const wasEnabled = this.settings.enabled;
    this.stopLoops();
    this.settings = normalizeSettings(nextSettings);
    this.validator.setRecordedVideoMode(this.settings.recordedVideoMode);
    this.lastScannedAt = Object.fromEntries(FIELD_IDS.map((id) => [id, 0]));
    this.lastScannedFrameAt = Object.fromEntries(FIELD_IDS.map((id) => [id, 0]));
    this.observer3 = emptyObserver3State();
    this.lastObserverTableScannedAt = 0;
    this.frameTimestamps = [];
    this.scanTimestamps = [];
    this.latencies = [];
    this.captureFailures = 0;
    this.consecutiveCaptureFailures = 0;
    this.lastCaptureErrorAt = 0;
    this.lastCaptureRecoveredAt = 0;
    if (!this.settings.enabled) {
      void this.capture?.close?.();
      this.emitState();
      return this.emitStatus('disabled', 'VALORANT OCR is off');
    }
    this.startWatchdog();
    if (this.settings.source === 'simulator') {
      this.startSimulator();
      return this.status;
    }
    if (this.settings.source === 'remote') {
      this.emitStatus('starting', 'Starting VALORANT bridge receiver');
      this.startReceiver();
      return this.status;
    }
    if (!this.capture || !this.ocr) return this.emitStatus('error', 'OCR capture service is unavailable');
    this.emitStatus('starting', wasEnabled ? 'Restarting VALORANT OCR' : 'Starting VALORANT OCR');
    this.scheduleCapture(0);
    this.scheduleOcr(0);
    return this.status;
  }

  stopLoops() {
    this.generation += 1;
    clearTimeout(this.captureTimer);
    clearTimeout(this.ocrTimer);
    clearInterval(this.watchdogTimer);
    clearInterval(this.simulatorTimer);
    this.captureTimer = null;
    this.ocrTimer = null;
    this.watchdogTimer = null;
    this.simulatorTimer = null;
    for (const client of this.bridgeClients) client.close();
    this.bridgeClients.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  stop() {
    this.stopLoops();
    void this.capture?.close?.();
    this.settings = { ...this.settings, enabled: false };
    return this.emitStatus('disabled', 'VALORANT OCR is off');
  }

  async shutdown() {
    this.stop();
    await this.capture?.close?.();
    await this.ocr?.close?.();
  }

  scheduleCapture(delay = Math.round(1000 / this.settings.captureFps)) {
    const generation = this.generation;
    clearTimeout(this.captureTimer);
    this.captureTimer = setTimeout(async () => {
      if (generation !== this.generation || !this.settings.enabled || this.settings.source !== 'local') return;
      await this.captureTick();
      if (generation === this.generation && this.settings.enabled) this.scheduleCapture();
    }, delay);
  }

  scheduleOcr(delay = 20) {
    const generation = this.generation;
    clearTimeout(this.ocrTimer);
    this.ocrTimer = setTimeout(async () => {
      if (generation !== this.generation || !this.settings.enabled || this.settings.source !== 'local') return;
      await this.ocrTick();
      if (generation === this.generation && this.settings.enabled) this.scheduleOcr();
    }, delay);
  }

  async captureTick() {
    if (this.captureBusy) return false;
    this.captureBusy = true;
    const generation = this.generation;
    const now = this.now();
    try {
      const frame = await this.capture.capture(this.settings.windowName, {
        backend: this.settings.captureBackend,
        captureFps: this.settings.captureFps
      });
      if (generation !== this.generation) return false;
      if (this.consecutiveCaptureFailures > 0) this.lastCaptureRecoveredAt = now;
      this.consecutiveCaptureFailures = 0;
      const isNewFrame = !this.latestFrame || frame.capturedAt !== this.latestFrame.capturedAt;
      this.latestFrame = frame;
      if (isNewFrame) {
        this.frameTimestamps.push(frame.capturedAt || now);
        this.frameTimestamps = this.frameTimestamps.filter((value) => now - value <= 2000);
      }
      return isNewFrame;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.captureFailures += 1;
      this.consecutiveCaptureFailures += 1;
      this.lastCaptureErrorAt = this.now();
      const transient = ['CAPTURE_EMPTY', 'WINDOW_NOT_FOUND', 'NATIVE_CAPTURE_TIMEOUT', 'NATIVE_CAPTURE_CLOSED'].includes(error?.code);
      const retainingFrame = transient && Boolean(this.latestFrame);
      let state;
      let message;
      if (transient && this.consecutiveCaptureFailures <= 3) {
        state = this.latestFrame ? 'recovering' : 'searching-window';
        message = `${error?.message || 'Capture temporarily unavailable'}; retrying automatically (${this.consecutiveCaptureFailures}/3)`;
      } else {
        state = error?.code === 'WINDOW_NOT_FOUND' && !this.latestFrame ? 'searching-window' : error?.code === 'CAPTURE_SIZE' || transient ? 'degraded' : 'error';
        message = error?.message || 'VALORANT OCR capture failed';
      }
      this.emitState();
      this.emitStatus(state, message, {
        errorCode: error?.code || 'OCR_ERROR',
        usingLastGoodFrame: retainingFrame,
        retrying: transient
      });
      return false;
    } finally {
      this.captureBusy = false;
    }
  }

  async recognizeField(frame, fieldId, field) {
    const base = { ...field.preprocess };
    delete base.variants;
    const variants = Array.isArray(field.preprocess.variants) && field.preprocess.variants.length
      ? field.preprocess.variants
      : [{}];
    const results = [];
    for (const variant of variants) {
      const recipe = { ...base, ...variant };
      const crop = this.capture.crop(frame, field.roi, recipe);
      results.push(await this.ocr.recognize(crop.image, { ...recipe, kind: field.kind, fieldId }));
    }
    const result = variants.length > 1 ? chooseOcrConsensus(results, field.kind) : results[0];
    if (fieldId === 'timer') {
      const parsed = parseTimer(result.text);
      const redRatio = typeof this.capture.redRatio === 'function' ? this.capture.redRatio(frame, field.roi) : 0;
      if ((!parsed.valid || Number(result.confidence) < 0.58) && redRatio >= 0.035) {
        return {
          text: 'SPIKE PLANTED',
          confidence: Math.min(1, Math.max(0.82, redRatio * 12)),
          latencyMs: Number(result.latencyMs) || 0,
          kind: 'timer',
          state: 'spike-planted',
          source: 'color-detect',
          redRatio
        };
      }
    }
    return result;
  }

  observerRows(profile) {
    const table = profile.scoreboardTable;
    if (!table?.teams || !table?.columns) return [];
    const rows = [];
    for (const team of table.teams) {
      for (let row = 0; row < Number(team.rows || 0); row += 1) {
        rows.push({ team, side: team.id, row });
      }
    }
    return rows;
  }

  observerCells(profile) {
    const table = profile.scoreboardTable;
    if (!table?.columns) return [];
    const wanted = ['playerName', 'ultimate', 'kills', 'deaths', 'assists', 'loadoutIcon', 'credits'];
    return this.observerRows(profile).flatMap((rowInfo) => wanted
      .filter((columnId) => table.columns[columnId])
      .map((columnId) => ({ ...rowInfo, columnId, column: table.columns[columnId] })));
  }

  observerTimelineCells(profile) {
    const rounds = profile.scoreboardTable?.roundTimeline?.rounds;
    if (!rounds) return [];
    return Object.entries(rounds)
      .map(([round, roi]) => ({
        side: 'timeline',
        row: Number(round) - 1,
        round: Number(round),
        columnId: 'roundTimeline',
        roi
      }))
      .filter((cell) => Number.isInteger(cell.round) && cell.round >= 1 && cell.round <= 24)
      .sort((left, right) => left.round - right.round);
  }

  observerNameCells(profile) {
    return this.observerCells(profile).filter((cell) => cell.columnId === 'playerName');
  }

  isObserverNameLocked(cellInfo) {
    const player = this.observer3.teams[cellInfo.side]?.players?.[cellInfo.row];
    return Boolean(player?.nameLocked && player?.name);
  }

  shouldSkipObserverCell(cellInfo) {
    return cellInfo.columnId === 'playerName' && this.isObserverNameLocked(cellInfo);
  }

  observerPreviewGuides(profile) {
    const table = profile.scoreboardTable;
    if (!table?.columns) return [];
    const guides = [
      { id: 'playerName', label: 'NAME', columns: ['playerName'], kind: 'text' },
      { id: 'ultimate', label: 'ULT', columns: ['ultimate'], kind: 'text', allowedChars: '0123456789/READYready ' },
      { id: 'kda', label: 'K/D/A', columns: ['kills', 'deaths', 'assists'], kind: 'score', allowedChars: '0123456789' },
      { id: 'loadoutIcon', label: 'LOADOUT', columns: ['loadoutIcon'], kind: 'icon' },
      { id: 'credits', label: 'CREDS', columns: ['credits'], kind: 'score', allowedChars: '0123456789,¤' }
    ];
    return this.observerRows(profile).flatMap((rowInfo) => guides
      .map((guide) => {
        const columns = guide.columns.map((id) => table.columns[id]).filter(Boolean);
        if (!columns.length) return null;
        const minX = Math.min(...columns.map((column) => Number(column.x) || 0));
        const maxX = Math.max(...columns.map((column) => (Number(column.x) || 0) + (Number(column.w) || 0)));
        return {
          ...rowInfo,
          guideId: guide.id,
          label: guide.label,
          column: {
            x: minX,
            w: maxX - minX,
            kind: guide.kind,
            allowedChars: guide.allowedChars
          }
        };
      })
      .filter(Boolean));
  }

  observerTimelineRoi(profile, round) {
    const roi = profile.scoreboardTable?.roundTimeline?.rounds?.[String(round)];
    if (!roi) return null;
    return {
      x: Math.max(0, Math.round(Number(roi.x) || 0)),
      y: Math.max(0, Math.round(Number(roi.y) || 0)),
      w: Math.max(1, Math.round(Number(roi.w) || 1)),
      h: Math.max(12, Math.round(Number(roi.h) || 12))
    };
  }

  analyzeObserverTimelineRound(frame, profile, cellInfo) {
    const roi = this.observerTimelineRoi(profile, cellInfo.round);
    if (!roi || !frame?.image?.crop) return emptyTimelineRound(cellInfo.round);
    const image = frame.image.crop({ x: roi.x, y: roi.y, width: roi.w, height: roi.h });
    const stats = pixelStatsFromImage(image);
    const visible = Math.max(1, stats.visible || (stats.width * stats.height) || 1);
    const color = stats.teal + stats.red;
    const yellowRatio = stats.yellow / visible;
    const colorRatio = color / visible;
    const current = yellowRatio >= 0.015;

    const halfHeight = Math.max(1, Math.floor(roi.h / 2));
    const topImage = image.crop({ x: 0, y: 0, width: roi.w, height: halfHeight });
    const bottomImage = image.crop({ x: 0, y: Math.max(0, roi.h - halfHeight), width: roi.w, height: halfHeight });
    const topStats = pixelStatsFromImage(topImage);
    const bottomStats = pixelStatsFromImage(bottomImage);
    const topIcon = timelineIconPresence(topStats);
    const bottomIcon = timelineIconPresence(bottomStats);

    let winnerRow = null;
    let method = null;
    let methodStats = null;
    let iconConfidence = 0;
    if (topIcon.present && (!bottomIcon.present || topIcon.confidence >= bottomIcon.confidence * 0.9)) {
      winnerRow = 'top';
      method = topIcon.method;
      methodStats = topStats;
      iconConfidence = topIcon.confidence;
    } else if (bottomIcon.present) {
      winnerRow = 'bottom';
      method = bottomIcon.method;
      methodStats = bottomStats;
      iconConfidence = bottomIcon.confidence;
    }
    const confidence = Math.min(1, Math.max(iconConfidence, current ? yellowRatio * 14 : 0));
    const topRole = this.observer3.roundTimeline.topRole || 'defense';
    const bottomRole = this.observer3.roundTimeline.bottomRole || 'attack';
    return {
      round: cellInfo.round,
      winnerRow,
      winnerRole: winnerRow === 'top' ? topRole : winnerRow === 'bottom' ? bottomRole : null,
      method,
      current,
      confidence,
      stats: {
        teal: stats.teal,
        red: stats.red,
        yellow: stats.yellow,
        colorRatio,
        yellowRatio,
        topColor: topStats.teal + topStats.red,
        bottomColor: bottomStats.teal + bottomStats.red,
        topIcon,
        bottomIcon,
        method: methodStats ? {
          teal: methodStats.teal,
          red: methodStats.red,
          yellow: methodStats.yellow,
          shape: methodStats.shapeGrid,
          shapeScores: timelineShapeScores(methodStats),
          colorBounds: methodStats.colorBounds
        } : null
      },
      updatedAt: this.now()
    };
  }

  async recognizeObserverCell(frame, fieldId, roi, column) {
    if (fieldId.includes('-credits')) return this.recognizeObserverCreditsCell(frame, fieldId, roi);
    if (fieldId.includes('-loadoutIcon')) return this.recognizeObserverLoadoutCell(frame, fieldId, roi);
    const preprocess = {
      scale: column.kind === 'text' ? 2 : 3,
      grayscale: true,
      threshold: 'otsu',
      invert: 'auto',
      allowedChars: column.allowedChars || '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz:/,.-_ []'
    };
    const crop = this.capture.crop(frame, roi, preprocess);
    return this.ocr.recognize(crop.image, {
      ...preprocess,
      kind: column.kind || 'text',
      fieldId
    });
  }

  async recognizeObserverLoadoutCell(frame, fieldId, roi) {
    const crop = this.capture.crop(frame, roi, {
      scale: 2,
      grayscale: true,
      threshold: 'none',
      invert: false,
      allowedChars: ''
    });
    return {
      text: '',
      confidence: 0,
      latencyMs: 0,
      kind: 'icon',
      fieldId,
      image: crop.processedDataUrl,
      reason: 'weapon icon matcher pending'
    };
  }

  async recognizeObserverCreditsCell(frame, fieldId, roi) {
    const clampRoi = (next) => {
      const x = Math.max(0, Math.min(1919, Math.round(next.x)));
      const y = Math.max(0, Math.min(1079, Math.round(next.y)));
      return {
        x,
        y,
        w: Math.max(1, Math.min(1920 - x, Math.round(next.w))),
        h: Math.max(12, Math.min(1080 - y, Math.round(next.h)))
      };
    };
    const shifted = (leftRatio, rightRatio = 0) => {
      const left = Math.round(roi.w * leftRatio);
      const right = Math.round(roi.w * rightRatio);
      return clampRoi({ x: roi.x + left, y: roi.y, w: roi.w - left - right, h: roi.h });
    };
    const variants = [
      { roi: clampRoi(roi), threshold: 'otsu', allowedChars: '0123456789,\u00a4' },
      { roi: shifted(0.10), threshold: 'otsu', allowedChars: '0123456789,' },
      { roi: shifted(0.16), threshold: 'otsu', allowedChars: '0123456789,' },
      { roi: shifted(0.22), threshold: 'otsu', allowedChars: '0123456789,' },
      { roi: shifted(0.16), threshold: 145, allowedChars: '0123456789,' }
    ];
    const results = [];
    for (const [index, variant] of variants.entries()) {
      const preprocess = {
        scale: 4,
        grayscale: true,
        threshold: variant.threshold,
        invert: 'auto',
        allowedChars: variant.allowedChars
      };
      const crop = this.capture.crop(frame, variant.roi, preprocess);
      const result = await this.ocr.recognize(crop.image, {
        ...preprocess,
        kind: 'currency',
        fieldId: `${fieldId}-v${index}`
      });
      const value = parseObserverCredits(result.text);
      if (value !== null) results.push({ ...result, value, variantIndex: index });
    }
    const grouped = Array.from(results.reduce((groups, result) => {
      const group = groups.get(result.value) || {
        value: result.value,
        confidence: 0,
        count: 0,
        comma: false,
        fullCrop: false,
        result
      };
      group.confidence = Math.max(group.confidence, Number(result.confidence) || 0);
      group.count += 1;
      group.comma = group.comma || String(result.text || '').includes(',');
      group.fullCrop = group.fullCrop || result.variantIndex === 0;
      if ((Number(result.confidence) || 0) >= (Number(group.result.confidence) || 0)) group.result = result;
      groups.set(result.value, group);
      return groups;
    }, new Map()).values());
    const bestGroup = grouped.sort((left, right) => {
      const rightScore = right.confidence + right.count * 0.22 + (right.comma ? 0.05 : 0) + (right.fullCrop ? 0.04 : 0);
      const leftScore = left.confidence + left.count * 0.22 + (left.comma ? 0.05 : 0) + (left.fullCrop ? 0.04 : 0);
      if (rightScore !== leftScore) return rightScore - leftScore;
      return left.value - right.value;
    })[0];
    const best = bestGroup?.result;
    if (!best) return { text: '', confidence: 0, latencyMs: 0, kind: 'currency' };
    return {
      ...best,
      text: Number(best.value).toLocaleString('en-US'),
      confidence: Math.max(Number(best.confidence) || 0, 0.78),
      kind: 'currency'
    };
  }

  observerPreviewRoi(profile, guideInfo) {
    const table = profile.scoreboardTable;
    const rowY = guideInfo.team.origin.y + guideInfo.row * guideInfo.team.rowHeight;
    const rowHeight = Math.max(12, Math.round(Number(guideInfo.team.rowHeight) || 40) - 4);
    const saved = table?.cells?.[guideInfo.side]?.[guideInfo.row] || {};
    const direct = saved[guideInfo.guideId];
    if (direct) {
      return {
        x: Math.max(0, Math.round(Number(direct.x) || 0)),
        y: Math.max(0, Math.round(Number(direct.y) || 0)),
        w: Math.max(1, Math.round(Number(direct.w) || 1)),
        h: Math.max(12, Math.round(Number(direct.h) || 12))
      };
    }
    return {
      x: guideInfo.team.origin.x + guideInfo.column.x,
      y: rowY,
      w: guideInfo.column.w,
      h: rowHeight
    };
  }

  observerCellRoi(profile, cellInfo) {
    const table = profile.scoreboardTable;
    const rowY = cellInfo.team.origin.y + cellInfo.row * cellInfo.team.rowHeight;
    const rowHeight = Math.max(12, Math.round(Number(cellInfo.team.rowHeight) || 40) - 4);
    const saved = table?.cells?.[cellInfo.side]?.[cellInfo.row] || {};
    const direct = saved[cellInfo.columnId];
    if (direct) {
      return {
        x: Math.max(0, Math.round(Number(direct.x) || 0)),
        y: Math.max(0, Math.round(Number(direct.y) || 0)),
        w: Math.max(1, Math.round(Number(direct.w) || 1)),
        h: Math.max(12, Math.round(Number(direct.h) || 12))
      };
    }
    if (['kills', 'deaths', 'assists'].includes(cellInfo.columnId) && saved.kda) {
      const kdaIndex = ['kills', 'deaths', 'assists'].indexOf(cellInfo.columnId);
      const width = Math.max(1, Math.round((Number(saved.kda.w) || 3) / 3));
      return {
        x: Math.max(0, Math.round((Number(saved.kda.x) || 0) + kdaIndex * width)),
        y: Math.max(0, Math.round(Number(saved.kda.y) || 0)),
        w: width,
        h: Math.max(12, Math.round(Number(saved.kda.h) || 12))
      };
    }
    return {
      x: cellInfo.team.origin.x + cellInfo.column.x,
      y: rowY,
      w: cellInfo.column.w,
      h: rowHeight
    };
  }

  observerPreviewCrops(frame, profile) {
    const previews = [];
    for (const guide of this.observerPreviewGuides(profile)) {
      const preprocess = {
        scale: guide.column.kind === 'text' ? 2 : 3,
        grayscale: true,
        threshold: 'otsu',
        invert: 'auto',
        allowedChars: guide.column.allowedChars || '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz:/,.-_ []'
      };
      try {
        const crop = this.capture.crop(frame, this.observerPreviewRoi(profile, guide), preprocess);
        previews.push({
          side: guide.side,
          row: guide.row,
          id: guide.guideId,
          label: guide.label,
          rawDataUrl: crop.rawDataUrl,
          processedDataUrl: crop.processedDataUrl
        });
      } catch {}
    }
    return previews;
  }

  observerTimelinePreviewCrops(frame, profile) {
    const previews = [];
    for (const cell of this.observerTimelineCells(profile)) {
      const roi = this.observerTimelineRoi(profile, cell.round);
      if (!roi) continue;
      try {
        const crop = this.capture.crop(frame, roi, {
          scale: 4,
          grayscale: true,
          threshold: 'otsu',
          invert: 'auto',
          allowedChars: ''
        });
        previews.push({
          round: cell.round,
          id: 'roundTimeline',
          label: `ROUND ${cell.round}`,
          rawDataUrl: crop.rawDataUrl,
          processedDataUrl: crop.processedDataUrl
        });
      } catch {}
    }
    return previews;
  }

  scanObserverTimelineCell(frame, profile, cellInfo) {
    this.observer3.activeCell = {
      side: 'timeline',
      row: cellInfo.round - 1,
      columnId: 'roundTimeline',
      round: cellInfo.round,
      updatedAt: this.now()
    };
    const result = this.analyzeObserverTimelineRound(frame, profile, cellInfo);
    const rounds = [...(this.observer3.roundTimeline.rounds || [])];
    rounds[cellInfo.round - 1] = {
      ...emptyTimelineRound(cellInfo.round),
      ...(rounds[cellInfo.round - 1] || {}),
      ...result
    };
    const currentRoundFromMarker = rounds.find((round) => round?.current)?.round || null;
    const completedRounds = rounds.filter((round) => round?.winnerRow).length;
    const currentRoundFromTimeline = completedRounds > 0 && completedRounds < 24 ? completedRounds + 1 : null;
    const scoreSnapshot = this.validator.snapshot(this.now());
    const homeScore = Number(scoreSnapshot.fields?.homeScore?.value);
    const awayScore = Number(scoreSnapshot.fields?.awayScore?.value);
    const currentRoundFromScore = Number.isFinite(homeScore) && Number.isFinite(awayScore)
      ? Math.max(1, Math.min(24, homeScore + awayScore + 1))
      : null;
    const currentRoundFromCleanMarker = currentRoundFromMarker && !rounds[currentRoundFromMarker - 1]?.winnerRow
      ? currentRoundFromMarker
      : null;
    const currentRound = currentRoundFromScore || currentRoundFromTimeline || currentRoundFromCleanMarker;
    this.observer3.roundTimeline = {
      ...this.observer3.roundTimeline,
      currentRound,
      rounds: rounds.map((round, index) => ({
        ...emptyTimelineRound(index + 1),
        ...(round || {}),
        current: currentRound === index + 1 && !round?.winnerRow
      }))
    };
    this.observer3.enabled = true;
    this.observer3.profileId = profile.id;
    this.observer3.updatedAt = result.updatedAt || this.now();
    return true;
  }

  async scanObserver3Cell(frame, profile, cellInfo) {
    const table = profile.scoreboardTable;
    if (!table?.columns) return false;
    this.observer3.activeCell = {
      side: cellInfo.side,
      row: cellInfo.row,
      columnId: cellInfo.columnId,
      updatedAt: this.now()
    };
    const roi = this.observerCellRoi(profile, cellInfo);
    const result = await this.recognizeObserverCell(frame, `observer3-${cellInfo.side}-${cellInfo.row}-${cellInfo.columnId}`, roi, cellInfo.column);
    const accepted = acceptedObserverText(result);
    const team = this.observer3.teams[cellInfo.side] || { players: [] };
    const player = {
      ...emptyObserverPlayer(cellInfo.row, cellInfo.side),
      ...(team.players[cellInfo.row] || {}),
      raw: { ...(team.players[cellInfo.row]?.raw || {}) }
    };
    if (cellInfo.columnId === 'playerName' && player.nameManual && player.nameLocked) {
      team.players[cellInfo.row] = player;
      this.observer3.teams[cellInfo.side] = team;
      this.observer3.enabled = true;
      this.observer3.profileId = profile.id;
      this.observer3.updatedAt = this.now();
      return true;
    }
    if (accepted) {
      const { cleaned, confidence } = accepted;
      player.raw[cellInfo.columnId] = cleaned;
      if (cellInfo.columnId === 'playerName') {
        const parsedName = parseObserverPlayerName(cleaned);
        player.name = parsedName.name;
        player.teamTag = parsedName.teamTag;
        player.fullName = parsedName.fullName;
        player.nameConfidence = confidence;
        player.nameLocked = confidence >= OBSERVER_NAME_LOCK_CONFIDENCE && Boolean(parsedName.name);
        player.nameManual = false;
      }
      if (cellInfo.columnId === 'ultimate') {
        const ultimate = parseObserverUltimate(cleaned);
        if (ultimate) {
          player.ultimate = ultimate.display;
          player.ultimateState = ultimate;
        }
      }
      if (cellInfo.columnId === 'kills') {
        const value = parseObserverInteger(cleaned, 99);
        if (value !== null) player.kda = { ...player.kda, kills: value };
      }
      if (cellInfo.columnId === 'deaths') {
        const value = parseObserverInteger(cleaned, 99);
        if (value !== null) player.kda = { ...player.kda, deaths: value };
      }
      if (cellInfo.columnId === 'assists') {
        const value = parseObserverInteger(cleaned, 99);
        if (value !== null) player.kda = { ...player.kda, assists: value };
      }
      if (cellInfo.columnId === 'credits') {
        const value = parseObserverCredits(cleaned);
        if (value !== null) player.credits = value;
      }
      player.updatedAt = this.now();
      player.confidence = Math.max(Number(player.confidence) || 0, confidence);
    }
    team.players[cellInfo.row] = player;
    this.observer3.teams[cellInfo.side] = team;
    this.observer3.enabled = true;
    this.observer3.profileId = profile.id;
    this.observer3.updatedAt = player.updatedAt || this.observer3.updatedAt || this.now();
    return true;
  }

  setObserverPlayerName({ side = '', row = 0, name = '' } = {}) {
    const normalizedSide = side === 'away' ? 'away' : 'home';
    const index = Math.max(0, Math.min(4, Math.round(Number(row) || 0)));
    const parsedName = parseObserverPlayerName(name);
    const finalName = cleanObserverText(parsedName.name).slice(0, 40);
    if (!finalName) return this.normalizedState(this.validator.snapshot(this.now()), this.now());
    const team = this.observer3.teams[normalizedSide] || { players: [] };
    const player = {
      ...emptyObserverPlayer(index, normalizedSide),
      ...(team.players[index] || {}),
      raw: { ...(team.players[index]?.raw || {}) }
    };
    player.name = finalName;
    player.teamTag = parsedName.teamTag;
    player.fullName = parsedName.fullName || finalName;
    player.nameConfidence = 1;
    player.nameLocked = true;
    player.nameManual = true;
    player.raw.playerName = finalName;
    player.updatedAt = this.now();
    player.confidence = Math.max(Number(player.confidence) || 0, 1);
    team.players[index] = player;
    this.observer3.teams[normalizedSide] = team;
    this.observer3.enabled = true;
    this.observer3.updatedAt = player.updatedAt;
    this.observer3.activeCell = {
      side: normalizedSide,
      row: index,
      columnId: 'playerName',
      updatedAt: player.updatedAt
    };
    return this.emitState();
  }

  async scanObserver3Table(frame, profile, now) {
    if (now - this.lastObserverTableScannedAt < this.settings.observerScanIntervalMs) return false;
    const nameCells = this.observerNameCells(profile);
    if (!this.observer3.initialNameScanComplete && nameCells.length) {
      for (let attempts = 0; attempts < nameCells.length; attempts += 1) {
        const index = this.observer3.nextNameCellIndex % nameCells.length;
        const cell = nameCells[index];
        this.observer3.nextNameCellIndex = index + 1;
        if (this.observer3.nextNameCellIndex >= nameCells.length) {
          this.observer3.nextNameCellIndex = 0;
          this.observer3.initialNameScanComplete = true;
        }
        if (this.shouldSkipObserverCell(cell)) continue;
        this.lastObserverTableScannedAt = now;
        return this.scanObserver3Cell(frame, profile, cell);
      }
      this.observer3.nextNameCellIndex = 0;
      this.observer3.initialNameScanComplete = true;
    }
    const cells = [
      ...this.observerCells(profile).filter((cell) => !this.shouldSkipObserverCell(cell)),
      ...this.observerTimelineCells(profile)
    ];
    if (!cells.length) return false;
    const index = this.observer3.nextCellIndex % cells.length;
    this.observer3.nextCellIndex = (index + 1) % cells.length;
    this.lastObserverTableScannedAt = now;
    if (cells[index].columnId === 'roundTimeline') return this.scanObserverTimelineCell(frame, profile, cells[index]);
    return this.scanObserver3Cell(frame, profile, cells[index]);
  }

  async ocrTick() {
    if (this.ocrBusy || !this.latestFrame || this.consecutiveCaptureFailures > 0) return false;
    const generation = this.generation;
    const frame = this.latestFrame;
    const now = this.now();
    const profile = getValorantOcrProfile(this.settings.profileId, {
      ...(this.settings.roiOverrides || {}),
      scoreboardTable: this.settings.scoreboardTableOverrides || {}
    });
    const dueFields = FIELD_IDS.filter((id) => now - this.lastScannedAt[id] >= profile.fields[id].cadenceMs
      && frame.capturedAt !== this.lastScannedFrameAt[id]);
    const hasObserverTable = Boolean(profile.scoreboardTable);
    if (!dueFields.length && !hasObserverTable) return false;
    this.ocrBusy = true;
    try {
      const results = await Promise.all(dueFields.map(async (fieldId) => ({
        fieldId,
        result: await this.recognizeField(frame, fieldId, profile.fields[fieldId])
      })));
      if (generation !== this.generation) return false;
      for (const { fieldId, result } of results) {
        const observedAt = this.now();
        this.lastScannedAt[fieldId] = observedAt;
        this.lastScannedFrameAt[fieldId] = frame.capturedAt;
        this.scanTimestamps.push(observedAt);
        this.scanTimestamps = this.scanTimestamps.filter((value) => observedAt - value <= 2000);
        if (Number.isFinite(result.latencyMs)) {
          this.latencies.push(result.latencyMs);
          if (this.latencies.length > 30) this.latencies.shift();
        }
        this.validator.observe(fieldId, { ...result, source: 'ocr' }, observedAt);
      }
      this.emitState();
      const snapshot = this.validator.snapshot(this.now());
      const trustedCount = FIELD_IDS.filter((id) => snapshot.fields[id].value !== null).length;
      this.emitStatus(trustedCount === FIELD_IDS.length ? 'reading' : 'calibrating', trustedCount === FIELD_IDS.length
        ? 'Reading VALORANT scoreboard'
        : `Capture active; locked ${trustedCount} of ${FIELD_IDS.length} fields`, {
        sourceName: frame.sourceName,
        captureBackend: frame.backend || this.settings.captureBackend,
        observer3Scanning: false
      });
      if (hasObserverTable) {
        const observerScanned = await this.scanObserver3Table(frame, profile, this.now());
        if (observerScanned && generation === this.generation) {
          this.emitState();
          this.emitStatus(this.status.state, this.status.message, {
            sourceName: frame.sourceName,
            captureBackend: frame.backend || this.settings.captureBackend,
            observer3Scanning: true
          });
        }
      }
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.emitStatus('degraded', `OCR recognition failed: ${error?.message || error}`, { errorCode: error?.code || 'OCR_ERROR' });
      return false;
    } finally {
      this.ocrBusy = false;
    }
  }

  async tick() {
    await this.captureTick();
    return this.ocrTick();
  }

  frameRate(now = this.now()) {
    const recent = this.frameTimestamps.filter((value) => now - value <= 2000);
    if (recent.length < 2) return recent.length;
    return Math.round(((recent.length - 1) / ((recent.at(-1) - recent[0]) / 1000)) * 10) / 10;
  }

  scanRate(now = this.now()) {
    const recent = this.scanTimestamps.filter((value) => now - value <= 2000);
    if (recent.length < 2) return recent.length;
    const seconds = (recent.at(-1) - recent[0]) / 1000;
    return seconds > 0 ? Math.round(((recent.length - 1) / seconds) * 10) / 10 : recent.length;
  }

  startWatchdog() {
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => {
      const snapshot = this.emitState();
      if (this.settings.source === 'remote' && this.lastRemoteAt && this.now() - this.lastRemoteAt > 1500) {
        this.emitStatus('stale', 'Game PC data is stale; retaining the last trusted values', { transport: 'bridge' });
      } else if (this.status.state === 'reading' && FIELD_IDS.every((id) => snapshot.fields[id].stale)) {
        this.emitStatus('stale', 'OCR data is stale; retaining the last trusted values');
      } else this.emitStatus();
    }, 500);
  }

  clearState() {
    if (this.settings.source === 'remote') {
      this.remoteState = null;
      this.remoteSequence = 0;
      this.lastRemoteAt = 0;
      this.emitStatus('listening', 'Remote state cleared; waiting for Game PC', { transport: 'bridge' });
      return this.emitState();
    }
    const snapshot = this.validator.clear(this.now());
    this.observer3 = emptyObserver3State();
    this.lastObserverTableScannedAt = 0;
    this.onState(this.normalizedState(snapshot));
    this.emitStatus(this.settings.enabled ? 'calibrating' : 'disabled', this.settings.enabled ? 'OCR state cleared; waiting for a stable read' : 'VALORANT OCR is off');
    return this.normalizedState(snapshot);
  }

  async listWindows() {
    if (this.settings.source === 'remote') return [];
    if (!this.capture) return [];
    return this.capture.listWindows();
  }

  async captureSnapshot() {
    if (this.settings.source === 'remote') throw new Error('Capture debug frames on the Game PC bridge');
    if (!this.capture) throw new Error('Capture service is unavailable');
    const frame = await this.capture.capture(this.settings.windowName);
    this.latestFrame = frame;
    const profile = getValorantOcrProfile(this.settings.profileId, {
      ...(this.settings.roiOverrides || {}),
      scoreboardTable: this.settings.scoreboardTableOverrides || {}
    });
    return {
      ...this.capture.snapshot(frame, profile.fields),
      profile,
      observer3: JSON.parse(JSON.stringify(this.observer3)),
      observerCrops: this.observerPreviewCrops(frame, profile),
      observerTimelineCrops: this.observerTimelinePreviewCrops(frame, profile)
    };
  }

  startReceiver() {
    if (!this.settings.bridgeToken) return this.emitStatus('error', 'Create a bridge key before starting remote mode');
    try {
      this.server = new WebSocketServer({ host: '0.0.0.0', port: this.settings.bridgePort });
    } catch (error) {
      return this.emitStatus('error', error.message, { transport: 'bridge' });
    }
    this.server.on('listening', () => this.emitStatus('listening', `Waiting for Game PC on port ${this.settings.bridgePort}`, { transport: 'bridge' }));
    this.server.on('error', (error) => this.emitStatus('error', `Bridge receiver error: ${error.message}`, { transport: 'bridge' }));
    this.server.on('connection', (client, request) => {
      const requestUrl = new URL(request.url, `ws://${request.headers.host || 'localhost'}`);
      if (requestUrl.searchParams.get('token') !== this.settings.bridgeToken) {
        client.close(1008, 'Invalid bridge key');
        return;
      }
      this.bridgeClients.add(client);
      this.emitStatus('connected', 'Universal Game Bridge connected; waiting for VALORANT data', { transport: 'bridge' });
      client.on('message', (raw) => {
        try {
          const packet = JSON.parse(raw.toString());
          if (packet.game !== 'valorant' || !['game-state', 'valorant-state'].includes(packet.type)) return;
          const sequence = Number(packet.sequence) || 0;
          if (sequence && sequence <= this.remoteSequence) return;
          if (sequence) this.remoteSequence = sequence;
          if (!packet.payload || typeof packet.payload !== 'object') return;
          this.remoteState = packet.payload;
          this.lastRemoteAt = this.now();
          this.onState(this.remoteSnapshot(this.lastRemoteAt));
          this.emitStatus('reading', 'Receiving validated VALORANT OCR from Game PC', { transport: 'bridge' });
        } catch {}
      });
      client.on('close', () => {
        this.bridgeClients.delete(client);
        this.emitStatus('listening', `Game PC disconnected; waiting on port ${this.settings.bridgePort}`, { transport: 'bridge' });
      });
      client.on('error', () => {});
      client.send(JSON.stringify({ type: 'welcome', game: 'valorant', version: 1 }));
    });
  }

  startSimulator() {
    this.stopLoops();
    this.settings = { ...this.settings, enabled: true, source: 'simulator' };
    this.validator.clear(this.now());
    this.latestFrame = null;
    this.frameTimestamps = [];
    this.scanTimestamps = [];
    this.latencies = [];
    this.startWatchdog();
    const startedAt = this.now();
    const apply = () => {
      const elapsed = Math.floor((this.now() - startedAt) / 1000);
      const roundLength = 100;
      const timer = Math.max(0, roundLength - (elapsed % 110));
      const round = Math.floor(elapsed / 110);
      const values = { homeScore: Math.min(13, round), timer, awayScore: Math.min(13, Math.floor(round / 2)) };
      for (const fieldId of FIELD_IDS) {
        const value = values[fieldId];
        const text = fieldId === 'timer' ? `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}` : String(value);
        this.validator.observe(fieldId, { text, confidence: 0.99, latencyMs: 1, source: 'simulator' }, this.now());
      }
      this.emitState();
      this.emitStatus('simulating', 'Deterministic OCR test feed is running');
    };
    apply();
    apply();
    apply();
    this.simulatorTimer = setInterval(apply, 250);
    return this.status;
  }

  stopSimulator() {
    this.stopLoops();
    this.settings = { ...this.settings, enabled: false, source: 'local' };
    return this.emitStatus('disabled', 'VALORANT OCR test feed stopped');
  }

  getInfo() {
    return { settings: { ...this.settings }, status: { ...this.status }, profiles: listValorantOcrProfiles(), state: this.normalizedState() };
  }
}

module.exports = { DEFAULTS, ValorantOcrService, chooseOcrConsensus, normalizeSettings };
