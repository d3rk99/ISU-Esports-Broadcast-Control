import './styles.css';
import { GAME_CONFIGS, GAME_ORDER, createGameState, createPlayer, rocketLeagueArenaName } from './game-config.js';
import { advanceGameMatch, applyCompanionAction, swapGameTeams } from './companion-actions.js';
import { deepClone, loadState, saveState } from './store.js';
import { DEFAULT_VALORANT_OCR_PROFILE_ID, VALORANT_OCR_FIELD_IDS, VALORANT_OCR_PROFILE_CHOICES, getValorantOcrProfile } from './valorant-ocr-profiles.js';

const root = document.querySelector('#app');
let state = loadState();
if (!['scoreboard', 'roster', 'map-pool', 'clean'].includes(state.activeOutputOverlay)) state.activeOutputOverlay = 'scoreboard';
const savedRocketLeagueConnection = window.isuDesktop?.savedRocketLeagueConnection;
if (savedRocketLeagueConnection && typeof savedRocketLeagueConnection === 'object') {
  state.games.rocketleague.rocketLeague = {
    ...state.games.rocketleague.rocketLeague,
    ...savedRocketLeagueConnection
  };
}
const savedValorantOcrSettings = window.isuDesktop?.savedValorantOcrSettings;
if (savedValorantOcrSettings && typeof savedValorantOcrSettings === 'object') {
  state.games.valorant.valorantOcr = {
    ...state.games.valorant.valorantOcr,
    ...savedValorantOcrSettings,
    live: state.games.valorant.valorantOcr.live
  };
}
let history = [];
let saveTimer;
let livePublishTimer;
let liveRenderTimer;
let lastUserScrollAt = 0;
let networkAddresses = [];
let outputDisplays = [];
let valorantOcrSnapshot = null;
let valorantDebugFullscreen = false;
let valorantWindowChoices = [];
let valorantOcrRenderTimer;
let valorantRoiDrag = null;
let lastValorantOcrActiveKey = '';
let valorantLoadoutTemplateWeapon = 'operator';
let valorantLoadoutTemplateSide = 'home';
let valorantLoadoutTemplateRow = 4;
let outputDisplaySettings = {
  fillDisplayId: '',
  keyDisplayId: '',
  ...(window.isuDesktop?.savedOutputDisplaySettings || {})
};
let companionSettings = {
  enabled: false,
  port: 3176,
  token: '',
  ...(window.isuDesktop?.savedCompanionSettings || {})
};
let companionStatus = { enabled: companionSettings.enabled, listening: false, port: companionSettings.port, clients: 0, error: '' };
const overlayBaseUrl = window.isuDesktop?.overlayBaseUrl || 'http://127.0.0.1:3174';
const ROCKET_LEAGUE_EVENT_BADGE_MS = 5500;
const ROCKET_LEAGUE_EVENT_FADE_MS = 850;
const ROCKET_LEAGUE_STAT_EVENTS = [
  { key: 'goals', label: 'G', title: 'Goal', priority: 5 },
  { key: 'assists', label: 'A', title: 'Assist', priority: 4 },
  { key: 'saves', label: 'V', title: 'Save', priority: 3 },
  { key: 'shots', label: 'S', title: 'Shot', priority: 2 },
  { key: 'demos', label: 'D', title: 'Demo', priority: 1 }
];
const VALORANT_LOADOUT_TEMPLATE_WEAPONS = [
  'classic', 'shorty', 'frenzy', 'ghost', 'sheriff',
  'stinger', 'spectre', 'bucky', 'judge',
  'bulldog', 'guardian', 'phantom', 'vandal',
  'marshal', 'outlaw', 'operator', 'ares', 'odin', 'melee'
];

const valorantWeaponLabel = (weapon = '') => String(weapon)
  .replaceAll('-', ' ')
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

const ICONS = {
  control: '<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M10 14v6"/></svg>',
  maps: '<svg viewBox="0 0 24 24"><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15M15 6v15"/></svg>',
  roster: '<svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  outputs: '<svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.16.4.4.75.73 1 .3.25.7.4 1.1.4H21v4h-.09A1.7 1.7 0 0 0 19.4 15Z"/></svg>'
};

const escapeHtml = (value = '') => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

function current() {
  return state.games[state.selectedGame];
}

function activeRosterCollection(game = current()) {
  return state.activeRosterSide === 'away' ? game.awayRosters : game.rosters;
}

function persistState() {
  state.programTransitionSeconds = Math.max(0.1, Math.min(5, Number(state.programTransitionSeconds) || 1));
  state = saveState(state);
  window.isuDesktop?.publishState(state);
  return state;
}

function commit(mutator, message = 'Changes saved') {
  history.push(deepClone(state));
  if (history.length > 30) history.shift();
  mutator();
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    persistState();
    updateSaveStatus(message);
  }, 120);
}

function updateSaveStatus(message) {
  const status = document.querySelector('#save-status');
  if (!status) return;
  status.innerHTML = '<span class="status-dot"></span>' + escapeHtml(message);
  status.classList.add('flash');
  window.setTimeout(() => status.classList.remove('flash'), 700);
}

function toast(message) {
  document.querySelector('.toast')?.remove();
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  document.body.append(node);
  requestAnimationFrame(() => node.classList.add('show'));
  window.setTimeout(() => node.remove(), 2200);
}

function render() {
  const previousScroller = root.querySelector('.content-scroll');
  const previousScroll = previousScroller
    ? { top: previousScroller.scrollTop, left: previousScroller.scrollLeft }
    : null;
  const config = GAME_CONFIGS[state.selectedGame];
  root.style.setProperty('--game-accent', config.accent);
  root.innerHTML = `
    <div class="app-shell">
      ${renderSidebar(config)}
      <main class="workspace">
        ${renderTopbar(config)}
        <div class="content-scroll">${renderView(config)}</div>
      </main>
    </div>
    ${valorantDebugFullscreen ? renderValorantDebugFullscreen() : ''}
  `;
  if (previousScroll) {
    const nextScroller = root.querySelector('.content-scroll');
    if (nextScroller) {
      nextScroller.scrollTop = previousScroll.top;
      nextScroller.scrollLeft = previousScroll.left;
    }
  }
}

function renderSidebar(config) {
  const nav = [
    ['control', 'Match Control'],
    ['maps', 'Map Pool'],
    ['roster', 'Rosters'],
    ['outputs', 'OBS Outputs']
  ];
  return `
    <aside class="sidebar">
      <div class="brand-lockup">
        <div class="brand-mark"><span>IS</span><i></i></div>
        <div><strong>ISU ESPORTS</strong><small>Broadcast Control</small></div>
      </div>
      <label class="game-picker-label" for="game-select">ACTIVE TITLE</label>
      <div class="game-picker">
        <span class="game-chip">${escapeHtml(config.shortName)}</span>
        <select id="game-select" aria-label="Select active game">
          ${GAME_ORDER.map((key) => `<option value="${key}" ${key === state.selectedGame ? 'selected' : ''}>${escapeHtml(GAME_CONFIGS[key].name)}</option>`).join('')}
        </select>
        <svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg>
      </div>
      <nav class="primary-nav" aria-label="Main navigation">
        <p>PRODUCTION</p>
        ${nav.map(([key, label]) => `
          <button class="nav-item ${state.activeView === key ? 'active' : ''}" data-view="${key}">
            ${ICONS[key]}<span>${label}</span>
          </button>`).join('')}
      </nav>
      <div class="sidebar-spacer"></div>
      <button class="nav-item ${state.activeView === 'settings' ? 'active' : ''}" data-view="settings">
        ${ICONS.settings}<span>Settings</span>
      </button>
      <div class="system-state"><span></span><div><b>LOCAL SYSTEM</b><small>Ready for production</small></div></div>
      <div class="brand-footer">IDAHO STATE UNIVERSITY <b>&bull;</b> POCATELLO</div>
    </aside>`;
}

function renderTopbar(config) {
  const labels = {
    control: ['Match Control', 'Run the live score and match state'],
    maps: ['Map Pool', `Plan and record the ${config.name} series`],
    roster: ['Team Rosters', 'Manage Home and Away Varsity/JV lineups'],
    outputs: ['OBS Outputs', 'Browser-source graphics and live asset status'],
    settings: ['Workspace Settings', 'Defaults, data, and application information']
  };
  const [title, subtitle] = labels[state.activeView];
  return `
    <header class="topbar">
      <div><p class="eyebrow">${escapeHtml(config.shortName)} / CONTROL CENTER</p><h1>${title}</h1><span>${subtitle}</span></div>
      <div class="topbar-actions">
        <div id="save-status" class="save-status"><span class="status-dot"></span>Auto-save active</div>
        <button class="icon-button" data-action="undo" title="Undo last change" ${history.length ? '' : 'disabled'}>
          <svg viewBox="0 0 24 24"><path d="M9 7 4 12l5 5M4 12h10a6 6 0 0 1 6 6"/></svg>
        </button>
        <div class="live-pill ${current().match.live ? 'on' : ''}"><span></span>${current().match.live ? 'LIVE' : 'OFF AIR'}</div>
      </div>
    </header>`;
}

function renderView(config) {
  if (state.activeView === 'maps') return renderMaps(config);
  if (state.activeView === 'roster') return renderRosters(config);
  if (state.activeView === 'outputs') return renderOutputs();
  if (state.activeView === 'settings') return renderSettings();
  return renderControl(config);
}

function renderControl(config) {
  const game = current();
  const activeMap = game.mapRows[game.activeMap] || game.mapRows[0];
  const length = seriesLength(game, config);
  const nextMapIndex = (game.activeMap + 1) % length;
  const rlLive = game.rocketLeague?.live;
  const detailLabel = state.selectedGame === 'valorant' ? 'CURRENT ROUND SCORE' : state.selectedGame === 'rocketleague' ? 'CURRENT GAME GOALS' : state.selectedGame === 'smash' ? 'CURRENT STOCKS' : 'LIVE MAP SCORE';
  return `
    <section class="view-stack">
      <div class="section-heading"><div><span class="section-number">01</span><div><h2>Live scoreboard</h2><p>Primary match data</p></div></div>
        <button class="live-button ${game.match.live ? 'active' : ''}" data-action="toggle-live"><span></span>${game.match.live ? 'Take off air' : 'Take live'}</button>
      </div>
      <div class="scoreboard-stage">
        <div class="stage-grid"></div>
        <div class="scoreboard-preview">
          <div class="preview-meta"><span>${escapeHtml(game.match.event)}</span><strong>${escapeHtml(game.match.round)}</strong><span>${escapeHtml(game.match.format)}</span></div>
          <div class="preview-teams">
            ${renderPreviewTeam(game.teams[0], 'left')}
            <div class="preview-center"><small>${escapeHtml(config.scoreLabel)}</small><b>${game.teams[0].score}<i>&mdash;</i>${game.teams[1].score}</b><span>${game.match.live ? 'LIVE' : 'PREVIEW'}</span></div>
            ${renderPreviewTeam(game.teams[1], 'right')}
          </div>
          <div class="preview-map"><span>${state.selectedGame === 'rocketleague' ? 'GAME' : 'MAP'} ${game.activeMap + 1}</span><strong>${escapeHtml(state.selectedGame === 'rocketleague' && rlLive?.arena ? rocketLeagueArenaName(rlLive.arena) : activeMap.map)}</strong><i></i><em>${escapeHtml(state.selectedGame === 'rocketleague' && rlLive ? formatGameClock(rlLive.timeSeconds, rlLive.overtime) : activeMap.mode)}</em></div>
        </div>
        <div class="preview-label"><span></span>CONTROL PREVIEW &middot; OVERLAY LAYOUT TO FOLLOW</div>
      </div>
      <div class="control-grid">
        ${renderTeamControl(game.teams[0], 0, config, game)}
        <div class="middle-controls">
          <button class="swap-button" data-action="swap-teams" title="Swap team sides">
            <svg viewBox="0 0 24 24"><path d="m7 7-4 4 4 4M3 11h14M17 17l4-4-4-4M21 13H7"/></svg>SWAP SIDES
          </button>
          <button class="reset-button" data-action="reset-scores">RESET SCORES</button>
          <button class="next-match-button" data-action="next-match"><span>NEXT MATCH</span><small>TO ${state.selectedGame === 'rocketleague' || state.selectedGame === 'smash' ? 'GAME' : 'MAP'} ${nextMapIndex + 1}</small></button>
        </div>
        ${renderTeamControl(game.teams[1], 1, config, game)}
      </div>
      ${state.selectedGame === 'rocketleague' ? renderRocketLeaguePanel(game) : ''}
      ${state.selectedGame === 'valorant' ? renderValorantOcrPanel(game) : ''}
      <div class="lower-grid">
        <article class="panel match-details">
          <div class="panel-title"><span class="section-number">02</span><div><h2>Match details</h2><p>Information shared across graphics</p></div></div>
          <div class="field-grid">
            ${field('Event / league', 'match.event', game.match.event)}
            ${field('Round / stage', 'match.round', game.match.round)}
            ${state.selectedGame === 'rocketleague' && config.formatOptions ? formatSelect(config, game, 'field format-select') : field('Series format', 'match.format', game.match.format)}
            <label class="field"><span>Active map</span><select data-field="activeMap">
              ${visibleMapRows(game, config).map((row, index) => `<option value="${index}" ${index === game.activeMap ? 'selected' : ''}>${index + 1} &mdash; ${escapeHtml(row.map || 'TBD')}</option>`).join('')}
            </select></label>
          </div>
        </article>
        <article class="panel quick-score">
          <div class="panel-title compact"><div><h2>${detailLabel}</h2><p>Optional in-game value</p></div></div>
          <div class="detail-score-row">
            ${game.teams.map((team, index) => `<div><span>${escapeHtml(team.shortName)}</span><button data-action="detail-minus" data-index="${index}">&minus;</button><b>${team.detailScore}</b><button data-action="detail-plus" data-index="${index}">+</button></div>`).join('')}
          </div>
        </article>
      </div>
    </section>`;
}

function formatGameClock(seconds, overtime = false) {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = String(safeSeconds % 60).padStart(2, '0');
  return overtime ? `OT +${minutes}:${remainder}` : `${minutes}:${remainder}`;
}

function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = String(safeSeconds % 60).padStart(2, '0');
  return `${minutes}:${remainder}`;
}

function valorantOcrFieldLabel(fieldId) {
  return { homeScore: 'HOME SCORE', timer: 'ROUND TIMER', awayScore: 'AWAY SCORE' }[fieldId] || fieldId;
}

function valorantOcrFieldColor(fieldId) {
  return { homeScore: '#2d8cff', timer: '#f5d24a', awayScore: '#ff4655' }[fieldId] || '#ff4655';
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function setValorantRoiInputs(fieldId, roi) {
  const next = {
    x: clampNumber(Math.round(roi.x), 0, 1919),
    y: clampNumber(Math.round(roi.y), 0, 1079),
    w: clampNumber(Math.round(roi.w), 1, 1920),
    h: clampNumber(Math.round(roi.h), 1, 1080)
  };
  next.w = Math.min(next.w, 1920 - next.x);
  next.h = Math.min(next.h, 1080 - next.y);
  for (const axis of ['x', 'y', 'w', 'h']) {
    root.querySelectorAll(`[data-vo-roi="${fieldId}"][data-vo-axis="${axis}"]`).forEach((input) => {
      input.value = next[axis];
    });
  }
  return next;
}

function valorantRoiFromInputs(fieldId) {
  const profile = getValorantOcrProfile(state.games.valorant.valorantOcr.profileId, state.games.valorant.valorantOcr.roiOverrides).fields[fieldId].roi;
  return Object.fromEntries(['x', 'y', 'w', 'h'].map((axis) => {
    const input = root.querySelector(`[data-vo-roi="${fieldId}"][data-vo-axis="${axis}"]`);
    return [axis, Number(input?.value ?? profile[axis]) || profile[axis]];
  }));
}

function positionValorantRoiBox(fieldId) {
  const roi = setValorantRoiInputs(fieldId, valorantRoiFromInputs(fieldId));
  root.querySelectorAll(`[data-vo-roi-box="${fieldId}"]`).forEach((box) => {
    box.style.left = `${roi.x / 19.2}%`;
    box.style.top = `${roi.y / 10.8}%`;
    box.style.width = `${roi.w / 19.2}%`;
    box.style.height = `${roi.h / 10.8}%`;
  });
}

function valorantSourcePoint(event) {
  const frame = event.target?.closest?.('.vo-frame') || root.querySelector('.vo-frame');
  const img = frame?.querySelector('img');
  const rect = (img || frame).getBoundingClientRect();
  return {
    x: clampNumber(((event.clientX - rect.left) / rect.width) * 1920, 0, 1920),
    y: clampNumber(((event.clientY - rect.top) / rect.height) * 1080, 0, 1080)
  };
}

async function saveValorantRoiFromInputs(fieldId) {
  const roi = setValorantRoiInputs(fieldId, valorantRoiFromInputs(fieldId));
  commit(() => {
    const ocr = state.games.valorant.valorantOcr;
    ocr.roiOverrides ||= {};
    const base = getValorantOcrProfile(ocr.profileId).fields[fieldId].roi;
    ocr.roiOverrides[fieldId] = { ...base, ...roi };
  }, 'OCR region updated');
  await syncValorantOcr();
}

function applyValorantRoiFromInputs(fieldId) {
  const roi = setValorantRoiInputs(fieldId, valorantRoiFromInputs(fieldId));
  const ocr = state.games.valorant.valorantOcr;
  ocr.roiOverrides ||= {};
  const base = getValorantOcrProfile(ocr.profileId).fields[fieldId].roi;
  ocr.roiOverrides[fieldId] = { ...base, ...roi };
}

function currentValorantOcrProfile() {
  const ocr = state.games.valorant.valorantOcr;
  return getValorantOcrProfile(ocr.profileId, {
    ...(ocr.roiOverrides || {}),
    scoreboardTable: ocr.scoreboardTableOverrides || {}
  });
}

function observerGuideColumns() {
  return [
    { id: 'playerName', label: 'NAME', className: 'name', columns: ['playerName'] },
    { id: 'ultimate', label: 'ULT', className: 'ult', columns: ['ultimate'] },
    { id: 'kda', label: 'K/D/A', className: 'kda', columns: ['kills', 'deaths', 'assists'] },
    { id: 'loadoutIcon', label: 'LOADOUT', className: 'loadout', columns: ['loadoutIcon'] },
    { id: 'credits', label: 'CREDS', className: 'credits', columns: ['credits'] }
  ];
}

function valorantDebugRoiMarkup({ force = false } = {}) {
  const ocr = state.games.valorant.valorantOcr;
  if (!force && !ocr.debugRois) return '';
  const profile = currentValorantOcrProfile();
  const roiFields = VALORANT_OCR_FIELD_IDS.map((fieldId) => ({
    id: fieldId,
    ...profile.fields[fieldId],
    roi: { ...profile.fields[fieldId].roi, ...(ocr.roiOverrides?.[fieldId] || {}) }
  }));
  const observer3 = ocr.live?.observer3 || {};
  const activeObserverCell = observer3.activeCell || {};
  const observerFieldGuides = (() => {
    const table = profile.scoreboardTable;
    const guideColumns = observerGuideColumns();
    if (!table?.teams?.length || !table?.columns) return [];
    return table.teams.flatMap((team) => Array.from({ length: Number(team.rows) || 0 }, (_item, row) => guideColumns
      .map((guide) => {
        const roi = observerFieldRoi(profile, team.id, row, guide.id);
        if (!roi) return null;
        return {
          ...guide,
          side: team.id,
          row,
          ...roi
        };
      })
      .filter(Boolean))).flat();
  })();
  const timelineRounds = Array.from({ length: 24 }, (_item, index) => ({
    round: index + 1,
    ...(observer3.roundTimeline?.rounds?.[index] || {})
  }));
  return `${roiFields.map((field) => `<i class="vo-roi-box" data-vo-roi-box="${field.id}" style="--roi-color:${valorantOcrFieldColor(field.id)};left:${field.roi.x / 19.2}%;top:${field.roi.y / 10.8}%;width:${field.roi.w / 19.2}%;height:${field.roi.h / 10.8}%"><span>${valorantOcrFieldLabel(field.id)}</span><b data-vo-roi-resize="true"></b></i>`).join('')}${observerFieldGuides.map((guide) => {
    const guideColumns = guide.id === 'kda' ? ['kills', 'deaths', 'assists'] : [guide.id];
    const isScanning = activeObserverCell.side === guide.side && Number(activeObserverCell.row) === Number(guide.row) && guideColumns.includes(activeObserverCell.columnId);
    return `<i class="vo-scoreboard-field-box ${escapeHtml(guide.side)} ${escapeHtml(guide.className)} ${isScanning ? 'scanning' : ''}" data-vo-observer-box="${escapeHtml(`${guide.side}:${guide.row}:${guide.id}`)}" style="left:${guide.x / 19.2}%;top:${guide.y / 10.8}%;width:${guide.w / 19.2}%;height:${guide.h / 10.8}%"><span>${escapeHtml(guide.label)}</span><b data-vo-observer-resize="true"></b></i>`;
  }).join('')}${timelineRounds.map((round) => {
    const roi = observerTimelineRoi(profile, round.round);
    if (!roi) return '';
    const isScanning = activeObserverCell.side === 'timeline' && Number(activeObserverCell.row) === round.round - 1;
    return `<i class="vo-timeline-round-box ${isScanning ? 'scanning' : ''}" data-vo-timeline-box="${round.round}" style="left:${roi.x / 19.2}%;top:${roi.y / 10.8}%;width:${roi.w / 19.2}%;height:${roi.h / 10.8}%"><span>R${round.round}</span><b data-vo-timeline-resize="true"></b></i>`;
  }).join('')}`;
}

function renderValorantDebugFullscreen() {
  if (!valorantOcrSnapshot?.frameDataUrl) return '';
  const ageSeconds = Math.max(0, Math.round((Date.now() - Number(valorantOcrSnapshot.capturedAt || Date.now())) / 1000));
  return `
    <div class="vo-debug-fullscreen editor" role="dialog" aria-modal="true" aria-label="Full screen VALORANT debug capture editor">
      <header>
        <div><span>VALORANT DEBUG CAPTURE</span><strong>Full-screen box editor</strong><small>${ageSeconds}s old &middot; 1920 &times; 1080 source frame &middot; ${escapeHtml(valorantOcrSnapshot.backend || 'unknown engine')}</small></div>
        <div>
          <button class="secondary-button" data-action="save-valorant-rois">SAVE BOXES</button>
          <button class="secondary-button" data-action="close-valorant-debug-fullscreen">CLOSE</button>
        </div>
      </header>
      <div class="vo-frame"><img src="${escapeHtml(valorantOcrSnapshot.frameDataUrl)}" alt="Full screen captured VALORANT debug frame">${valorantDebugRoiMarkup({ force: true })}</div>
    </div>`;
}

function observerGuideIdForColumn(columnId) {
  if (['kills', 'deaths', 'assists'].includes(columnId)) return 'kda';
  if (columnId === 'loadoutIcon') return 'loadoutIcon';
  return columnId;
}

function valorantTimelineMethodLabel(method) {
  return ({
    elimination: 'ELIM',
    'spike-detonation': 'BOOM',
    'spike-defuse': 'DEF',
    unknown: 'UNK'
  })[method] || '--';
}

function observerGuideBounds(table, guide) {
  const columns = (guide.columns || [guide.id]).map((id) => table.columns?.[id]).filter(Boolean);
  if (!columns.length) return null;
  const minX = Math.min(...columns.map((column) => Number(column.x) || 0));
  const maxX = Math.max(...columns.map((column) => (Number(column.x) || 0) + (Number(column.w) || 0)));
  return { x: minX, w: maxX - minX };
}

function observerFieldRoi(profile, side, row, guideId) {
  const table = profile.scoreboardTable;
  const saved = table?.cells?.[side]?.[row]?.[guideId];
  if (saved) {
    return {
      x: clampNumber(Math.round(Number(saved.x) || 0), 0, 1919),
      y: clampNumber(Math.round(Number(saved.y) || 0), 0, 1079),
      w: clampNumber(Math.round(Number(saved.w) || 1), 1, 1920),
      h: clampNumber(Math.round(Number(saved.h) || 12), 12, 1080)
    };
  }
  const guide = observerGuideColumns().find((item) => item.id === guideId);
  const team = table?.teams?.find((item) => item.id === side);
  const bounds = table && guide ? observerGuideBounds(table, guide) : null;
  if (!team || !bounds) return null;
  return {
    x: (Number(team.origin?.x) || 0) + bounds.x,
    y: (Number(team.origin?.y) || 0) + row * (Number(team.rowHeight) || 40),
    w: bounds.w,
    h: Math.max(12, (Number(team.rowHeight) || 40) - 4)
  };
}

function observerTimelineRoi(profile, round) {
  const roi = profile.scoreboardTable?.roundTimeline?.rounds?.[String(round)];
  if (!roi) return null;
  return {
    x: clampNumber(Math.round(Number(roi.x) || 0), 0, 1919),
    y: clampNumber(Math.round(Number(roi.y) || 0), 0, 1079),
    w: clampNumber(Math.round(Number(roi.w) || 1), 1, 1920),
    h: clampNumber(Math.round(Number(roi.h) || 12), 12, 1080)
  };
}

function observerRowRoi(profile, side, row) {
  const table = profile.scoreboardTable;
  const team = table?.teams?.find((item) => item.id === side);
  const columns = Object.values(table?.columns || {});
  if (!team || !columns.length) return null;
  const minX = Math.min(...columns.map((column) => Number(column.x) || 0));
  const maxX = Math.max(...columns.map((column) => (Number(column.x) || 0) + (Number(column.w) || 0)));
  return {
    x: (Number(team.origin?.x) || 0) + minX,
    y: (Number(team.origin?.y) || 0) + row * (Number(team.rowHeight) || 40),
    w: maxX - minX,
    h: Math.max(12, (Number(team.rowHeight) || 40) - 4)
  };
}

function positionValorantObserverBox(side, row, guideId) {
  const box = root.querySelector(`[data-vo-observer-box="${side}:${row}:${guideId}"]`);
  if (!box) return;
  const roi = observerFieldRoi(currentValorantOcrProfile(), side, row, guideId);
  if (!roi) return;
  box.style.left = `${roi.x / 19.2}%`;
  box.style.top = `${roi.y / 10.8}%`;
  box.style.width = `${roi.w / 19.2}%`;
  box.style.height = `${roi.h / 10.8}%`;
}

function applyObserverFieldDragToOverrides(drag, roi) {
  const ocr = state.games.valorant.valorantOcr;
  ocr.scoreboardTableOverrides ||= {};
  ocr.scoreboardTableOverrides.cells ||= {};
  ocr.scoreboardTableOverrides.cells[drag.side] ||= {};
  ocr.scoreboardTableOverrides.cells[drag.side][drag.row] ||= {};
  ocr.scoreboardTableOverrides.cells[drag.side][drag.row][drag.guideId] = {
    x: clampNumber(Math.round(roi.x), 0, 1919),
    y: clampNumber(Math.round(roi.y), 0, 1079),
    w: clampNumber(Math.round(roi.w), 1, 1920 - Math.max(0, Math.round(roi.x))),
    h: clampNumber(Math.round(roi.h), 12, 1080 - Math.max(0, Math.round(roi.y)))
  };
}

function observerRoiFromElement(box) {
  const frame = box.closest('.vo-frame');
  if (!frame) return null;
  return {
    x: clampNumber(Math.round((parseFloat(box.style.left) || 0) * 19.2), 0, 1919),
    y: clampNumber(Math.round((parseFloat(box.style.top) || 0) * 10.8), 0, 1079),
    w: clampNumber(Math.round((parseFloat(box.style.width) || 0) * 19.2), 1, 1920),
    h: clampNumber(Math.round((parseFloat(box.style.height) || 0) * 10.8), 12, 1080)
  };
}

function observerTimelineRoiFromElement(box) {
  const frame = box.closest('.vo-frame');
  if (!frame) return null;
  return {
    x: clampNumber(Math.round((parseFloat(box.style.left) || 0) * 19.2), 0, 1919),
    y: clampNumber(Math.round((parseFloat(box.style.top) || 0) * 10.8), 0, 1079),
    w: clampNumber(Math.round((parseFloat(box.style.width) || 0) * 19.2), 1, 1920),
    h: clampNumber(Math.round((parseFloat(box.style.height) || 0) * 10.8), 12, 1080)
  };
}

function collectObserverRoisFromDebugFrame() {
  const boxes = [...root.querySelectorAll('[data-vo-observer-box]')];
  const timelineBoxes = [...root.querySelectorAll('[data-vo-timeline-box]')];
  if (!boxes.length && !timelineBoxes.length) return null;
  const cells = {};
  for (const box of boxes) {
    const [side, rowValue, guideId] = box.dataset.voObserverBox.split(':');
    const row = Number(rowValue) || 0;
    const roi = observerRoiFromElement(box);
    if (!side || !guideId || !roi) continue;
    cells[side] ||= {};
    cells[side][row] ||= {};
    cells[side][row][guideId] = roi;
  }
  const roundTimeline = { rounds: {} };
  for (const box of timelineBoxes) {
    const round = Number(box.dataset.voTimelineBox) || 0;
    const roi = observerTimelineRoiFromElement(box);
    if (!round || !roi) continue;
    roundTimeline.rounds[String(round)] = roi;
  }
  return {
    ...(Object.keys(cells).length ? { cells } : {}),
    ...(Object.keys(roundTimeline.rounds).length ? { roundTimeline } : {})
  };
}

async function saveAllValorantRoisFromInputs() {
  const nextRois = Object.fromEntries(VALORANT_OCR_FIELD_IDS.map((fieldId) => [
    fieldId,
    setValorantRoiInputs(fieldId, valorantRoiFromInputs(fieldId))
  ]));
  const observerOverrides = collectObserverRoisFromDebugFrame();
  commit(() => {
    const ocr = state.games.valorant.valorantOcr;
    const profile = getValorantOcrProfile(ocr.profileId);
    ocr.roiOverrides = Object.fromEntries(VALORANT_OCR_FIELD_IDS.map((fieldId) => [
      fieldId,
      { ...profile.fields[fieldId].roi, ...nextRois[fieldId] }
    ]));
    if (observerOverrides) {
      ocr.scoreboardTableOverrides = {
        ...(ocr.scoreboardTableOverrides || {}),
        ...observerOverrides
      };
    }
  }, 'OCR boxes saved');
  await syncValorantOcr();
}

function beginValorantRoiDrag(event) {
  if (valorantRoiDrag && event.type !== 'mousedown') return;
  const timelineBox = event.target.closest('[data-vo-timeline-box]');
  if (timelineBox && root.contains(timelineBox)) {
    event.preventDefault();
    const round = Number(timelineBox.dataset.voTimelineBox) || 0;
    const roi = observerTimelineRoi(currentValorantOcrProfile(), round);
    if (!round || !roi) return;
    valorantRoiDrag = {
      type: 'timeline-round',
      round,
      pointerId: event.pointerId ?? 'mouse',
      mode: event.target.closest('[data-vo-timeline-resize]') ? 'resize' : 'move',
      start: valorantSourcePoint(event),
      roi,
      currentRoi: roi,
      node: timelineBox
    };
    timelineBox.classList.add('active');
    timelineBox.setPointerCapture?.(event.pointerId);
    return;
  }
  const observerBox = event.target.closest('[data-vo-observer-box]');
  if (observerBox && root.contains(observerBox)) {
    event.preventDefault();
    const [side, rowValue, guideId] = observerBox.dataset.voObserverBox.split(':');
    const row = Number(rowValue) || 0;
    const profile = currentValorantOcrProfile();
    const roi = observerFieldRoi(profile, side, row, guideId);
    if (!roi) return;
    valorantRoiDrag = {
      type: 'observer-field',
      side,
      row,
      guideId,
      pointerId: event.pointerId ?? 'mouse',
      mode: event.target.closest('[data-vo-observer-resize]') ? 'resize' : 'move',
      start: valorantSourcePoint(event),
      roi,
      currentRoi: roi,
      node: observerBox
    };
    observerBox.classList.add('active');
    observerBox.setPointerCapture?.(event.pointerId);
    return;
  }
  const box = event.target.closest('[data-vo-roi-box]');
  if (!box || !root.contains(box)) return;
  event.preventDefault();
  const fieldId = box.dataset.voRoiBox;
  valorantRoiDrag = {
    type: 'field',
    fieldId,
    pointerId: event.pointerId ?? 'mouse',
    mode: event.target.closest('[data-vo-roi-resize]') ? 'resize' : 'move',
    start: valorantSourcePoint(event),
    roi: setValorantRoiInputs(fieldId, valorantRoiFromInputs(fieldId))
  };
  box.classList.add('active');
  box.setPointerCapture?.(event.pointerId);
}

function moveValorantRoiDrag(event) {
  if (!valorantRoiDrag) return;
  if (event.buttons === 0) {
    endValorantRoiDrag(event);
    return;
  }
  if (!['observer-field', 'timeline-round'].includes(valorantRoiDrag.type) && event.pointerId !== undefined && event.pointerId !== valorantRoiDrag.pointerId) return;
  const point = valorantSourcePoint(event);
  const dx = point.x - valorantRoiDrag.start.x;
  const dy = point.y - valorantRoiDrag.start.y;
  const roi = { ...valorantRoiDrag.roi };
  if (valorantRoiDrag.mode === 'resize') {
    roi.w += dx;
    roi.h += dy;
  } else {
    roi.x += dx;
    roi.y += dy;
  }
  if (['observer-field', 'timeline-round'].includes(valorantRoiDrag.type)) {
    roi.x = clampNumber(Math.round(roi.x), 0, 1919);
    roi.y = clampNumber(Math.round(roi.y), 0, 1079);
    roi.w = clampNumber(Math.round(roi.w), 1, 1920 - roi.x);
    roi.h = clampNumber(Math.round(roi.h), 12, 1080 - roi.y);
    valorantRoiDrag.currentRoi = roi;
    if (valorantRoiDrag.node) {
      valorantRoiDrag.node.style.left = `${roi.x / 19.2}%`;
      valorantRoiDrag.node.style.top = `${roi.y / 10.8}%`;
      valorantRoiDrag.node.style.width = `${roi.w / 19.2}%`;
      valorantRoiDrag.node.style.height = `${roi.h / 10.8}%`;
    }
    event.preventDefault();
    return;
  }
  setValorantRoiInputs(valorantRoiDrag.fieldId, roi);
  positionValorantRoiBox(valorantRoiDrag.fieldId);
  event.preventDefault();
}

async function endValorantRoiDrag(event) {
  if (!valorantRoiDrag) return;
  event?.preventDefault?.();
  if (valorantRoiDrag.type === 'timeline-round') {
    const { round, currentRoi } = valorantRoiDrag;
    const roi = currentRoi || valorantRoiDrag.roi;
    const ocr = state.games.valorant.valorantOcr;
    ocr.scoreboardTableOverrides ||= {};
    ocr.scoreboardTableOverrides.roundTimeline ||= {};
    ocr.scoreboardTableOverrides.roundTimeline.rounds ||= {};
    ocr.scoreboardTableOverrides.roundTimeline.rounds[String(round)] = {
      x: clampNumber(Math.round(roi.x), 0, 1919),
      y: clampNumber(Math.round(roi.y), 0, 1079),
      w: clampNumber(Math.round(roi.w), 1, 1920 - Math.max(0, Math.round(roi.x))),
      h: clampNumber(Math.round(roi.h), 12, 1080 - Math.max(0, Math.round(roi.y)))
    };
    valorantRoiDrag = null;
    root.querySelector(`[data-vo-timeline-box="${round}"]`)?.classList.remove('active');
    updateSaveStatus(`Round ${round} box adjusted - click SAVE BOXES to keep`);
    return;
  }
  if (valorantRoiDrag.type === 'observer-field') {
    const { side, row, guideId, currentRoi } = valorantRoiDrag;
    applyObserverFieldDragToOverrides(valorantRoiDrag, currentRoi || valorantRoiDrag.roi);
    valorantRoiDrag = null;
    root.querySelector(`[data-vo-observer-box="${side}:${row}:${guideId}"]`)?.classList.remove('active');
    updateSaveStatus('Observer 3 field adjusted - click SAVE BOXES to keep');
    return;
  }
  const fieldId = valorantRoiDrag.fieldId;
  valorantRoiDrag = null;
  root.querySelector(`[data-vo-roi-box="${fieldId}"]`)?.classList.remove('active');
  applyValorantRoiFromInputs(fieldId);
  updateSaveStatus('OCR region adjusted - click SAVE BOXES to keep');
}

function renderValorantOcrPanel(game) {
  const ocr = game.valorantOcr;
  const live = ocr.live || {};
  const fields = live.fields || {};
  const profile = currentValorantOcrProfile();
  const roiFields = VALORANT_OCR_FIELD_IDS.map((fieldId) => ({
    id: fieldId,
    ...profile.fields[fieldId],
    roi: { ...profile.fields[fieldId].roi, ...(ocr.roiOverrides?.[fieldId] || {}) }
  }));
  const observerFieldGuides = (() => {
    const table = profile.scoreboardTable;
    const guideColumns = observerGuideColumns();
    if (!table?.teams?.length || !table?.columns) return [];
    return table.teams.flatMap((team) => Array.from({ length: Number(team.rows) || 0 }, (_item, row) => guideColumns
      .map((guide) => {
        const roi = observerFieldRoi(profile, team.id, row, guide.id);
        if (!roi) return null;
        return {
          ...guide,
          side: team.id,
          row,
          ...roi
        };
      })
      .filter(Boolean))).flat();
  })();
  const status = live.status || 'disabled';
  const simulatorRunning = status === 'simulating';
  const snapshot = valorantOcrSnapshot;
  const sourceFields = ocr.source === 'remote' ? `
    <label class="field"><span>RECEIVER PORT</span><input type="number" min="1" max="65535" data-vo-prop="bridgePort" value="${Number(ocr.bridgePort) || 3175}"><small>Universal bridge listener</small></label>
    <label class="field bridge-key-field"><span>BRIDGE KEY</span><input data-vo-prop="bridgeToken" value="${escapeHtml(ocr.bridgeToken || '')}" placeholder="Generate a private key"><button data-action="generate-valorant-bridge-key">GENERATE</button><small>Graphics PC: ${escapeHtml(networkAddresses.join(' / ') || 'address unavailable')}</small></label>` : `
    <label class="field"><span>WINDOW TITLE CONTAINS</span><input data-vo-prop="windowName" list="valorant-window-list" value="${escapeHtml(ocr.windowName)}"><datalist id="valorant-window-list">${valorantWindowChoices.map((window) => `<option value="${escapeHtml(window.name)}"></option>`).join('')}</datalist></label>
    <label class="field"><span>CAPTURE ENGINE</span><select data-vo-prop="captureBackend"><option value="auto" ${ocr.captureBackend === 'auto' || !ocr.captureBackend ? 'selected' : ''}>Automatic (native preferred)</option><option value="native" ${ocr.captureBackend === 'native' ? 'selected' : ''}>Windows Graphics Capture</option><option value="electron" ${ocr.captureBackend === 'electron' ? 'selected' : ''}>Electron fallback</option></select></label>
    <label class="field"><span>ROI PROFILE</span><select data-vo-prop="profileId">${VALORANT_OCR_PROFILE_CHOICES.map((choice) => `<option value="${escapeHtml(choice.id)}" ${choice.id === ocr.profileId ? 'selected' : ''}>${escapeHtml(choice.label)}</option>`).join('')}</select></label>
    <label class="field"><span>CAPTURE RATE</span><input type="number" min="1" max="15" data-vo-prop="captureFps" value="${Number(ocr.captureFps) || 8}"><small>1&ndash;15 frames/sec; each field has its own OCR cadence</small></label>
    <label class="field vo-range-field"><span>OBSERVER SCAN INTERVAL</span><input type="range" min="5" max="100" step="1" data-vo-prop="observerScanIntervalMs" value="${Math.max(5, Math.min(100, Number(ocr.observerScanIntervalMs) || 25))}"><small><b>${Math.max(5, Math.min(100, Number(ocr.observerScanIntervalMs) || 25))} ms</b> between scoreboard cells</small></label>
    <label class="rl-enable-toggle"><input type="checkbox" data-vo-prop="recordedVideoMode" ${ocr.recordedVideoMode ? 'checked' : ''}><i></i><span><b>RECORDED VIDEO MODE</b><small>Enable for YouTube/replay tests; leave off for live VALORANT</small></span></label>`;
  const observer3 = live.observer3 || {};
  const profileHasObserverTable = Boolean(profile.scoreboardTable);
  const timelineRounds = Array.from({ length: 24 }, (_item, index) => ({
    round: index + 1,
    ...(observer3.roundTimeline?.rounds?.[index] || {})
  }));
  const observerRows = ['home', 'away'].flatMap((side) => Array.from({ length: 5 }, (_item, index) => ({
    side,
    index,
    ...(observer3.teams?.[side]?.players?.[index] || {})
  })));
  const activeObserverCell = observer3.activeCell || {};
  const activeObserverLabel = activeObserverCell.side
    ? `SCANNING ${escapeHtml(String(activeObserverCell.side).toUpperCase())} ${Number(activeObserverCell.row ?? 0) + 1} ${escapeHtml(String(activeObserverCell.columnId || '').toUpperCase())}`
    : 'SCANNING SCOREBOARD TABLE';
  const observerCellClass = (side, index, columnId) => (
    activeObserverCell.side === side
      && Number(activeObserverCell.row) === Number(index)
      && activeObserverCell.columnId === columnId
      ? ' class="scanning"'
      : ''
  );
  const observerNameClass = (player) => {
    const classes = [];
    if (player.nameLocked) classes.push('locked');
    if (activeObserverCell.side === player.side
      && Number(activeObserverCell.row) === Number(player.index)
      && activeObserverCell.columnId === 'playerName') classes.push('scanning');
    return classes.length ? ` class="${classes.join(' ')}"` : '';
  };
  const observerLoadoutText = (loadout = {}) => {
    if (loadout.weapon) return loadout.weapon;
    if (loadout.status === 'weak' && loadout.match) return `? ${loadout.match}`;
    if (loadout.reason && loadout.reason.includes('templates')) return 'NO TPL';
    return '--';
  };
  const observerLoadoutTitle = (loadout = {}) => {
    if (!loadout.weapon && !loadout.match && !loadout.reason) return '';
    const parts = [];
    if (loadout.weapon || loadout.match) parts.push(loadout.weapon || `Weak: ${loadout.match}`);
    if (loadout.confidence !== undefined) parts.push(`${Math.round((Number(loadout.confidence) || 0) * 100)}%`);
    if (loadout.score !== undefined) parts.push(`score ${Number(loadout.score || 0).toFixed(2)}`);
    if (loadout.second) parts.push(`2nd ${loadout.second}`);
    if (loadout.variant) parts.push(loadout.variant);
    if (loadout.reason) parts.push(loadout.reason);
    return parts.join(' | ');
  };
  const observerTable = profileHasObserverTable ? `
      <div class="vo-observer-table">
        <div class="vo-observer-title"><span>OBSERVER 3 DATA SCREEN</span><strong data-vo-observer-active-label>${observer3.enabled ? activeObserverLabel : 'WAITING FOR SCOREBOARD PROFILE'}</strong></div>
        <table>
          <thead><tr><th>Side</th><th>Player</th><th>Name Conf</th><th>Ult</th><th>K</th><th>D</th><th>A</th><th>Loadout</th><th>Credits</th><th>Conf</th></tr></thead>
          <tbody>${observerRows.map((player) => `<tr>
            <td>${escapeHtml(String(player.side || '').toUpperCase())} ${Number(player.index ?? 0) + 1}</td>
            <td data-vo-observer-cell="${escapeHtml(`${player.side}:${player.index}:playerName`)}"${observerNameClass(player).replace(' class=', ' class=')}><input class="vo-name-override" data-vo-manual-name data-side="${escapeHtml(player.side)}" data-row="${Number(player.index ?? 0)}" value="${escapeHtml(player.name || '')}" placeholder="--" title="Edit name and press Enter to manually lock"></td>
            <td class="${player.nameLocked ? 'locked' : ''}">${player.nameConfidence ? `${Math.round(Number(player.nameConfidence) * 100)}%` : '--'}</td>
            <td data-vo-observer-cell="${escapeHtml(`${player.side}:${player.index}:ultimate`)}"${observerCellClass(player.side, player.index, 'ultimate')}>${escapeHtml(player.ultimate || '--')}</td>
            <td data-vo-observer-cell="${escapeHtml(`${player.side}:${player.index}:kills`)}"${observerCellClass(player.side, player.index, 'kills')}>${player.kda?.kills ?? '--'}</td>
            <td data-vo-observer-cell="${escapeHtml(`${player.side}:${player.index}:deaths`)}"${observerCellClass(player.side, player.index, 'deaths')}>${player.kda?.deaths ?? '--'}</td>
            <td data-vo-observer-cell="${escapeHtml(`${player.side}:${player.index}:assists`)}"${observerCellClass(player.side, player.index, 'assists')}>${player.kda?.assists ?? '--'}</td>
            <td data-vo-observer-cell="${escapeHtml(`${player.side}:${player.index}:loadoutIcon`)}"${observerCellClass(player.side, player.index, 'loadoutIcon')}${observerLoadoutTitle(player.loadout) ? ` title="${escapeHtml(observerLoadoutTitle(player.loadout))}"` : ''}>${escapeHtml(observerLoadoutText(player.loadout))}</td>
            <td data-vo-observer-cell="${escapeHtml(`${player.side}:${player.index}:credits`)}"${observerCellClass(player.side, player.index, 'credits')}>${player.credits === null || player.credits === undefined ? '--' : escapeHtml(Number(player.credits).toLocaleString())}</td>
            <td>${Math.round((Number(player.confidence) || 0) * 100)}%</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>` : '';
  const timelineTable = profile.scoreboardTable?.roundTimeline ? `
      <div class="vo-observer-table vo-timeline-table">
        <div class="vo-observer-title"><span>ROUND TIMELINE</span><strong>${observer3.roundTimeline?.currentRound ? `ROUND ${Number(observer3.roundTimeline.currentRound)}` : 'WAITING FOR ROUND MARKER'}</strong></div>
        <table>
          <thead><tr>${timelineRounds.map((round) => `<th>${round.round}</th>`).join('')}</tr></thead>
          <tbody>
            <tr>${timelineRounds.map((round) => `<td data-vo-observer-cell="${escapeHtml(`timeline:${round.round - 1}:roundTimeline`)}" class="${round.current ? 'current' : ''} ${round.winnerRow ? round.winnerRow : ''}">${escapeHtml(round.winnerRole ? String(round.winnerRole).toUpperCase().slice(0, 3) : round.current ? 'LIVE' : '--')}</td>`).join('')}</tr>
            <tr>${timelineRounds.map((round) => `<td title="${escapeHtml(round.method || '')}">${escapeHtml(valorantTimelineMethodLabel(round.method))}</td>`).join('')}</tr>
          </tbody>
        </table>
      </div>` : '';
  const debugRoiMarkup = valorantDebugRoiMarkup();
  const observerCropColumns = observerGuideColumns();
  const observerCropRows = snapshot?.observerCrops?.length
    ? ['home', 'away'].flatMap((side) => Array.from({ length: 5 }, (_item, row) => ({
      side,
      row,
      crops: Object.fromEntries((snapshot.observerCrops || [])
        .filter((crop) => crop.side === side && Number(crop.row) === row)
        .map((crop) => [crop.id, crop]))
    })))
    : [];
  const observerCropMarkup = observerCropRows.length ? `
        <section class="vo-observer-crops">
          <header><span>OBSERVER 3 FIELD PREVIEWS</span><strong>Saved boxes after processing</strong></header>
          <div class="vo-observer-crop-grid">
            <b>ROW</b>${observerCropColumns.map((column) => `<b>${escapeHtml(column.label)}</b>`).join('')}
            ${observerCropRows.map((row) => `<span>${escapeHtml(row.side.toUpperCase())} ${row.row + 1}</span>${observerCropColumns.map((column) => {
              const crop = row.crops[column.id];
              return crop ? `<img src="${escapeHtml(crop.processedDataUrl)}" alt="${escapeHtml(`${row.side} ${row.row + 1} ${column.label}`)} crop">` : '<em>Not captured</em>';
            }).join('')}`).join('')}
          </div>
        </section>` : '';
  const timelineCropMarkup = snapshot?.observerTimelineCrops?.length ? `
        <section class="vo-observer-crops vo-timeline-crops">
          <header><span>ROUND TIMELINE PREVIEWS</span><strong>Color/icon crops after processing</strong></header>
          <div class="vo-timeline-crop-grid">
            ${(snapshot.observerTimelineCrops || []).map((crop) => `<section><span>R${Number(crop.round) || '-'}</span><img src="${escapeHtml(crop.rawDataUrl)}" alt="${escapeHtml(`Round ${crop.round} timeline crop`)}"></section>`).join('')}
          </div>
        </section>` : '';
  return `
    <article class="panel valorant-ocr-panel ${snapshot ? 'has-debug-snapshot' : ''}">
      <header class="vo-heading">
        <div><span>VALORANT OCR EXPERIMENT</span><h2>OCR Lab</h2><p>Capture and normalized telemetry only &middot; overlays remain disconnected</p></div>
        <div class="vo-status ${escapeHtml(status)}"><i></i><span>${escapeHtml(status.replaceAll('-', ' ').toUpperCase())}</span><small>${escapeHtml(live.message || 'Waiting for service')}</small></div>
      </header>
      <div class="vo-settings-grid">
        <label class="rl-enable-toggle"><input type="checkbox" data-vo-prop="enabled" ${ocr.enabled ? 'checked' : ''}><i></i><span><b>OCR CAPTURE</b><small>${ocr.enabled ? 'Enabled for VALORANT' : 'Disabled'}</small></span></label>
        <label class="field"><span>DATA SOURCE</span><select data-vo-prop="source"><option value="local" ${ocr.source !== 'remote' ? 'selected' : ''}>This PC / direct</option><option value="remote" ${ocr.source === 'remote' ? 'selected' : ''}>Universal Game Bridge</option></select></label>
        ${sourceFields}
      </div>
      <div class="vo-toolbar ${ocr.source === 'remote' ? 'remote' : ''}">
        ${ocr.source === 'remote' ? '<span>Capture, ROI calibration, and test feed controls are available in the bridge app on the VALORANT PC.</span>' : `
        <button class="secondary-button" data-action="detect-valorant-window">FIND WINDOW</button>
        <button class="secondary-button" data-action="save-valorant-rois">SAVE BOXES</button>
        <button class="secondary-button" data-action="capture-valorant-frame">CAPTURE DEBUG FRAME</button>
        <button class="secondary-button" data-action="open-valorant-debug-fullscreen" ${valorantOcrSnapshot?.frameDataUrl ? '' : 'disabled'}>FULL SCREEN BOX EDITOR</button>
        <button class="secondary-button" data-action="clear-valorant-ocr">CLEAR LOCKS</button>
        <button class="secondary-button ${simulatorRunning ? 'danger' : ''}" data-action="${simulatorRunning ? 'stop-valorant-simulator' : 'start-valorant-simulator'}">${simulatorRunning ? 'STOP TEST FEED' : 'RUN TEST FEED'}</button>
        <label class="vo-debug-toggle"><input type="checkbox" data-vo-prop="debugRois" ${ocr.debugRois ? 'checked' : ''}><span>SHOW ROI BOXES</span></label>`}
      </div>
      <div class="vo-live-grid">
        ${VALORANT_OCR_FIELD_IDS.map((fieldId) => {
          const field = fields[fieldId] || {};
          const confidence = Math.round((Number(field.confidence) || 0) * 100);
          return `<section class="vo-reading ${field.stale ? 'stale' : ''}"><span>${valorantOcrFieldLabel(fieldId)}</span><strong>${escapeHtml(field.displayValue ?? '--')}</strong><div><b>${confidence}%</b><em>${field.stale ? 'STALE' : field.accepted ? 'ACCEPTED' : 'HELD'}</em></div><code>RAW ${escapeHtml(field.rawText || 'no OCR text')}</code><small>NORM ${escapeHtml(field.normalized || '--')} &middot; ${escapeHtml(field.reason || 'waiting')}</small></section>`;
        }).join('')}
      </div>
      <div class="vo-metrics">
        <span>CAPTURE <b>${Number(live.captureFps || 0).toFixed(1)} FPS</b></span>
        <span>ENGINE <b>${escapeHtml(live.capture?.backend || live.captureBackend || ocr.captureBackend || 'auto')}</b></span>
        <span>CAPTURE HEALTH <b>${live.capture?.consecutiveFailures || live.consecutiveCaptureFailures || 0} CURRENT / ${live.capture?.failures || live.captureFailures || 0} TOTAL</b></span>
        <span>SOURCE <b>${live.captureWidth || live.capture?.width || '-'} &times; ${live.captureHeight || live.capture?.height || '-'}</b></span>
        <span>OCR <b>${Number(live.scansPerSecond || 0).toFixed(1)}/S &middot; ${live.scans || live.metrics?.observations || 0} TOTAL</b></span>
        <span>WEAPON TPL <b>${live.weaponTemplates?.count ?? '-'}</b></span>
        <span>LATENCY <b>${live.avgOcrLatencyMs ?? '-'} MS</b></span>
        <span>VALIDATION <b>${live.accepted ?? live.metrics?.accepted ?? 0} OK / ${live.rejected ?? live.metrics?.rejected ?? 0} HELD</b></span>
        <span>FRAME AGE <b>${live.frameAgeMs === null || live.frameAgeMs === undefined ? '-' : Math.round(live.frameAgeMs)} MS</b></span>
      </div>
      ${ocr.source === 'remote' ? '' : `<div class="vo-template-trainer">
        <span>LOADOUT TEMPLATE TRAINING</span>
        <label><small>WEAPON</small><select data-vo-template="weapon">${VALORANT_LOADOUT_TEMPLATE_WEAPONS.map((weapon) => `<option value="${weapon}" ${weapon === valorantLoadoutTemplateWeapon ? 'selected' : ''}>${escapeHtml(valorantWeaponLabel(weapon))}</option>`).join('')}</select></label>
        <label><small>SIDE</small><select data-vo-template="side"><option value="home" ${valorantLoadoutTemplateSide === 'home' ? 'selected' : ''}>Home</option><option value="away" ${valorantLoadoutTemplateSide === 'away' ? 'selected' : ''}>Away</option></select></label>
        <label><small>ROW</small><select data-vo-template="row">${Array.from({ length: 5 }, (_item, index) => `<option value="${index}" ${index === Number(valorantLoadoutTemplateRow) ? 'selected' : ''}>Player ${index + 1}</option>`).join('')}</select></label>
        <button class="secondary-button" data-action="save-valorant-loadout-template">SAVE SHARED TEMPLATE</button>
      </div>`}
      ${observerTable}
      ${timelineTable}
      <details class="vo-roi-editor">
        <summary>ROI PROFILE COORDINATES <small>1920 &times; 1080 source pixels</small></summary>
        <div>${roiFields.map((field) => `<section><h3>${escapeHtml(field.label)}</h3>${['x', 'y', 'w', 'h'].map((axis) => `<label><span>${axis.toUpperCase()}</span><input type="number" min="${axis === 'x' || axis === 'y' ? 0 : 1}" data-vo-roi="${field.id}" data-vo-axis="${axis}" value="${field.roi[axis]}"></label>`).join('')}</section>`).join('')}</div>
      </details>
      ${snapshot ? `<div class="vo-debug-stage">
        <p class="vo-debug-empty">MANUAL DEBUG SNAPSHOT &middot; ${Math.max(0, Math.round((Date.now() - Number(snapshot.capturedAt || Date.now())) / 1000))}S OLD &middot; ${escapeHtml(snapshot.backend || 'unknown engine')} &middot; OCR CONTINUES LIVE</p>
        <div class="vo-frame"><img src="${escapeHtml(snapshot.frameDataUrl)}" alt="Captured VALORANT frame">${debugRoiMarkup}</div>
        <div class="vo-crops">${roiFields.map((field) => `<section><span>${escapeHtml(field.label)}</span>${snapshot.crops?.[field.id] ? `<img src="${escapeHtml(snapshot.crops[field.id].processedDataUrl)}" alt="${escapeHtml(field.label)} OCR crop">` : '<em>Not captured</em>'}</section>`).join('')}</div>
        ${observerCropMarkup}
        ${timelineCropMarkup}
      </div>` : '<p class="vo-debug-empty">Capture a debug frame to inspect the full 1920 &times; 1080 source and processed OCR crops.</p>'}
    </article>`;
}

function updateRocketLeagueOvertime(live, overtime, seconds) {
  live.overtime = Boolean(overtime);
  if (!live.overtime) {
    live.overtimeSeconds = 0;
    return;
  }
  live.overtimeSeconds = Math.max(
    Math.max(0, Math.floor(Number(live.overtimeSeconds) || 0)),
    Math.max(0, Math.floor(Number(seconds) || 0))
  );
}

function rocketLeaguePacketRate(intervalMs) {
  return Math.min(120, Math.max(1, Math.round(1000 / Math.max(1, Number(intervalMs) || 33))));
}

function renderRocketLeaguePanel(game) {
  const rl = game.rocketLeague;
  const live = rl.live;
  const sourceFields = rl.source === 'remote' ? `
    <label class="field"><span>RECEIVER PORT</span><input type="number" min="1" max="65535" data-rl-prop="bridgePort" value="${rl.bridgePort}"></label>
    <label class="field bridge-key-field"><span>BRIDGE KEY</span><input data-rl-prop="bridgeToken" value="${escapeHtml(rl.bridgeToken)}" placeholder="Generate a private key"><button data-action="generate-bridge-key">GENERATE</button><small>Graphics PC: ${escapeHtml(networkAddresses.join(' / ') || 'address unavailable')}</small></label>` : `
    <label class="field"><span>TRANSPORT</span><select data-rl-prop="transport"><option value="auto" ${rl.transport === 'auto' ? 'selected' : ''}>Automatic (WebSocket &rarr; TCP)</option><option value="websocket" ${rl.transport === 'websocket' ? 'selected' : ''}>WebSocket &middot; 49124</option><option value="tcp" ${rl.transport === 'tcp' ? 'selected' : ''}>TCP &middot; 49123</option></select></label>
    <label class="field"><span>ROCKET LEAGUE HOST</span><input data-rl-prop="host" value="${escapeHtml(rl.host)}"></label>
    <label class="field"><span>TCP PORT</span><input type="number" min="1" max="65535" data-rl-prop="tcpPort" value="${rl.tcpPort}"></label>
    <label class="field"><span>WEBSOCKET PORT</span><input type="number" min="1" max="65535" data-rl-prop="webPort" value="${rl.webPort}"></label>`;
  return `
    <article class="panel rl-live-panel">
      <header class="rl-panel-heading">
        <div><span>ROCKET LEAGUE STATS API</span><h2>Live game connection</h2><p>Official game telemetry &middot; no BakkesMod required</p></div>
        <div class="rl-status ${escapeHtml(live.status)}"><i></i><span>${escapeHtml(live.status.toUpperCase())}</span><small>${escapeHtml(live.message)}</small></div>
      </header>
      <div class="rl-connection-grid">
        <label class="rl-enable-toggle"><input type="checkbox" data-rl-prop="enabled" ${rl.enabled ? 'checked' : ''}><i></i><span><b>LIVE DATA</b><small>${rl.enabled ? 'Enabled' : 'Disabled'}</small></span></label>
        <label class="field"><span>DATA SOURCE</span><select data-rl-prop="source"><option value="local" ${rl.source === 'local' ? 'selected' : ''}>This PC / direct</option><option value="remote" ${rl.source === 'remote' ? 'selected' : ''}>Game PC bridge</option></select></label>
        <label class="field"><span>BOOST UPDATE INTERVAL</span><input type="number" min="1" max="50" step="1" data-rl-prop="updateIntervalMs" value="${rl.updateIntervalMs}"><small>1&ndash;50 ms &middot; game request ${rocketLeaguePacketRate(rl.updateIntervalMs)} updates/sec</small></label>
        ${sourceFields}
      </div>
      <div class="rl-toolbar">
        <button class="secondary-button" data-action="copy-rl-config">COPY GAME CONFIG</button>
        <button class="secondary-button" data-action="${live.status === 'simulating' ? 'stop-rl-simulator' : 'start-rl-simulator'}">${live.status === 'simulating' ? 'STOP TEST FEED' : 'RUN TEST FEED'}</button>
        <span>${live.lastPacketAt ? `LAST PACKET ${escapeHtml(new Date(live.lastPacketAt).toLocaleTimeString())}` : 'NO MATCH DATA RECEIVED'} &middot; ${live.packets || 0} PACKETS &middot; ${Number(live.packetRate || 0).toFixed(1)} PKT/S${rl.source === 'remote' ? ` &middot; ${live.bridgeClients || 0} BRIDGE` : ''}</span>
      </div>
      <div class="rl-live-summary">
        <div><span>GAME CLOCK</span><strong>${formatGameClock(live.timeSeconds, live.overtime)}</strong></div>
        <div><span>ARENA</span><strong>${escapeHtml(live.arena || 'WAITING FOR MATCH')}</strong></div>
        <div><span>MATCH ID</span><strong title="${escapeHtml(live.matchGuid)}">${escapeHtml(live.matchGuid ? live.matchGuid.slice(0, 14) : '-')}</strong></div>
        <div><span>SPECTATING</span><strong>${escapeHtml(live.spectatedPlayer || '-')}</strong></div>
      </div>
      <div class="rl-settings-grid">
        <section><h3>TEAM MAPPING</h3><label class="field"><span>BLUE TEAM IS</span><select data-rl-prop="blueTeam"><option value="0" ${Number(rl.blueTeam) === 0 ? 'selected' : ''}>Home &middot; ${escapeHtml(game.teams[0].shortName)}</option><option value="1" ${Number(rl.blueTeam) === 1 ? 'selected' : ''}>Away &middot; ${escapeHtml(game.teams[1].shortName)}</option></select></label><p>Orange is assigned to the opposite side.</p></section>
        <section><h3>AUTOMATION</h3><div class="rl-checks">
          ${rlCheckbox('syncGoals', 'Game goals', rl.syncGoals)}
          ${rlCheckbox('syncClock', 'Clock & overtime', rl.syncClock)}
          ${rlCheckbox('syncPlayers', 'Players & boost', rl.syncPlayers)}
          ${rlCheckbox('autoSeriesScore', 'Series score', rl.autoSeriesScore)}
          ${rlCheckbox('autoAdvance', 'Advance next game', rl.autoAdvance)}
        </div></section>
      </div>
      <div class="rl-player-grid">${live.players.length ? live.players.map((player) => renderLivePlayer(player, rl, game)).join('') : '<p class="rl-empty">Players and boost meters appear here when the spectator enters a match.</p>'}</div>
    </article>`;
}

function rlCheckbox(prop, label, checked) {
  return `<label><input type="checkbox" data-rl-prop="${prop}" ${checked ? 'checked' : ''}><i></i><span>${label}</span></label>`;
}

function renderLivePlayer(player, rl, game) {
  const mappedIndex = Number(player.teamNum) === 0 ? Number(rl.blueTeam) : 1 - Number(rl.blueTeam);
  const team = game.teams[mappedIndex];
  const boost = player.boost === null || player.boost === undefined ? null : Math.max(0, Math.min(100, Number(player.boost)));
  return `<div class="rl-player" style="--player-team:${escapeHtml(team.color)}"><header><span>${escapeHtml(team.shortName)}</span><strong>${escapeHtml(player.name)}</strong><small>${player.spectated ? 'ON CAMERA' : ''}</small></header><div class="boost-track"><i style="width:${boost ?? 0}%"></i></div><footer><b>${boost === null ? '&mdash;' : Math.round(boost)}</b><span>BOOST</span><em>${Number(player.goals) || 0} G &middot; ${Number(player.assists) || 0} A &middot; ${Number(player.saves) || 0} S</em></footer></div>`;
}

function displayAssetUrl(value) {
  return typeof value === 'string' && value.startsWith('/assets/')
    ? `${overlayBaseUrl}${value}`
    : value;
}

function renderPreviewTeam(team, side) {
  const secondary = team.secondaryColorEnabled ? team.secondaryColor : team.color;
  const logo = team.logoImage ? `<img src="${escapeHtml(displayAssetUrl(team.logoImage))}" alt="">` : escapeHtml(team.shortName.slice(0, 3));
  return `<div class="preview-team ${side}"><div class="team-badge ${team.logoImage ? 'has-image' : ''}" style="--team-color:${escapeHtml(team.color)};--team-secondary:${escapeHtml(secondary)}">${logo}</div><div><small>${side === 'left' ? 'HOME' : 'AWAY'}</small><strong>${escapeHtml(team.name)}</strong></div></div>`;
}

function renderTeamControl(team, index, config, game = current()) {
  const target = seriesTarget(game, config);
  const logoName = team.logoImageName || (team.logoImage ? 'Custom URL' : 'No logo selected');
  return `<article class="team-control team-${index}">
    <div class="team-control-head"><span>${index === 0 ? 'HOME TEAM' : 'AWAY TEAM'}</span><i style="background:linear-gradient(90deg,${escapeHtml(team.color)} 0 55%,${escapeHtml(team.secondaryColorEnabled ? team.secondaryColor : team.color)} 55%)"></i></div>
    <div class="team-fields">
      <label><span>DISPLAY NAME</span><input data-team="${index}" data-prop="name" value="${escapeHtml(team.name)}" maxlength="32"></label>
      <label class="short-field"><span>ABBR.</span><input data-team="${index}" data-prop="shortName" value="${escapeHtml(team.shortName)}" maxlength="5"></label>
      <label class="color-field"><span>PRIMARY</span><input type="color" data-team="${index}" data-prop="color" value="${escapeHtml(team.color)}"></label>
      <label class="color-field secondary-color-field ${team.secondaryColorEnabled ? 'enabled' : ''}"><span>SECONDARY</span><input type="color" data-team="${index}" data-prop="secondaryColor" value="${escapeHtml(team.secondaryColor)}" ${team.secondaryColorEnabled ? '' : 'disabled'}></label>
      <label class="mini-switch"><input type="checkbox" data-team="${index}" data-prop="secondaryColorEnabled" ${team.secondaryColorEnabled ? 'checked' : ''}><i></i><span>USE</span></label>
    </div>
    <div class="team-logo-row">
      <div class="asset-thumb ${team.logoImage ? 'has-image' : ''}">${team.logoImage ? `<img src="${escapeHtml(displayAssetUrl(team.logoImage))}" alt="">` : `<span>LOGO</span>`}</div>
      <label><span>LOGO URL</span><input data-team="${index}" data-prop="logoImage" value="${escapeHtml(team.logoImage || '')}" placeholder="https://... or choose local file"></label>
      <div class="team-logo-actions"><small>${escapeHtml(logoName)}</small><button data-action="pick-team-logo" data-index="${index}">${team.logoImage ? 'REPLACE FILE' : 'CHOOSE FILE'}</button>${team.logoImage ? `<button class="clear-asset" data-action="clear-team-logo" data-index="${index}">CLEAR</button>` : ''}</div>
    </div>
    <div class="score-control"><button data-action="score-minus" data-index="${index}" aria-label="Decrease ${escapeHtml(team.name)} score">&minus;</button><div><span>${escapeHtml(config.scoreLabel)}</span><strong>${team.score}</strong><small>of ${target}</small></div><button class="plus" data-action="score-plus" data-index="${index}" aria-label="Increase ${escapeHtml(team.name)} score">+</button></div>
  </article>`;
}

function field(label, path, value) {
  return `<label class="field"><span>${label}</span><input data-field="${path}" value="${escapeHtml(value)}" maxlength="60"></label>`;
}

function formatSelect(config, game, className = 'format-select', label = 'Series format') {
  const target = seriesTarget(game, config);
  return `<label class="${className}"><span>${label}</span><select data-format-length>${config.formatOptions.map((length) => `<option value="${length}" ${seriesLength(game, config) === length ? 'selected' : ''}>Best of ${length}</option>`).join('')}</select><small>First to ${target}</small></label>`;
}

function seriesLength(game, config = GAME_CONFIGS[state.selectedGame]) {
  const allowed = config.formatOptions || [];
  const fallback = config.defaultSeriesLength || game.mapRows.length;
  const requested = Number(game.seriesLength) || fallback;
  return allowed.length ? allowed.includes(requested) ? requested : fallback : requested;
}

function seriesTarget(game, config = GAME_CONFIGS[state.selectedGame]) {
  return Math.ceil(seriesLength(game, config) / 2);
}

function visibleMapRows(game, config = GAME_CONFIGS[state.selectedGame]) {
  return game.mapRows.slice(0, Math.min(game.mapRows.length, seriesLength(game, config)));
}

function syncFormat(game, length) {
  game.seriesLength = Number(length);
  game.match.format = `Best of ${game.seriesLength}`;
  game.activeMap = Math.min(game.activeMap, visibleMapRows(game).length - 1);
  if (state.selectedGame === 'rocketleague') {
    game.activeMap = 0;
    game.mapRows.forEach((row, index) => {
      row.winner = null;
      row.score = ['', ''];
      row.overtime = false;
      row.overtimeSeconds = 0;
      row.status = index === 0 ? 'ready' : 'upcoming';
    });
    game.teams.forEach((team) => { team.score = 0; });
    return;
  }
  game.mapRows.forEach((row, index) => {
    if (index >= game.seriesLength) row.status = 'upcoming';
    else if (row.winner !== null) row.status = 'complete';
    else row.status = index === game.activeMap ? 'ready' : 'upcoming';
  });
  game.teams.forEach((team, teamIndex) => {
    team.score = visibleMapRows(game).filter((row) => row.winner === teamIndex).length;
  });
}

function clearValorantMapResults(game) {
  game.mapRows.forEach((row, index) => {
    row.score = ['', ''];
    row.winner = null;
    row.overtime = false;
    row.overtimeSeconds = 0;
    row.status = index === 0 ? 'ready' : 'upcoming';
  });
  game.veto?.picks?.forEach((pick) => {
    pick.score = ['', ''];
    pick.winner = null;
  });
  game.activeMap = 0;
}

function clearSeriesMapResults(game, gameKey) {
  game.mapRows.forEach((row, index) => {
    row.score = ['', ''];
    row.winner = null;
    row.overtime = false;
    row.overtimeSeconds = 0;
    if (gameKey === 'overwatch') {
      row.map = '';
      row.mode = '';
    }
    row.status = index === 0 ? 'ready' : 'upcoming';
  });
  if (gameKey === 'valorant') {
    game.veto?.picks?.forEach((pick) => {
      pick.score = ['', ''];
      pick.winner = null;
    });
  }
  game.activeMap = 0;
}

function renderMaps(config) {
  const game = current();
  const rows = visibleMapRows(game, config);
  const target = seriesTarget(game, config);
  const formatControls = state.selectedGame === 'rocketleague'
    ? `<div><span>FORMAT</span><strong>${escapeHtml(game.match.format)}</strong></div>`
    : config.formatOptions
      ? formatSelect(config, game, 'format-select', 'FORMAT')
      : `<div><span>FORMAT</span><strong>${escapeHtml(game.match.format)}</strong></div>`;
  return `<section class="view-stack">
    <div class="section-heading"><div><span class="section-number">01</span><div><h2>Series map order</h2><p>${escapeHtml(game.match.format)} &middot; select, score, and advance maps</p></div></div>
      <button class="secondary-button" data-action="clear-maps">Clear results</button>
    </div>
    <div class="map-summary">
      <div><span>SERIES</span><strong>${escapeHtml(game.teams[0].shortName)} ${game.teams[0].score} <i>&mdash;</i> ${game.teams[1].score} ${escapeHtml(game.teams[1].shortName)}</strong></div>
      <div><span>ACTIVE</span><strong>MAP ${game.activeMap + 1}</strong></div>
      <div><span>TARGET</span><strong>FIRST TO ${target}</strong></div>
      ${formatControls}
    </div>
    ${state.selectedGame === 'valorant' ? renderValorantVetoEditor(config, game) : ''}
    <div class="map-list">
      ${rows.map((row, index) => renderMapRow(row, index, config, game)).join('')}
    </div>
    <div class="map-note"><span>LIVE OUTPUT</span> Changes on this page are sent to the Map Pool browser source immediately.</div>
  </section>`;
}

function renderValorantVetoEditor(config, game) {
  const vetoOptions = (currentValue, slotType, slotIndex) => {
    const usedMaps = new Set([
      ...game.veto.bans.filter((_, index) => slotType !== 'ban' || index !== slotIndex),
      ...game.veto.picks.filter((_, index) => slotType !== 'pick' || index !== slotIndex).map((pick) => pick.map)
    ].filter(Boolean));
    const availableMaps = config.maps.filter((map) => map === currentValue || !usedMaps.has(map));
    return `<option value="" ${currentValue ? '' : 'selected'}>Select map&hellip;</option>${availableMaps.map((option) => `<option value="${escapeHtml(option)}" ${option === currentValue ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}`;
  };
  return `<article class="panel veto-editor">
    <div class="veto-editor-heading"><div><span>VALORANT VETO</span><h3>Map picks & bans</h3></div><div class="veto-heading-actions"><button data-action="reset-veto">RESET MAP SELECTIONS</button><button data-action="preview-overlay" data-overlay="map-pool">OPEN PREVIEW</button></div></div>
    <div class="veto-ban-grid">
      ${game.veto.bans.map((map, index) => `<label><span>BAN ${index + 1}</span><select data-veto-ban="${index}">${vetoOptions(map, 'ban', index)}</select></label>`).join('')}
    </div>
    <div class="veto-pick-grid">
      ${game.veto.picks.map((pick, index) => `<section><header><span>${index === 2 ? 'DECIDER' : `PICK ${index + 1}`}</span><b>0${index + 1}</b></header><label><span>MAP</span><select data-veto-pick="${index}" data-veto-prop="map">${vetoOptions(pick.map, 'pick', index)}</select></label><label><span>ATTACKING SIDE</span><select data-veto-pick="${index}" data-veto-prop="attackers"><option value="0" ${Number(pick.attackers) === 0 ? 'selected' : ''}>${escapeHtml(game.teams[0].shortName)}</option><option value="1" ${Number(pick.attackers) === 1 ? 'selected' : ''}>${escapeHtml(game.teams[1].shortName)}</option></select></label></section>`).join('')}
    </div>
  </article>`;
}

function renderMapRow(row, index, config, game) {
  const isActive = index === game.activeMap;
  const modeOptions = `<option value="" ${row.mode ? '' : 'selected'}>TBD</option>${config.modes.map((mode) => `<option ${mode === row.mode ? 'selected' : ''}>${escapeHtml(mode)}</option>`).join('')}`;
  const mapList = row.map && !config.maps.includes(row.map) ? [row.map, ...config.maps] : config.maps;
  const mapOptions = `<option value="" ${row.map ? '' : 'selected'}>TBD</option>${mapList.map((map) => `<option ${map === row.map ? 'selected' : ''}>${escapeHtml(map)}</option>`).join('')}`;
  const overtime = row.overtime ? `<em class="map-overtime"><b>OT</b> ${formatDuration(row.overtimeSeconds)}</em>` : '';
  return `<article class="map-row ${isActive ? 'active' : ''} ${row.winner !== null ? 'complete' : ''}">
    <button class="map-index" data-action="activate-map" data-index="${index}"><span>${isActive ? 'LIVE' : row.winner !== null ? 'FINAL' : 'MAP'}</span><strong>${String(index + 1).padStart(2, '0')}</strong></button>
    <label><span>MODE</span><select data-map-index="${index}" data-map-prop="mode">${modeOptions}</select></label>
    <label class="map-name"><span>MAP / STAGE</span><select data-map-index="${index}" data-map-prop="map">${mapOptions}</select></label>
    <div class="map-score"><span>${escapeHtml(game.teams[0].shortName)}</span><input data-map-index="${index}" data-map-score="0" value="${escapeHtml(row.score[0])}" inputmode="numeric" maxlength="3"><i>&mdash;</i><input data-map-index="${index}" data-map-score="1" value="${escapeHtml(row.score[1])}" inputmode="numeric" maxlength="3"><span>${escapeHtml(game.teams[1].shortName)}</span>${overtime}</div>
    <div class="winner-buttons"><button class="${row.winner === 0 ? 'selected' : ''}" data-action="map-winner" data-index="${index}" data-winner="0">${escapeHtml(game.teams[0].shortName)}</button><button class="${row.winner === 1 ? 'selected' : ''}" data-action="map-winner" data-index="${index}" data-winner="1">${escapeHtml(game.teams[1].shortName)}</button></div>
  </article>`;
}

function renderRosters(config) {
  const game = current();
  const rosterFirstSide = game.rosterFirstSide === 'away' ? 'away' : 'home';
  const rosterFirstIndex = rosterFirstSide === 'away' ? 1 : 0;
  const rosterSecondIndex = rosterFirstIndex === 0 ? 1 : 0;
  const collection = activeRosterCollection(game);
  const roster = collection[state.activeRoster];
  const teamIndex = state.activeRosterSide === 'away' ? 1 : 0;
  const team = game.teams[teamIndex];
  return `<section class="view-stack">
    <div class="section-heading"><div><span class="section-number">01</span><div><h2>${escapeHtml(config.name)} rosters</h2><p>Home and away lineups are saved separately for every program</p></div></div>
      <button class="primary-button" data-action="add-player">+ ADD PLAYER</button>
    </div>
    <div class="roster-sidebar">
      <div class="team-side-tabs">
        <button class="${state.activeRosterSide === 'home' ? 'active' : ''}" data-roster-side="home"><span>HOME</span><strong>${escapeHtml(game.teams[0].name)}</strong></button>
        ${game.showAwayRoster || rosterFirstSide === 'away' ? `<button class="${state.activeRosterSide === 'away' ? 'active' : ''}" data-roster-side="away"><span>AWAY</span><strong>${escapeHtml(game.teams[1].name)}</strong></button>` : ''}
      </div>
      <label class="field roster-order-control"><span>FIRST TEAM SHOWN</span><select data-roster-first-side><option value="home" ${rosterFirstSide === 'home' ? 'selected' : ''}>HOME &middot; ${escapeHtml(game.teams[0].name)}</option><option value="away" ${rosterFirstSide === 'away' ? 'selected' : ''}>AWAY &middot; ${escapeHtml(game.teams[1].name)}</option></select><small>Selection follows the team when sides are swapped.</small></label>
      <label class="away-roster-toggle"><div><strong>Include second-team roster</strong><small>${game.showAwayRoster ? `Overlay cycles ${escapeHtml(game.teams[rosterFirstIndex].shortName)} &rarr; ${escapeHtml(game.teams[rosterSecondIndex].shortName)}` : `Overlay shows ${escapeHtml(game.teams[rosterFirstIndex].shortName)} only`}</small></div><input type="checkbox" data-away-roster-toggle ${game.showAwayRoster ? 'checked' : ''}><i></i></label>
    </div>
    <div class="roster-tabs">
      <button class="${state.activeRoster === 'varsity' ? 'active' : ''}" data-roster="varsity"><span>V</span><div><strong>Varsity</strong><small>${collection.varsity.filter((p) => p.handle || p.name).length} players entered</small></div></button>
      <button class="${state.activeRoster === 'jv' ? 'active' : ''}" data-roster="jv"><span>JV</span><div><strong>Junior Varsity</strong><small>${collection.jv.filter((p) => p.handle || p.name).length} players entered</small></div></button>
    </div>
    <article class="panel roster-panel">
      <div class="active-roster-band" style="--team-color:${escapeHtml(team.color)};--team-secondary:${escapeHtml(team.secondaryColorEnabled ? team.secondaryColor : team.color)}"><span>${state.activeRosterSide.toUpperCase()} LINEUP</span><strong>${escapeHtml(team.name)}</strong><small>${state.activeRoster === 'jv' ? 'JUNIOR VARSITY' : 'VARSITY'}</small></div>
      <div class="roster-header"><span>#</span><span>GAMERTAG / HANDLE</span><span>PLAYER NAME</span><span>ROLE</span><span>STATUS</span><span></span></div>
      <div class="roster-body">
        ${roster.map((player, index) => renderPlayerEditor(player, index, config, game)).join('')}
      </div>
      <footer><span><b>${roster.length}</b> roster slots</span><span>Recommended starters for ${escapeHtml(config.name)}: <b>${config.rosterSize}</b></span></footer>
    </article>
  </section>`;
}

function renderPlayerEditor(player, index, config, game) {
  const selectedArt = game.characterArt[player.character] || {};
  const isOverwatch = state.selectedGame === 'overwatch';
  const isRocketLeague = state.selectedGame === 'rocketleague';
  const imageTile = (type, label, value, filename, character = '') => `<div class="roster-asset-tile">
    <div class="asset-thumb ${value ? 'has-image' : ''}">${value ? `<img src="${escapeHtml(displayAssetUrl(value))}" alt="">` : `<span>${type === 'playerImage' ? 'PLAYER' : escapeHtml(config.characterLabel).toUpperCase()}</span>`}</div>
    <div><b>${label}</b><small>${escapeHtml(filename || (character ? `No ${character} artwork yet` : 'No image selected'))}</small><button data-action="pick-player-image" data-image-type="${type}" data-character="${escapeHtml(character)}" data-index="${index}" ${type === 'characterArtwork' && !character ? 'disabled' : ''}>${value ? 'REPLACE' : 'CHOOSE PNG'}</button>${value ? `<button class="clear-asset" data-action="clear-player-image" data-image-type="${type}" data-character="${escapeHtml(character)}" data-index="${index}">CLEAR</button>` : ''}</div>
  </div>`;
  const automaticArtTile = (label, value, filename, character = '') => `<div class="roster-asset-tile">
    <div class="asset-thumb ${value ? 'has-image' : ''}">${value ? `<img src="${escapeHtml(displayAssetUrl(value))}" alt="">` : `<span>${escapeHtml(config.characterLabel).toUpperCase()}</span>`}</div>
    <div><b>${label}</b><small>${escapeHtml(character ? (filename || `No ${character} artwork assigned`) : `Select a ${config.characterLabel.toLowerCase()} to preview art`)}</small><em>Assigned automatically</em></div>
  </div>`;
  return `<div class="player-entry">
    <div class="player-row">
      <span class="player-number">${String(index + 1).padStart(2, '0')}</span>
      <label><span>GAMERTAG</span><input data-player="${index}" data-player-prop="handle" value="${escapeHtml(player.handle)}" placeholder="Player tag" maxlength="24"></label>
      <label><span>PLAYER NAME</span><input data-player="${index}" data-player-prop="name" value="${escapeHtml(player.name)}" placeholder="First Last" maxlength="40"></label>
      <label><span>ROLE</span><select data-player="${index}" data-player-prop="role">${config.roles.map((role) => `<option ${player.role === role ? 'selected' : ''}>${escapeHtml(role)}</option>`).join('')}</select></label>
      <span class="starter-state ${index < config.rosterSize ? 'on' : ''}">${index < config.rosterSize ? 'STARTER' : 'RESERVE'}</span>
      <button class="remove-player" data-action="remove-player" data-index="${index}" title="Remove player">&times;</button>
    </div>
    <div class="player-media-row">
      ${imageTile('playerImage', 'Player portrait', player.playerImage, player.playerImageName)}
      <label class="character-field"><span>${escapeHtml(config.characterLabel).toUpperCase()} SELECTOR</span><select data-player="${index}" data-player-prop="character"><option value="">Select ${escapeHtml(config.characterLabel)}</option>${config.characters.map((character) => `<option value="${escapeHtml(character)}" ${player.character === character ? 'selected' : ''}>${escapeHtml(character)}</option>`).join('')}</select><small>${isOverwatch ? 'Hero art is assigned automatically from the selected hero.' : isRocketLeague ? 'Car PNG is unique to this player.' : `Artwork is shared across every ${escapeHtml(config.name)} roster.`}</small></label>
      ${isOverwatch
        ? automaticArtTile('Hero artwork', selectedArt.url, selectedArt.name, player.character)
        : isRocketLeague
          ? imageTile('characterImage', 'Player car PNG', player.characterImage, player.characterImageName, player.character)
          : imageTile('characterArtwork', `${config.characterLabel} artwork`, selectedArt.url, selectedArt.name, player.character)}
    </div>
  </div>`;
}

function renderOutputs() {
  const fillOutputs = [
    { name: 'scoreboard', tag: 'SCORE', title: 'Main Scoreboard Fill', description: 'Full-color scoreboard graphic for the switcher fill input.', query: { output: 'fill' } },
    { name: 'map-pool', tag: 'MAPS', title: 'Map Pool Fill', description: 'Full-color map pool graphic for the switcher fill input.', query: { output: 'fill' } },
    { name: 'roster', tag: 'TEAM', title: 'Roster Fill', description: current().showAwayRoster ? 'Full-color Home and Away roster cycle for the switcher fill input.' : 'Full-color roster screen for the switcher fill input.', query: { output: 'fill', program: state.activeRoster } },
    { name: 'clean', tag: 'CLEAN', title: 'Clean Fill', description: 'Transparent no-graphic output for clearing the fill input.', query: { output: 'fill' } }
  ];
  const programOptions = [
    { name: 'scoreboard', label: 'Scoreboard' },
    { name: 'roster', label: 'Roster' },
    { name: 'map-pool', label: 'Map Pool' },
    { name: 'clean', label: 'Clean' }
  ];
  const outputs = [
    ...fillOutputs,
    ...fillOutputs.map((output) => ({
      ...output,
      title: output.title.replace(' Fill', ' Key'),
      tag: `${output.tag} KEY`,
      description: output.description.replace('Full-color', 'Alpha-mask').replace('fill input', 'key input'),
      query: { ...(output.query || {}), output: 'key' },
      keyOutput: true
    }))
  ];
  const urlFor = (output) => {
    const url = new URL(`${overlayBaseUrl}/overlays/${output.name}.html`);
    for (const [key, value] of Object.entries(output.query || {})) url.searchParams.set(key, value);
    return url.toString();
  };
  const activeProgram = programOptions.find((option) => option.name === state.activeOutputOverlay) || programOptions[0];
  const programUrlFor = (output) => {
    const url = new URL(`${overlayBaseUrl}/overlays/program.html`);
    url.searchParams.set('output', output);
    return url.toString();
  };
  const programPairUrl = programUrlFor('pair');
  const programFillUrl = programUrlFor('fill');
  const programKeyUrl = programUrlFor('key');
  return `<section class="view-stack">
    <div class="coming-banner live-output-banner"><div class="coming-icon">&lt;/&gt;</div><div><span>LOCAL OVERLAY SERVER</span><h2>OBS graphics are ready</h2><p>Open Program Output once, then take Scoreboard, Roster, or Map Pool from the controller or Companion without resetting the projectors.</p></div><strong><i></i>ONLINE &middot; PORT 3174</strong></div>
    <article class="output-card pair-output-card program-output-card">
      <div class="output-thumb"><span>PROGRAM</span><div class="ghost-score"><i></i><b>FILL</b><strong>${activeProgram.name === 'clean' ? 'CLEAR' : escapeHtml(activeProgram.label)}</strong><b>KEY</b><i></i></div></div>
      <div class="output-info"><div><h3>Program Fill+Key Output</h3><p>One persistent dual-screen output. Fill and Key stay open on the selected displays while the active HTML changes.</p></div><span>2x 1920 &times; 1080</span></div>
      <div class="program-output-actions">
        ${programOptions.map((option) => `<button class="${option.name === activeProgram.name ? 'active' : ''}" data-action="take-program-output" data-overlay="${option.name}">${escapeHtml(option.label)}</button>`).join('')}
      </div>
      <div class="output-url">${escapeHtml(programPairUrl)}</div>
      <footer><span class="planned-dot online"></span>PROGRAM OUTPUT <button data-action="open-program-output" data-overlay="${activeProgram.name}">OPEN PROGRAM</button><button data-action="copy-overlay-url" data-url="${escapeHtml(programFillUrl)}">COPY FILL URL</button><button data-action="copy-overlay-url" data-url="${escapeHtml(programKeyUrl)}">COPY KEY URL</button><button data-action="copy-overlay-url" data-url="${escapeHtml(programPairUrl)}">COPY OBS PAIR URL</button></footer>
    </article>
    <div class="section-heading"><div><span class="section-number">01</span><div><h2>Browser-source outputs</h2><p>Individual Fill and Key HTML graphics &middot; current game: ${escapeHtml(GAME_CONFIGS[state.selectedGame].name)}</p></div></div></div>
    <div class="output-grid">${outputs.map((output) => `<article class="output-card ${output.keyOutput ? 'key-output-card' : ''} ${output.pairOutput ? 'pair-output-card' : ''}"><div class="output-thumb"><span>${output.tag}</span><div class="ghost-score"><i></i><b>ISU</b><strong>${output.name === 'roster' ? 'PLAYER &rarr; HERO' : '0 &mdash; 0'}</strong><b>OPP</b><i></i></div></div><div class="output-info"><div><h3>${output.title}</h3><p>${output.description}</p></div><span>${output.pairOutput ? '2x 1920' : '1920'} &times; 1080</span></div><div class="output-url">${escapeHtml(urlFor(output))}</div><footer><span class="planned-dot online"></span>${output.pairOutput ? 'DUAL OUTPUT' : output.keyOutput ? 'KEY OUTPUT' : 'FILL OUTPUT'} <button data-action="preview-overlay" data-overlay="${output.name}" data-query='${escapeHtml(JSON.stringify(output.query || {}))}'>PREVIEW</button><button data-action="open-overlay-output" data-overlay="${output.name}" data-query='${escapeHtml(JSON.stringify(output.query || {}))}'>${output.pairOutput ? 'OPEN DUAL' : 'OPEN WINDOW'}</button><button data-action="copy-overlay-url" data-url="${escapeHtml(urlFor(output))}">COPY URL</button></footer></article>`).join('')}</div>
  </section>`;
}

function renderDisplayOptions(selectedId, fallbackLabel) {
  const options = [`<option value="">${fallbackLabel}</option>`];
  outputDisplays.forEach((display) => {
    options.push(`<option value="${escapeHtml(display.id)}" ${String(selectedId || '') === String(display.id) ? 'selected' : ''}>${escapeHtml(display.label)}</option>`);
  });
  return options.join('');
}

function renderSettings() {
  const companionHost = networkAddresses[0] || '127.0.0.1';
  const companionBaseUrl = `http://${companionHost}:${companionSettings.port}/api/companion`;
  const apiState = companionStatus.listening ? 'ONLINE' : companionSettings.enabled ? 'ERROR' : 'OFF';
  return `<section class="view-stack settings-view">
    <div class="section-heading"><div><span class="section-number">01</span><div><h2>Workspace data</h2><p>Local-first settings for a dependable broadcast desk</p></div></div></div>
    <div class="settings-grid">
      <article class="panel setting-card"><div class="setting-icon">&#8635;</div><div><h3>Reset active game</h3><p>Restore ${escapeHtml(GAME_CONFIGS[state.selectedGame].name)} match, map, and roster data to its defaults.</p></div><button class="danger-button" data-action="reset-game">RESET GAME</button></article>
      <article class="panel setting-card"><div class="setting-icon">&#10003;</div><div><h3>Automatic local save</h3><p>All edits persist on this computer as soon as they are made. No account or network is required.</p></div><span class="setting-on">ENABLED</span></article>
      <article class="panel setting-card"><div class="setting-icon">i</div><div><h3>Application</h3><p>ISU Esports Broadcast Control &middot; Rocket League live telemetry &middot; Companion control API</p></div><span class="version-badge">v0.6.0</span></article>
    </div>
    <div class="section-heading companion-heading"><div><span class="section-number">02</span><div><h2>Direct output displays</h2><p>Choose which Windows displays receive fullscreen Fill and Key output windows</p></div></div></div>
    <article class="panel companion-api-panel">
      <header><div><span>HDMI / SDI OUTPUT ROUTING</span><h3>Projection screens</h3><p>Paired outputs open two synced 1920 &times; 1080 fullscreen windows. Set Windows display scaling to 100% for video outputs when possible.</p></div><span class="api-status online"><i></i>${outputDisplays.length || 0} DISPLAYS</span></header>
      <div class="companion-fields">
        <label class="field"><span>FILL SCREEN</span><select data-output-display-prop="fillDisplayId">${renderDisplayOptions(outputDisplaySettings.fillDisplayId, 'Primary display')}</select><small>Used by Fill and the left side of Paired dual output.</small></label>
        <label class="field"><span>KEY SCREEN</span><select data-output-display-prop="keyDisplayId">${renderDisplayOptions(outputDisplaySettings.keyDisplayId, 'Second display')}</select><small>Used by Key and the right side of Paired dual output.</small></label>
        <label class="field compact-setting"><span>PROGRAM FADE OUT</span><input type="number" min="0.1" max="5" step="0.1" data-program-transition value="${Number(state.programTransitionSeconds || 1).toFixed(1)}"><small>Seconds. Applies when switching Scoreboard, Roster, Map Pool, or Clean.</small></label>
      </div>
      <footer><strong>Output scale</strong><span>Each app output window is created as a 1920 &times; 1080 source and then fullscreened on the selected display.</span><span>Use Preview for setup checks; Open Dual takes over both selected screens.</span></footer>
    </article>
    <div class="section-heading companion-heading"><div><span class="section-number">03</span><div><h2>Bitfocus Companion API</h2><p>Authenticated LAN control for Stream Deck buttons, variables, and future native Companion modules</p></div></div></div>
    <article class="panel companion-api-panel">
      <header><div><span>REMOTE CONTROL SERVICE</span><h3>Companion connection</h3><p>The API is disabled until you turn it on. Keep the private key out of screenshots and public profiles.</p></div><span class="api-status ${companionStatus.listening ? 'online' : companionStatus.error ? 'error' : ''}"><i></i>${apiState}</span></header>
      <div class="companion-fields">
        <label class="away-roster-toggle companion-toggle"><div><strong>Enable LAN API</strong><small>${companionSettings.enabled ? 'Accepting authenticated control requests' : 'No remote control connections allowed'}</small></div><input type="checkbox" data-companion-prop="enabled" ${companionSettings.enabled ? 'checked' : ''}><i></i></label>
        <label class="field"><span>API PORT</span><input type="number" min="1024" max="65535" data-companion-prop="port" value="${companionSettings.port}"><small>Default: 3176</small></label>
        <label class="field companion-key-field"><span>PRIVATE API KEY</span><input type="password" data-companion-prop="token" value="${escapeHtml(companionSettings.token)}" minlength="16" autocomplete="off"><button data-action="generate-companion-key">GENERATE</button></label>
      </div>
      <div class="companion-url-row"><div><span>COMPANION BASE URL</span><code>${escapeHtml(companionBaseUrl)}</code></div><button data-action="copy-companion-url" data-url="${escapeHtml(companionBaseUrl)}">COPY URL</button><button data-action="copy-companion-key" data-url="${escapeHtml(companionSettings.token)}">COPY KEY</button></div>
      ${companionStatus.error ? `<p class="companion-error">${escapeHtml(companionStatus.error)}</p>` : ''}
      <footer><strong>Generic HTTP setup</strong><span>Base URL above &middot; Add header <code>X-ISU-API-Key: your-key</code> to each request &middot; POST <code>/action</code> with a JSON body</span><span>Variables: GET <code>/variables</code> &middot; Actions list: GET <code>/capabilities</code> &middot; Live variables: GET <code>/events</code></span></footer>
    </article>
    <div class="brand-statement"><div class="brand-mark large"><span>IS</span><i></i></div><div><span>BUILT FOR</span><strong>IDAHO STATE ESPORTS</strong><p>Roarange. Bengal Black. Broadcast ready.</p></div></div>
  </section>`;
}

async function syncCompanionApi() {
  if (!window.isuDesktop?.configureCompanion) return;
  const result = await window.isuDesktop.configureCompanion(companionSettings);
  companionSettings = result?.settings || companionSettings;
  companionStatus = result?.status || companionStatus;
}

function updatePath(path, value) {
  const parts = path.split('.');
  let target = current();
  while (parts.length > 1) target = target[parts.shift()];
  target[parts[0]] = value;
}

function syncRocketLeagueConnection() {
  const rl = state.games.rocketleague.rocketLeague;
  window.isuDesktop?.configureRocketLeague({
    ...rl,
    savedEnabled: rl.enabled,
    enabled: state.selectedGame === 'rocketleague' && rl.enabled
  });
}

function formatObserverActiveLabel(activeCell = {}) {
  return activeCell.side
    ? `SCANNING ${String(activeCell.side).toUpperCase()} ${Number(activeCell.row ?? 0) + 1} ${String(activeCell.columnId || '').toUpperCase()}`
    : 'SCANNING SCOREBOARD TABLE';
}

function applyValorantOcrActiveHighlight() {
  if (state.selectedGame !== 'valorant' || state.activeView !== 'control') return;
  const activeCell = state.games.valorant.valorantOcr.live?.observer3?.activeCell || null;
  const activeKey = activeCell?.side ? `${activeCell.side}:${activeCell.row}:${activeCell.columnId}:${activeCell.updatedAt || ''}` : '';
  if (activeKey && activeKey === lastValorantOcrActiveKey) return;
  lastValorantOcrActiveKey = activeKey;
  root.querySelectorAll('.vo-observer-table td.scanning, .vo-frame > .vo-scoreboard-field-box.scanning, .vo-frame > .vo-timeline-round-box.scanning')
    .forEach((node) => node.classList.remove('scanning'));
  const label = root.querySelector('[data-vo-observer-active-label]');
  if (label) label.textContent = activeCell?.side ? formatObserverActiveLabel(activeCell) : 'SCANNING SCOREBOARD TABLE';
  if (!activeCell?.side) return;
  const side = String(activeCell.side);
  const row = Number(activeCell.row);
  const columnId = String(activeCell.columnId || '');
  root.querySelector(`[data-vo-observer-cell="${CSS.escape(`${side}:${row}:${columnId}`)}"]`)?.classList.add('scanning');
  if (side === 'timeline') {
    root.querySelector(`[data-vo-timeline-box="${CSS.escape(String(row + 1))}"]`)?.classList.add('scanning');
    return;
  }
  root.querySelector(`[data-vo-observer-box="${CSS.escape(`${side}:${row}:${observerGuideIdForColumn(columnId)}`)}"]`)?.classList.add('scanning');
}

async function syncValorantOcr() {
  const ocr = state.games.valorant.valorantOcr;
  if (!window.isuDesktop?.configureValorantOcr) return;
  const result = await window.isuDesktop.configureValorantOcr({
    ...ocr,
    live: undefined,
    savedEnabled: ocr.enabled,
    enabled: state.selectedGame === 'valorant' && ocr.enabled,
    source: ocr.source
  });
  if (result?.status) {
    ocr.live = { ...ocr.live, ...result.status, status: result.status.state || ocr.live.status };
  }
}

function scheduleValorantOcrUpdate() {
  applyValorantOcrActiveHighlight();
  if (!livePublishTimer) {
    livePublishTimer = window.setTimeout(() => {
      livePublishTimer = null;
      window.isuDesktop?.publishState(state);
    }, 100);
  }
  if (state.selectedGame !== 'valorant' || state.activeView !== 'control' || valorantOcrRenderTimer || valorantRoiDrag) return;
  valorantOcrRenderTimer = window.setTimeout(() => {
    valorantOcrRenderTimer = null;
    if (valorantRoiDrag) return;
    const activeElement = document.activeElement;
    const editing = root.contains(activeElement) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(activeElement?.tagName);
    const activelyScrolling = performance.now() - lastUserScrollAt < 500;
    if (!editing && !activelyScrolling) render();
  }, 240);
}

function scheduleLiveUpdate() {
  if (!livePublishTimer) {
    livePublishTimer = window.setTimeout(() => {
      livePublishTimer = null;
      window.isuDesktop?.publishState(state);
    }, Math.max(1, Math.min(50, Number(state.games.rocketleague.rocketLeague.updateIntervalMs) || 33)));
  }
  if (state.selectedGame === 'rocketleague' && state.activeView === 'control') {
    if (!liveRenderTimer) {
      liveRenderTimer = window.setTimeout(() => {
        liveRenderTimer = null;
        const activeElement = document.activeElement;
        const editing = root.contains(activeElement) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(activeElement?.tagName);
        const activelyScrolling = performance.now() - lastUserScrollAt < 450;
        if (!editing && !activelyScrolling) render();
      }, 160);
    }
  }
}

function mapRocketLeagueTeam(teamNum, rl) {
  return Number(teamNum) === 0 ? Number(rl.blueTeam) : 1 - Number(rl.blueTeam);
}

function applyRocketLeagueScores(game) {
  const rl = game.rocketLeague;
  if (!rl.syncGoals || !Array.isArray(rl.live.teamScores)) return;
  rl.live.teamScores.forEach((score, teamNum) => {
    game.teams[mapRocketLeagueTeam(teamNum, rl)].detailScore = Number(score) || 0;
  });
}

function rocketLeaguePlayerId(player) {
  const primaryId = String(player.PrimaryId || '').trim();
  const genericBotId = !primaryId || primaryId === 'Unknown|0|0';
  if (!genericBotId) return primaryId;
  return `${Number(player.TeamNum) || 0}|${player.Shortcut ?? ''}|${player.Name || 'Unknown Player'}`;
}

function normalizeLivePlayers(data, rl) {
  const target = data.Game?.Target?.Name || '';
  return (data.Players || []).map((player) => ({
    id: rocketLeaguePlayerId(player),
    name: player.Name || 'Unknown Player',
    teamNum: Number(player.TeamNum) || 0,
    shortcut: player.Shortcut,
    score: Number(player.Score) || 0,
    goals: Number(player.Goals) || 0,
    assists: Number(player.Assists) || 0,
    saves: Number(player.Saves) || 0,
    shots: Number(player.Shots) || 0,
    demos: Number(player.Demos) || 0,
    boost: player.Boost === undefined ? null : Number(player.Boost),
    demolished: Boolean(player.bDemolished),
    spectated: player.Name === target
  })).sort((a, b) => mapRocketLeagueTeam(a.teamNum, rl) - mapRocketLeagueTeam(b.teamNum, rl));
}

function rocketLeaguePlayerStatSnapshot(player) {
  return ROCKET_LEAGUE_STAT_EVENTS.reduce((snapshot, event) => {
    snapshot[event.key] = Math.max(0, Number(player[event.key]) || 0);
    return snapshot;
  }, {});
}

function updateRocketLeagueRecentEvents(live, players) {
  const now = Date.now();
  const previousStats = live.playerStats && typeof live.playerStats === 'object' ? live.playerStats : {};
  const nextStats = {};
  let recentEvents = Array.isArray(live.recentEvents)
    ? live.recentEvents.filter((event) => Number(event.removeAt) > now)
    : [];

  players.forEach((player) => {
    const playerId = player.id || `${player.teamNum}|${player.shortcut}|${player.name}`;
    const currentStats = rocketLeaguePlayerStatSnapshot(player);
    const hasOldStats = Object.prototype.hasOwnProperty.call(previousStats, playerId);
    const oldStats = previousStats[playerId] || {};
    const changes = ROCKET_LEAGUE_STAT_EVENTS
      .map((event) => ({
        ...event,
        value: currentStats[event.key],
        previousValue: Math.max(0, Number(oldStats[event.key]) || 0)
      }))
      .filter((event) => hasOldStats && event.value > event.previousValue)
      .sort((a, b) => b.priority - a.priority);

    if (changes.length) {
      const event = changes[0];
      recentEvents = recentEvents.filter((recent) => recent.playerId !== playerId);
      recentEvents.push({
        id: `${playerId}-${event.key}-${now}`,
        playerId,
        playerName: player.name,
        key: event.key,
        label: event.label,
        title: event.title,
        count: event.value - event.previousValue,
        createdAt: now,
        expiresAt: now + ROCKET_LEAGUE_EVENT_BADGE_MS,
        removeAt: now + ROCKET_LEAGUE_EVENT_BADGE_MS + ROCKET_LEAGUE_EVENT_FADE_MS
      });
    }

    nextStats[playerId] = currentStats;
  });

  live.playerStats = nextStats;
  live.recentEvents = recentEvents.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
}

function handleRocketLeagueEvent(envelope) {
  const game = state.games.rocketleague;
  const rl = game.rocketLeague;
  const data = envelope?.Data || {};
  if (envelope?.Event === 'UpdateState') {
    const gameData = data.Game || {};
    rl.live.matchGuid = data.MatchGuid || rl.live.matchGuid;
    if (rl.syncClock) {
      const timeSeconds = Number(gameData.TimeSeconds ?? rl.live.timeSeconds);
      rl.live.timeSeconds = timeSeconds;
      updateRocketLeagueOvertime(rl.live, gameData.bOvertime === undefined ? rl.live.overtime : gameData.bOvertime, timeSeconds);
    }
    rl.live.arena = rocketLeagueArenaName(gameData.Arena || rl.live.arena);
    rl.live.replay = Boolean(gameData.bReplay);
    rl.live.spectatedPlayer = gameData.Target?.Name || '';
    rl.live.teamScores = (gameData.Teams || []).reduce((scores, team) => {
      scores[Number(team.TeamNum)] = Number(team.Score) || 0;
      return scores;
    }, rl.live.teamScores || [0, 0]);
    applyRocketLeagueScores(game);
    if (rl.syncPlayers) {
      rl.live.players = normalizeLivePlayers(data, rl);
      updateRocketLeagueRecentEvents(rl.live, rl.live.players);
    }
    scheduleLiveUpdate();
    return;
  }
  if (envelope?.Event === 'ClockUpdatedSeconds' && rl.syncClock) {
    rl.live.matchGuid = data.MatchGuid || rl.live.matchGuid;
    const timeSeconds = Number(data.TimeSeconds ?? rl.live.timeSeconds);
    rl.live.timeSeconds = timeSeconds;
    updateRocketLeagueOvertime(rl.live, data.bOvertime === undefined ? rl.live.overtime : data.bOvertime, timeSeconds);
    scheduleLiveUpdate();
    return;
  }
  if (envelope?.Event === 'MatchCreated') {
    rl.live.matchGuid = data.MatchGuid || '';
    rl.live.timeSeconds = 300;
    rl.live.overtime = false;
    rl.live.overtimeSeconds = 0;
    rl.live.players = [];
    rl.live.recentEvents = [];
    rl.live.playerStats = {};
    rl.live.teamScores = [0, 0];
    if (rl.syncGoals) game.teams.forEach((team) => { team.detailScore = 0; });
    scheduleLiveUpdate();
    return;
  }
  if (envelope?.Event !== 'MatchEnded') return;
  const matchGuid = data.MatchGuid || rl.live.matchGuid || `MATCH-${Date.now()}`;
  if (rl.processedMatches.includes(matchGuid)) return;
  const winnerRlTeam = Number.isInteger(data.WinnerTeamNum)
    ? Number(data.WinnerTeamNum)
    : Number((rl.live.teamScores?.[1] || 0) > (rl.live.teamScores?.[0] || 0));
  const winner = mapRocketLeagueTeam(winnerRlTeam, rl);
  commit(() => {
    rl.processedMatches.push(matchGuid);
    rl.processedMatches = rl.processedMatches.slice(-30);
    const activeRow = game.mapRows[game.activeMap];
    if (activeRow) {
      const arena = rocketLeagueArenaName(data.Game?.Arena || rl.live.arena);
      if (arena) activeRow.map = arena;
      const endedInOvertime = Boolean(data.Game?.bOvertime ?? rl.live.overtime) || Number(rl.live.overtimeSeconds) > 0;
      activeRow.overtime = endedInOvertime;
      activeRow.overtimeSeconds = endedInOvertime ? Math.max(0, Math.floor(Number(data.Game?.OvertimeSeconds ?? rl.live.overtimeSeconds ?? data.Game?.TimeSeconds ?? rl.live.timeSeconds) || 0)) : 0;
      activeRow.winner = winner;
      activeRow.status = 'complete';
      activeRow.score = [String(game.teams[0].detailScore), String(game.teams[1].detailScore)];
    }
    if (rl.autoSeriesScore) game.teams[winner].score = Math.min(seriesTarget(game, GAME_CONFIGS.rocketleague), game.teams[winner].score + 1);
  }, `${game.teams[winner].shortName} game win received`);
  persistState();
  render();
  if (rl.autoAdvance && Math.max(...game.teams.map((team) => team.score)) < seriesTarget(game, GAME_CONFIGS.rocketleague)) {
    window.setTimeout(() => {
      const nextIndex = Math.min(game.activeMap + 1, visibleMapRows(game, GAME_CONFIGS.rocketleague).length - 1);
      commit(() => {
        game.activeMap = nextIndex;
        game.teams.forEach((team) => { team.detailScore = 0; });
        game.mapRows.forEach((row, index) => { if (row.winner === null) row.status = index === nextIndex ? 'ready' : 'upcoming'; });
      }, `Advanced to game ${nextIndex + 1}`);
      render();
    }, 3000);
  }
}

window.isuDesktop?.onRocketLeagueStatus((status) => {
  const rl = state.games.rocketleague.rocketLeague;
  rl.live = { ...rl.live, ...status, status: status.state || status.status || rl.live.status };
  scheduleLiveUpdate();
});

window.isuDesktop?.onRocketLeagueEvent(handleRocketLeagueEvent);

window.isuDesktop?.onValorantOcrState((snapshot) => {
  const ocr = state.games.valorant.valorantOcr;
  const nextObserver3 = snapshot?.observer3 && typeof snapshot.observer3 === 'object'
    ? snapshot.observer3
    : ocr.live.observer3;
  ocr.live = {
    ...ocr.live,
    ...snapshot,
    fields: snapshot?.fields || ocr.live.fields,
    metrics: snapshot?.metrics || ocr.live.metrics,
    observer3: nextObserver3
  };
  scheduleValorantOcrUpdate();
});

window.isuDesktop?.onValorantOcrStatus((status) => {
  const ocr = state.games.valorant.valorantOcr;
  const { observer3: _ignoredObserver3, ...safeStatus } = status || {};
  ocr.live = { ...ocr.live, ...safeStatus, status: status?.state || ocr.live.status };
  scheduleValorantOcrUpdate();
});

async function executeCompanionAction(request = {}) {
  const nextState = deepClone(state);
  const result = applyCompanionAction(nextState, request);
  if (result.teamsSwapped && result.gameKey === nextState.selectedGame) {
    nextState.activeRosterSide = nextState.activeRosterSide === 'away' ? 'home' : 'away';
  }
  history.push(deepClone(state));
  if (history.length > 30) history.shift();
  state = nextState;
  persistState();
  if (result.selectedGameChanged) {
    syncRocketLeagueConnection();
    syncValorantOcr();
  }
  if (result.outputChanged) await window.isuDesktop?.setProgramOutput({ name: state.activeOutputOverlay });
  render();
  return result;
}

window.isuDesktop?.onCompanionAction(executeCompanionAction);

root.addEventListener('scroll', (event) => {
  if (event.target.classList?.contains('content-scroll')) lastUserScrollAt = performance.now();
}, true);

root.addEventListener('click', async (event) => {
  const viewButton = event.target.closest('[data-view]');
  if (viewButton) {
    state.activeView = viewButton.dataset.view;
    persistState();
    render();
    return;
  }
  const rosterButton = event.target.closest('[data-roster]');
  if (rosterButton) {
    state.activeRoster = rosterButton.dataset.roster;
    persistState();
    render();
    return;
  }
  const rosterSideButton = event.target.closest('[data-roster-side]');
  if (rosterSideButton) {
    state.activeRosterSide = rosterSideButton.dataset.rosterSide;
    persistState();
    render();
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const index = Number(button.dataset.index);
  const game = current();
  const config = GAME_CONFIGS[state.selectedGame];
  if (button.dataset.action === 'pick-team-logo') {
    const selected = await window.isuDesktop?.pickImage({
      gameKey: state.selectedGame,
      team: index,
      type: 'teamLogo'
    });
    if (selected) {
      commit(() => {
        game.teams[index].logoImage = selected.url;
        game.teams[index].logoImageName = selected.name;
      }, 'Team logo saved');
      render();
    }
    return;
  }
  if (button.dataset.action === 'clear-team-logo') {
    commit(() => {
      game.teams[index].logoImage = '';
      game.teams[index].logoImageName = '';
    }, 'Team logo cleared');
    render();
    return;
  }
  if (button.dataset.action === 'pick-player-image') {
    const type = button.dataset.imageType;
    const character = button.dataset.character;
    const selected = await window.isuDesktop?.pickImage({
      gameKey: state.selectedGame,
      roster: state.activeRoster,
      side: state.activeRosterSide,
      index,
      type: type === 'characterArtwork' ? `character-${character}` : type
    });
    if (selected) {
      commit(() => {
        if (type === 'characterArtwork') game.characterArt[character] = { url: selected.url, name: selected.name };
        else {
          const player = activeRosterCollection(game)[state.activeRoster][index];
          player[type] = selected.url;
          player[`${type}Name`] = selected.name;
        }
      }, type === 'characterArtwork' ? `${character} artwork saved` : 'Roster image saved');
      render();
    }
    return;
  }
  if (button.dataset.action === 'clear-player-image') {
    const type = button.dataset.imageType;
    const character = button.dataset.character;
    commit(() => {
      if (type === 'characterArtwork') delete game.characterArt[character];
      else {
        const player = activeRosterCollection(game)[state.activeRoster][index];
        player[type] = '';
        player[`${type}Name`] = '';
      }
    }, type === 'characterArtwork' ? `${character} artwork cleared` : 'Roster image cleared');
    render();
    return;
  }
  if (button.dataset.action === 'copy-overlay-url') {
    if (window.isuDesktop?.copyText) window.isuDesktop.copyText(button.dataset.url);
    else await navigator.clipboard?.writeText(button.dataset.url);
    toast('OBS URL copied');
    return;
  }
  if (button.dataset.action === 'copy-companion-url' || button.dataset.action === 'copy-companion-key') {
    if (window.isuDesktop?.copyText) window.isuDesktop.copyText(button.dataset.url);
    else await navigator.clipboard?.writeText(button.dataset.url);
    toast(button.dataset.action === 'copy-companion-key' ? 'Private API key copied' : 'Companion URL copied');
    return;
  }
  if (button.dataset.action === 'generate-companion-key') {
    companionSettings.token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '');
    await syncCompanionApi();
    toast('New Companion API key generated');
    render();
    return;
  }
  if (button.dataset.action === 'preview-overlay') {
    let query = {};
    try { query = JSON.parse(button.dataset.query || '{}'); } catch {}
    window.isuDesktop?.openOverlayPreview({ name: button.dataset.overlay, query });
    return;
  }
  if (button.dataset.action === 'open-program-output') {
    const opened = await window.isuDesktop?.openProgramOutput({ name: state.activeOutputOverlay || button.dataset.overlay || 'scoreboard' });
    toast(opened ? 'Program output opened' : 'Program output unavailable');
    return;
  }
  if (button.dataset.action === 'take-program-output') {
    state.activeOutputOverlay = button.dataset.overlay || 'scoreboard';
    persistState();
    const updated = await window.isuDesktop?.setProgramOutput({ name: state.activeOutputOverlay });
    toast(updated ? `Program output: ${button.textContent}` : `Selected ${button.textContent}`);
    render();
    return;
  }
  if (button.dataset.action === 'open-overlay-output') {
    let query = {};
    try { query = JSON.parse(button.dataset.query || '{}'); } catch {}
    const opened = await window.isuDesktop?.openOverlayOutput({ name: button.dataset.overlay, query });
    toast(opened ? 'Output window opened' : 'Output window unavailable');
    return;
  }
  if (button.dataset.action === 'copy-rl-config') {
    const rl = state.games.rocketleague.rocketLeague;
    const configText = `[TAGame.MatchStatsExporter_TA]\nPacketSendRate=${rocketLeaguePacketRate(rl.updateIntervalMs)}\nPort=${rl.tcpPort}\nWebPort=${rl.webPort}`;
    window.isuDesktop?.copyText(configText);
    toast('Rocket League configuration copied');
    return;
  }
  if (button.dataset.action === 'generate-bridge-key') {
    commit(() => { game.rocketLeague.bridgeToken = crypto.randomUUID().replaceAll('-', ''); }, 'Private bridge key generated');
    syncRocketLeagueConnection();
    render();
    return;
  }
  if (button.dataset.action === 'start-rl-simulator') {
    await window.isuDesktop?.startRocketLeagueSimulator();
    toast('Rocket League test feed started');
    return;
  }
  if (button.dataset.action === 'stop-rl-simulator') {
    await window.isuDesktop?.stopRocketLeagueSimulator();
    toast('Test feed stopped');
    return;
  }
  if (button.dataset.action === 'detect-valorant-window') {
    try {
      valorantWindowChoices = await window.isuDesktop?.listValorantWindows() || [];
      const match = valorantWindowChoices.find((window) => window.name.toLowerCase() === 'valorant')
        || valorantWindowChoices.find((window) => window.name.toLowerCase().includes('valorant'));
      if (match) {
        commit(() => { state.games.valorant.valorantOcr.windowName = match.name; }, 'VALORANT window selected');
        await syncValorantOcr();
        toast(`Found ${match.name}`);
      } else toast('No VALORANT window found');
    } catch (error) {
      toast(error?.message || 'Window scan failed');
    }
    render();
    return;
  }
  if (button.dataset.action === 'capture-valorant-frame') {
    try {
      valorantOcrSnapshot = await window.isuDesktop?.captureValorantOcrSnapshot();
      valorantDebugFullscreen = false;
      toast('Debug frame captured');
    } catch (error) {
      toast(error?.message || 'Could not capture VALORANT');
    }
    render();
    return;
  }
  if (button.dataset.action === 'open-valorant-debug-fullscreen') {
    if (!valorantOcrSnapshot?.frameDataUrl) {
      toast('Capture a debug frame first');
      return;
    }
    valorantDebugFullscreen = true;
    render();
    return;
  }
  if (button.dataset.action === 'close-valorant-debug-fullscreen') {
    valorantDebugFullscreen = false;
    render();
    return;
  }
  if (button.dataset.action === 'save-valorant-rois') {
    try {
      await saveAllValorantRoisFromInputs();
      toast('OCR boxes saved');
    } catch (error) {
      toast(error?.message || 'Could not save OCR boxes');
    }
    render();
    return;
  }
  if (button.dataset.action === 'save-valorant-loadout-template') {
    try {
      const selectedWeapon = root.querySelector('[data-vo-template="weapon"]')?.value || valorantLoadoutTemplateWeapon;
      const selectedSide = root.querySelector('[data-vo-template="side"]')?.value || valorantLoadoutTemplateSide;
      const selectedRow = Number(root.querySelector('[data-vo-template="row"]')?.value ?? valorantLoadoutTemplateRow);
      valorantLoadoutTemplateWeapon = selectedWeapon;
      valorantLoadoutTemplateSide = selectedSide === 'away' ? 'away' : 'home';
      valorantLoadoutTemplateRow = Math.max(0, Math.min(4, Math.round(selectedRow || 0)));
      const result = await window.isuDesktop?.saveValorantLoadoutTemplate?.({
        weapon: valorantLoadoutTemplateWeapon,
        side: valorantLoadoutTemplateSide,
        row: valorantLoadoutTemplateRow
      });
      const info = await window.isuDesktop?.getValorantOcrInfo?.();
      if (info?.state) state.games.valorant.valorantOcr.live = info.state;
      toast(`Saved ${result?.weapon || valorantWeaponLabel(valorantLoadoutTemplateWeapon)} ${result?.scope === 'shared' ? 'shared ' : ''}template`);
    } catch (error) {
      toast(error?.message || 'Could not save loadout template');
    }
    render();
    return;
  }
  if (button.dataset.action === 'clear-valorant-ocr') {
    await window.isuDesktop?.clearValorantOcrState();
    toast('OCR locks and history cleared');
    return;
  }
  if (button.dataset.action === 'start-valorant-simulator') {
    await window.isuDesktop?.startValorantOcrSimulator();
    toast('VALORANT OCR test feed started');
    return;
  }
  if (button.dataset.action === 'stop-valorant-simulator') {
    await window.isuDesktop?.stopValorantOcrSimulator();
    toast('VALORANT OCR test feed stopped');
    return;
  }
  if (button.dataset.action === 'generate-valorant-bridge-key') {
    commit(() => { state.games.valorant.valorantOcr.bridgeToken = crypto.randomUUID().replaceAll('-', ''); }, 'Private VALORANT bridge key generated');
    await syncValorantOcr();
    render();
    return;
  }
  const actions = {
    'toggle-live': () => commit(() => { game.match.live = !game.match.live; }, game.match.live ? 'Overlay taken off air' : 'Overlay is live'),
    'score-plus': () => commit(() => { game.teams[index].score = Math.min(seriesTarget(game, config), game.teams[index].score + 1); }),
    'score-minus': () => commit(() => { game.teams[index].score = Math.max(0, game.teams[index].score - 1); }),
    'detail-plus': () => commit(() => { game.teams[index].detailScore += 1; }),
    'detail-minus': () => commit(() => { game.teams[index].detailScore = Math.max(0, game.teams[index].detailScore - 1); }),
    'swap-teams': () => commit(() => {
      swapGameTeams(game);
      state.activeRosterSide = state.activeRosterSide === 'away' ? 'home' : 'away';
    }, 'Team sides swapped'),
    'reset-scores': () => commit(() => {
      game.teams.forEach((team) => { team.score = 0; team.detailScore = state.selectedGame === 'smash' ? 12 : 0; });
      if (state.selectedGame === 'valorant' || state.selectedGame === 'rocketleague') clearSeriesMapResults(game, state.selectedGame);
    }, 'Scores reset'),
    'next-match': () => {
      const nextIndex = (game.activeMap + 1) % visibleMapRows(game, config).length;
      commit(() => advanceGameMatch(game, state.selectedGame), `Advanced to ${state.selectedGame === 'rocketleague' || state.selectedGame === 'smash' ? 'game' : 'map'} ${nextIndex + 1}`);
    },
    'activate-map': () => commit(() => { game.activeMap = index; game.mapRows.forEach((row, i) => { if (row.winner === null) row.status = i === index ? 'ready' : 'upcoming'; }); }, `Map ${index + 1} active`),
    'map-winner': () => commit(() => {
      const winner = Number(button.dataset.winner);
      game.mapRows[index].winner = game.mapRows[index].winner === winner ? null : winner;
      game.mapRows[index].status = game.mapRows[index].winner === null ? 'ready' : 'complete';
      game.teams.forEach((team, teamIndex) => { team.score = visibleMapRows(game, config).filter((row) => row.winner === teamIndex).length; });
    }, 'Map result saved'),
    'clear-maps': () => commit(() => {
      clearSeriesMapResults(game, state.selectedGame);
      game.teams.forEach((team) => { team.score = 0; });
    }, 'Map results cleared'),
    'reset-veto': () => commit(() => {
      game.veto.bans = game.veto.bans.map(() => '');
      game.veto.picks = game.veto.picks.map((pick) => ({ ...pick, map: '', score: ['', ''], winner: null }));
      game.mapRows.forEach((row, i) => {
        row.map = '';
        row.score = ['', ''];
        row.overtime = false;
        row.overtimeSeconds = 0;
        row.winner = null;
        row.status = i === 0 ? 'ready' : 'upcoming';
      });
      game.activeMap = 0;
      game.teams.forEach((team) => { team.score = 0; });
    }, 'Veto map selections reset'),
    'add-player': () => commit(() => { const roster = activeRosterCollection(game)[state.activeRoster]; roster.push(createPlayer(config, roster.length)); }, 'Roster slot added'),
    'remove-player': () => commit(() => { activeRosterCollection(game)[state.activeRoster].splice(index, 1); }, 'Player removed'),
    'reset-game': () => {
      if (window.confirm(`Reset all saved ${config.name} data? This can be undone once.`)) commit(() => { state.games[state.selectedGame] = createGameState(state.selectedGame); }, 'Active game reset');
    },
    undo: () => {
      if (!history.length) return;
      state = history.pop();
      persistState();
      toast('Last change undone');
    }
  };
  actions[button.dataset.action]?.();
  render();
});

root.addEventListener('pointerdown', beginValorantRoiDrag);
window.addEventListener('pointermove', moveValorantRoiDrag);
window.addEventListener('pointerup', endValorantRoiDrag);
window.addEventListener('pointercancel', endValorantRoiDrag);
root.addEventListener('mousedown', beginValorantRoiDrag);
window.addEventListener('mousemove', moveValorantRoiDrag);
window.addEventListener('mouseup', endValorantRoiDrag);
window.addEventListener('blur', endValorantRoiDrag);
document.addEventListener('mouseleave', endValorantRoiDrag);

root.addEventListener('input', (event) => {
  const target = event.target;
  if (target.dataset.voRoi) positionValorantRoiBox(target.dataset.voRoi);
});

root.addEventListener('keydown', async (event) => {
  if (event.key === 'Escape' && valorantDebugFullscreen) {
    valorantDebugFullscreen = false;
    render();
    return;
  }
  const target = event.target;
  if (target?.dataset?.voManualName === undefined) return;
  if (event.key === 'Escape') {
    const side = target.dataset.side === 'away' ? 'away' : 'home';
    const row = Math.max(0, Math.min(4, Math.round(Number(target.dataset.row) || 0)));
    const currentName = state.games.valorant.valorantOcr.live?.observer3?.teams?.[side]?.players?.[row]?.name || '';
    target.value = currentName;
    target.blur();
    return;
  }
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const side = target.dataset.side === 'away' ? 'away' : 'home';
  const row = Math.max(0, Math.min(4, Math.round(Number(target.dataset.row) || 0)));
  const name = target.value.trim();
  if (!name) return;
  const snapshot = await window.isuDesktop?.setValorantObserverName?.({ side, row, name });
  if (snapshot) {
    const ocr = state.games.valorant.valorantOcr;
    ocr.live = {
      ...ocr.live,
      ...snapshot,
      fields: snapshot.fields || ocr.live.fields,
      metrics: snapshot.metrics || ocr.live.metrics,
      observer3: snapshot.observer3 || ocr.live.observer3
    };
  }
  target.blur();
  render();
});

root.addEventListener('change', async (event) => {
  const target = event.target;
  if (target.id === 'game-select') {
    state.selectedGame = target.value;
    persistState();
    syncRocketLeagueConnection();
    syncValorantOcr();
    render();
    return;
  }
  if (target.dataset.companionProp) {
    const prop = target.dataset.companionProp;
    companionSettings[prop] = target.type === 'checkbox' ? target.checked : prop === 'port' ? Number(target.value) : target.value.trim();
    if (prop === 'port') companionSettings.port = Math.max(1024, Math.min(65535, Math.round(companionSettings.port || 3176)));
    syncCompanionApi().then(() => {
      toast(companionStatus.listening ? 'Companion API settings saved' : companionSettings.enabled ? 'Companion API could not start' : 'Companion API disabled');
      render();
    });
    return;
  }
  if (target.dataset.outputDisplayProp) {
    const prop = target.dataset.outputDisplayProp;
    outputDisplaySettings[prop] = target.value;
    window.isuDesktop?.configureOutputDisplays(outputDisplaySettings).then((result) => {
      outputDisplays = result?.displays || outputDisplays;
      outputDisplaySettings = result?.settings || outputDisplaySettings;
      toast('Output display settings saved');
      render();
    });
    return;
  }
  if (target.dataset.programTransition !== undefined) {
    commit(() => {
      state.programTransitionSeconds = Math.max(0.1, Math.min(5, Number(target.value) || 1));
    }, 'Program transition saved');
    render();
    return;
  }
  if (target.dataset.rlProp) {
    const prop = target.dataset.rlProp;
    commit(() => {
      const rl = state.games.rocketleague.rocketLeague;
      rl[prop] = target.type === 'checkbox' ? target.checked : target.type === 'number' || prop === 'blueTeam' ? Number(target.value) : target.value;
      if (prop === 'updateIntervalMs') rl[prop] = Math.max(1, Math.min(50, Math.round(rl[prop] || 33)));
      if (prop === 'blueTeam') {
        applyRocketLeagueScores(state.games.rocketleague);
        if (rl.syncPlayers && rl.live.players.length) rl.live.players.sort((a, b) => mapRocketLeagueTeam(a.teamNum, rl) - mapRocketLeagueTeam(b.teamNum, rl));
      }
    }, 'Rocket League settings saved');
    if (prop === 'updateIntervalMs') window.isuDesktop?.setRocketLeagueUpdateInterval(state.games.rocketleague.rocketLeague.updateIntervalMs);
    else if (['enabled', 'source', 'transport', 'host', 'tcpPort', 'webPort', 'bridgePort', 'bridgeToken'].includes(prop)) syncRocketLeagueConnection();
    render();
    return;
  }
  if (target.dataset.voProp) {
    const prop = target.dataset.voProp;
    commit(() => {
      const ocr = state.games.valorant.valorantOcr;
      ocr[prop] = target.type === 'checkbox' ? target.checked : target.type === 'number' ? Number(target.value) : target.value.trim();
      if (prop === 'captureFps') ocr.captureFps = Math.max(1, Math.min(15, Math.round(ocr.captureFps || 8)));
      if (prop === 'observerScanIntervalMs') ocr.observerScanIntervalMs = Math.max(5, Math.min(100, Math.round(Number(target.value) || 25)));
      if (prop === 'profileId' && !VALORANT_OCR_PROFILE_CHOICES.some((choice) => choice.id === ocr.profileId)) ocr.profileId = DEFAULT_VALORANT_OCR_PROFILE_ID;
    }, 'VALORANT OCR settings saved');
    await syncValorantOcr();
    render();
    return;
  }
  if (target.dataset.voTemplate) {
    if (target.dataset.voTemplate === 'weapon') valorantLoadoutTemplateWeapon = target.value;
    if (target.dataset.voTemplate === 'side') valorantLoadoutTemplateSide = target.value === 'away' ? 'away' : 'home';
    if (target.dataset.voTemplate === 'row') valorantLoadoutTemplateRow = Math.max(0, Math.min(4, Math.round(Number(target.value) || 0)));
    render();
    return;
  }
  if (target.dataset.voRoi) {
    const fieldId = target.dataset.voRoi;
    const axis = target.dataset.voAxis;
    commit(() => {
      const ocr = state.games.valorant.valorantOcr;
      ocr.roiOverrides ||= {};
      const base = getValorantOcrProfile(ocr.profileId).fields[fieldId].roi;
      ocr.roiOverrides[fieldId] = { ...base, ...(ocr.roiOverrides[fieldId] || {}), [axis]: Math.max(axis === 'x' || axis === 'y' ? 0 : 1, Math.round(Number(target.value) || base[axis])) };
    }, 'OCR region updated');
    await syncValorantOcr();
    render();
    return;
  }
  if (target.dataset.formatLength !== undefined) {
    commit(() => syncFormat(current(), Number(target.value)), `Format set to Best of ${target.value}`);
    render();
    return;
  }
  if (target.dataset.field) {
    commit(() => updatePath(target.dataset.field, target.dataset.field === 'activeMap' ? Number(target.value) : target.value));
  }
  if (target.dataset.team !== undefined) {
    commit(() => {
      const team = current().teams[Number(target.dataset.team)];
      team[target.dataset.prop] = target.type === 'checkbox' ? target.checked : target.value;
      if (target.dataset.prop === 'logoImage') team.logoImageName = target.value ? 'Custom URL' : '';
    });
  }
  if (target.dataset.rosterFirstSide !== undefined) {
    commit(() => {
      current().rosterFirstSide = target.value === 'away' ? 'away' : 'home';
      state.activeRosterSide = current().rosterFirstSide;
    }, `${current().teams[target.value === 'away' ? 1 : 0].name} will show first on the roster overlay`);
    render();
    return;
  }
  if (target.dataset.awayRosterToggle !== undefined) {
    commit(() => {
      current().showAwayRoster = target.checked;
      if (!target.checked) state.activeRosterSide = current().rosterFirstSide === 'away' ? 'away' : 'home';
    }, target.checked ? 'Second roster enabled' : 'First-team-only roster enabled');
  }
  if (target.dataset.mapIndex !== undefined) {
    const rowIndex = Number(target.dataset.mapIndex);
    const row = current().mapRows[rowIndex];
    commit(() => {
      if (target.dataset.mapScore !== undefined) row.score[Number(target.dataset.mapScore)] = target.value;
      else {
        row[target.dataset.mapProp] = target.value;
        if (state.selectedGame === 'valorant' && target.dataset.mapProp === 'map' && current().veto?.picks?.[rowIndex]) current().veto.picks[rowIndex].map = target.value;
      }
    });
  }
  if (target.dataset.vetoBan !== undefined) {
    commit(() => { current().veto.bans[Number(target.dataset.vetoBan)] = target.value; });
  }
  if (target.dataset.vetoPick !== undefined) {
    commit(() => {
      const pickIndex = Number(target.dataset.vetoPick);
      const prop = target.dataset.vetoProp;
      const value = prop === 'attackers' ? Number(target.value) : target.value;
      current().veto.picks[pickIndex][prop] = value;
      if (state.selectedGame === 'valorant' && prop === 'map' && current().mapRows[pickIndex]) current().mapRows[pickIndex].map = value;
    });
  }
  if (target.dataset.player !== undefined) {
    commit(() => { activeRosterCollection()[state.activeRoster][Number(target.dataset.player)][target.dataset.playerProp] = target.value; });
  }
  render();
});

window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && history.length) {
    event.preventDefault();
    state = history.pop();
    persistState();
    render();
    toast('Last change undone');
  }
});

function initialize() {
  persistState();
  render();
  syncRocketLeagueConnection();
  syncValorantOcr();
  window.isuDesktop?.getValorantOcrInfo().then((info) => {
    const ocr = state.games.valorant.valorantOcr;
    if (info?.state) ocr.live = { ...ocr.live, ...info.state, fields: info.state.fields || ocr.live.fields, metrics: info.state.metrics || ocr.live.metrics };
    if (info?.status) ocr.live = { ...ocr.live, ...info.status, status: info.status.state || ocr.live.status };
    if (state.selectedGame === 'valorant' && state.activeView === 'control') render();
  });
  window.isuDesktop?.getCompanionStatus().then((status) => {
    companionStatus = status || companionStatus;
    if (state.activeView === 'settings') render();
  });
  window.isuDesktop?.getNetworkAddresses().then((addresses) => {
    networkAddresses = Array.isArray(addresses) ? addresses : [];
    if ((state.selectedGame === 'rocketleague' && state.activeView === 'control') || state.activeView === 'settings') render();
  });
  window.isuDesktop?.getOutputDisplays().then((result) => {
    outputDisplays = result?.displays || [];
    outputDisplaySettings = result?.settings || outputDisplaySettings;
    if (state.activeView === 'settings') render();
  });
}

initialize();

