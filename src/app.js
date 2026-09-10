import './styles.css';
import { GAME_CONFIGS, GAME_ORDER, createGameState, createPlayer } from './game-config.js';
import { deepClone, loadState, saveState } from './store.js';

const root = document.querySelector('#app');
let state = loadState();
const savedRocketLeagueConnection = window.isuDesktop?.savedRocketLeagueConnection;
if (savedRocketLeagueConnection && typeof savedRocketLeagueConnection === 'object') {
  state.games.rocketleague.rocketLeague = {
    ...state.games.rocketleague.rocketLeague,
    ...savedRocketLeagueConnection
  };
}
let history = [];
let saveTimer;
let livePublishTimer;
let lastUserScrollAt = 0;
let networkAddresses = [];
const overlayBaseUrl = window.isuDesktop?.overlayBaseUrl || 'http://127.0.0.1:3174';

const ROCKET_LEAGUE_ARENAS = {
  stadium: { name: 'DFH Stadium', image: './assets/rl-arenas/dfh-stadium.jpg' },
  stadium_p: { name: 'DFH Stadium', image: './assets/rl-arenas/dfh-stadium.jpg' },
  eurostadium_p: { name: 'Mannfield', image: './assets/rl-arenas/mannfield.jpg' },
  champsstadium_p: { name: 'Champions Field', image: './assets/rl-arenas/champions-field.jpg' },
  utopiastadium_p: { name: 'Utopia Coliseum', image: './assets/rl-arenas/utopia-coliseum.jpg' },
  park_p: { name: 'Beckwith Park', image: './assets/rl-arenas/beckwith-park.jpg' },
  chn_stadium_p: { name: 'Forbidden Temple', image: './assets/rl-arenas/forbidden-temple.jpg' },
  cs_day_p: { name: 'Deadeye Canyon', image: './assets/rl-arenas/deadeye-canyon.jpg' },
  neotokyo_p: { name: 'Neo Tokyo', image: './assets/rl-arenas/neo-tokyo.jpg' },
  labs_underpass_p: { name: 'Neo Tokyo', image: './assets/rl-arenas/neo-tokyo.jpg' },
  underwater_p: { name: 'AquaDome', image: './assets/rl-arenas/aquadome.jpg' }
};

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
  root.style.setProperty('--boost-transition-ms', `${Math.max(1, Math.min(50, Number(state.games.rocketleague.rocketLeague.updateIntervalMs) || 33))}ms`);
  root.innerHTML = `
    <div class="app-shell">
      ${renderSidebar(config)}
      <main class="workspace">
        ${renderTopbar(config)}
        <div class="content-scroll">${renderView(config)}</div>
      </main>
    </div>
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
      <div class="brand-footer">IDAHO STATE UNIVERSITY <b>•</b> POCATELLO</div>
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
  const nextMapIndex = (game.activeMap + 1) % game.mapRows.length;
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
            <div class="preview-center"><small>${escapeHtml(config.scoreLabel)}</small><b>${game.teams[0].score}<i>—</i>${game.teams[1].score}</b><span>${game.match.live ? 'LIVE' : 'PREVIEW'}</span></div>
            ${renderPreviewTeam(game.teams[1], 'right')}
          </div>
          <div class="preview-map"><span>${state.selectedGame === 'rocketleague' ? 'GAME' : 'MAP'} ${game.activeMap + 1}</span><strong>${escapeHtml(state.selectedGame === 'rocketleague' && rlLive?.arena ? rocketLeagueArenaMeta(rlLive.arena).name : activeMap.map)}</strong><i></i><em>${escapeHtml(state.selectedGame === 'rocketleague' && rlLive ? formatGameClock(rlLive.timeSeconds, rlLive.overtime) : activeMap.mode)}</em></div>
        </div>
        <div class="preview-label"><span></span>CONTROL PREVIEW · OVERLAY LAYOUT TO FOLLOW</div>
      </div>
      <div class="control-grid">
        ${renderTeamControl(game.teams[0], 0, config)}
        <div class="middle-controls">
          <button class="swap-button" data-action="swap-teams" title="Swap team sides">
            <svg viewBox="0 0 24 24"><path d="m7 7-4 4 4 4M3 11h14M17 17l4-4-4-4M21 13H7"/></svg>SWAP SIDES
          </button>
          <button class="reset-button" data-action="reset-scores">RESET SCORES</button>
          <button class="next-match-button" data-action="next-match"><span>NEXT MATCH</span><small>TO ${state.selectedGame === 'rocketleague' || state.selectedGame === 'smash' ? 'GAME' : 'MAP'} ${nextMapIndex + 1}</small></button>
        </div>
        ${renderTeamControl(game.teams[1], 1, config)}
      </div>
      ${state.selectedGame === 'rocketleague' ? renderRocketLeaguePanel(game) : ''}
      <div class="lower-grid">
        <article class="panel match-details">
          <div class="panel-title"><span class="section-number">02</span><div><h2>Match details</h2><p>Information shared across graphics</p></div></div>
          <div class="field-grid">
            ${field('Event / league', 'match.event', game.match.event)}
            ${field('Round / stage', 'match.round', game.match.round)}
            ${field('Series format', 'match.format', game.match.format)}
            <label class="field"><span>Active map</span><select data-field="activeMap">
              ${game.mapRows.map((row, index) => `<option value="${index}" ${index === game.activeMap ? 'selected' : ''}>${index + 1} — ${escapeHtml(row.map)}</option>`).join('')}
            </select></label>
          </div>
        </article>
        <article class="panel quick-score">
          <div class="panel-title compact"><div><h2>${detailLabel}</h2><p>Optional in-game value</p></div></div>
          <div class="detail-score-row">
            ${game.teams.map((team, index) => `<div><span>${escapeHtml(team.shortName)}</span><button data-action="detail-minus" data-index="${index}">−</button><b>${team.detailScore}</b><button data-action="detail-plus" data-index="${index}">+</button></div>`).join('')}
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

function normalizeRocketLeagueArenaId(value = '') {
  return String(value || '').trim().toLowerCase();
}

function rocketLeagueArenaMeta(value = '') {
  const id = normalizeRocketLeagueArenaId(value);
  const fallbackName = String(value || '').replace(/_P$/i, '').replaceAll('_', ' ') || 'Waiting for arena';
  return { id, name: ROCKET_LEAGUE_ARENAS[id]?.name || fallbackName, image: ROCKET_LEAGUE_ARENAS[id]?.image || '' };
}

function rocketLeagueArenaImage(row = {}) {
  if (row.arenaImage) return row.arenaImage;
  const rowName = normalizeRocketLeagueArenaId(row.map).replace(/[^a-z0-9]/g, '');
  const match = Object.values(ROCKET_LEAGUE_ARENAS).find((arena) => normalizeRocketLeagueArenaId(arena.name).replace(/[^a-z0-9]/g, '') === rowName);
  return match?.image || '';
}

function rocketLeaguePacketRate(intervalMs) {
  return Math.min(120, Math.max(1, Math.round(1000 / Math.max(1, Number(intervalMs) || 33))));
}

function renderRocketLeaguePanel(game) {
  const rl = game.rocketLeague;
  const live = rl.live;
  const sourceFields = rl.source === 'remote' ? `
    <label class="field"><span>RECEIVER PORT</span><input type="number" min="1" max="65535" data-rl-prop="bridgePort" value="${rl.bridgePort}"></label>
    <label class="field bridge-key-field"><span>BRIDGE KEY</span><input data-rl-prop="bridgeToken" value="${escapeHtml(rl.bridgeToken)}" placeholder="Generate a private key"><button data-action="generate-bridge-key">GENERATE</button><small>Graphics PC: ${escapeHtml(networkAddresses.join(' · ') || 'address unavailable')}</small></label>` : `
    <label class="field"><span>TRANSPORT</span><select data-rl-prop="transport"><option value="auto" ${rl.transport === 'auto' ? 'selected' : ''}>Automatic (WebSocket → TCP)</option><option value="websocket" ${rl.transport === 'websocket' ? 'selected' : ''}>WebSocket · 49124</option><option value="tcp" ${rl.transport === 'tcp' ? 'selected' : ''}>TCP · 49123</option></select></label>
    <label class="field"><span>ROCKET LEAGUE HOST</span><input data-rl-prop="host" value="${escapeHtml(rl.host)}"></label>
    <label class="field"><span>TCP PORT</span><input type="number" min="1" max="65535" data-rl-prop="tcpPort" value="${rl.tcpPort}"></label>
    <label class="field"><span>WEBSOCKET PORT</span><input type="number" min="1" max="65535" data-rl-prop="webPort" value="${rl.webPort}"></label>`;
  return `
    <article class="panel rl-live-panel">
      <header class="rl-panel-heading">
        <div><span>ROCKET LEAGUE STATS API</span><h2>Live game connection</h2><p>Official game telemetry · no BakkesMod required</p></div>
        <div class="rl-status ${escapeHtml(live.status)}"><i></i><span>${escapeHtml(live.status.toUpperCase())}</span><small>${escapeHtml(live.message)}</small></div>
      </header>
      <div class="rl-connection-grid">
        <label class="rl-enable-toggle"><input type="checkbox" data-rl-prop="enabled" ${rl.enabled ? 'checked' : ''}><i></i><span><b>LIVE DATA</b><small>${rl.enabled ? 'Enabled' : 'Disabled'}</small></span></label>
        <label class="field"><span>DATA SOURCE</span><select data-rl-prop="source"><option value="local" ${rl.source === 'local' ? 'selected' : ''}>This PC / direct</option><option value="remote" ${rl.source === 'remote' ? 'selected' : ''}>Game PC bridge</option></select></label>
        <label class="field"><span>BOOST UPDATE INTERVAL</span><input type="number" min="1" max="50" step="1" data-rl-prop="updateIntervalMs" value="${rl.updateIntervalMs}"><small>1–50 ms · game request ${rocketLeaguePacketRate(rl.updateIntervalMs)} updates/sec</small></label>
        ${sourceFields}
      </div>
      <div class="rl-toolbar">
        <button class="secondary-button" data-action="copy-rl-config">COPY GAME CONFIG</button>
        <button class="secondary-button" data-action="${live.status === 'simulating' ? 'stop-rl-simulator' : 'start-rl-simulator'}">${live.status === 'simulating' ? 'STOP TEST FEED' : 'RUN TEST FEED'}</button>
        <span>${live.lastPacketAt ? `LAST PACKET ${escapeHtml(new Date(live.lastPacketAt).toLocaleTimeString())}` : 'NO MATCH DATA RECEIVED'} · ${live.packets || 0} PACKETS · ${Number(live.packetRate || 0).toFixed(1)} PKT/S${rl.source === 'remote' ? ` · ${live.bridgeClients || 0} BRIDGE` : ''}</span>
      </div>
      <div class="rl-live-summary">
        <div><span>GAME CLOCK</span><strong>${formatGameClock(live.timeSeconds, live.overtime)}</strong></div>
        <div><span>ARENA</span><strong>${escapeHtml(live.arena || 'WAITING FOR MATCH')}</strong></div>
        <div><span>MATCH ID</span><strong title="${escapeHtml(live.matchGuid)}">${escapeHtml(live.matchGuid ? live.matchGuid.slice(0, 14) : '—')}</strong></div>
        <div><span>SPECTATING</span><strong>${escapeHtml(live.spectatedPlayer || '—')}</strong></div>
      </div>
      <div class="rl-settings-grid">
        <section><h3>TEAM MAPPING</h3><label class="field"><span>BLUE TEAM IS</span><select data-rl-prop="blueTeam"><option value="0" ${Number(rl.blueTeam) === 0 ? 'selected' : ''}>Home · ${escapeHtml(game.teams[0].shortName)}</option><option value="1" ${Number(rl.blueTeam) === 1 ? 'selected' : ''}>Away · ${escapeHtml(game.teams[1].shortName)}</option></select></label><p>Orange is assigned to the opposite side.</p></section>
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
  return `<div class="rl-player" style="--player-team:${escapeHtml(team.color)}"><header><span>${escapeHtml(team.shortName)}</span><strong>${escapeHtml(player.name)}</strong><small>${player.spectated ? 'ON CAMERA' : ''}</small></header><div class="boost-track"><i style="width:${boost ?? 0}%"></i></div><footer><b>${boost === null ? '—' : Math.round(boost)}</b><span>BOOST</span><em>${Number(player.goals) || 0} G · ${Number(player.assists) || 0} A · ${Number(player.saves) || 0} S</em></footer></div>`;
}

function renderPreviewTeam(team, side) {
  const secondary = team.secondaryColorEnabled ? team.secondaryColor : team.color;
  return `<div class="preview-team ${side}"><div class="team-badge" style="--team-color:${escapeHtml(team.color)};--team-secondary:${escapeHtml(secondary)}">${escapeHtml(team.shortName.slice(0, 3))}</div><div><small>${side === 'left' ? 'HOME' : 'AWAY'}</small><strong>${escapeHtml(team.name)}</strong></div></div>`;
}

function renderTeamControl(team, index, config) {
  return `<article class="team-control team-${index}">
    <div class="team-control-head"><span>${index === 0 ? 'HOME TEAM' : 'AWAY TEAM'}</span><i style="background:linear-gradient(90deg,${escapeHtml(team.color)} 0 55%,${escapeHtml(team.secondaryColorEnabled ? team.secondaryColor : team.color)} 55%)"></i></div>
    <div class="team-fields">
      <label><span>DISPLAY NAME</span><input data-team="${index}" data-prop="name" value="${escapeHtml(team.name)}" maxlength="32"></label>
      <label class="short-field"><span>ABBR.</span><input data-team="${index}" data-prop="shortName" value="${escapeHtml(team.shortName)}" maxlength="5"></label>
      <label class="color-field"><span>PRIMARY</span><input type="color" data-team="${index}" data-prop="color" value="${escapeHtml(team.color)}"></label>
      <label class="color-field secondary-color-field ${team.secondaryColorEnabled ? 'enabled' : ''}"><span>SECONDARY</span><input type="color" data-team="${index}" data-prop="secondaryColor" value="${escapeHtml(team.secondaryColor)}" ${team.secondaryColorEnabled ? '' : 'disabled'}></label>
      <label class="mini-switch"><input type="checkbox" data-team="${index}" data-prop="secondaryColorEnabled" ${team.secondaryColorEnabled ? 'checked' : ''}><i></i><span>USE</span></label>
    </div>
    <div class="score-control"><button data-action="score-minus" data-index="${index}" aria-label="Decrease ${escapeHtml(team.name)} score">−</button><div><span>${escapeHtml(config.scoreLabel)}</span><strong>${team.score}</strong><small>of ${config.maxScore}</small></div><button class="plus" data-action="score-plus" data-index="${index}" aria-label="Increase ${escapeHtml(team.name)} score">+</button></div>
  </article>`;
}

function field(label, path, value) {
  return `<label class="field"><span>${label}</span><input data-field="${path}" value="${escapeHtml(value)}" maxlength="60"></label>`;
}

function renderMaps(config) {
  const game = current();
  if (state.selectedGame === 'rocketleague') return renderRocketLeagueMaps(config, game);
  return `<section class="view-stack">
    <div class="section-heading"><div><span class="section-number">01</span><div><h2>Series map order</h2><p>${escapeHtml(config.format)} · select, score, and advance maps</p></div></div>
      <button class="secondary-button" data-action="clear-maps">Clear results</button>
    </div>
    <div class="map-summary">
      <div><span>SERIES</span><strong>${escapeHtml(game.teams[0].shortName)} ${game.teams[0].score} <i>—</i> ${game.teams[1].score} ${escapeHtml(game.teams[1].shortName)}</strong></div>
      <div><span>ACTIVE</span><strong>MAP ${game.activeMap + 1}</strong></div>
      <div><span>FORMAT</span><strong>${escapeHtml(game.match.format)}</strong></div>
    </div>
    ${state.selectedGame === 'valorant' ? renderValorantVetoEditor(config, game) : ''}
    <div class="map-list">
      ${game.mapRows.map((row, index) => renderMapRow(row, index, config, game)).join('')}
    </div>
    <div class="map-note"><span>LIVE OUTPUT</span> Changes on this page are sent to the Map Pool browser source immediately.</div>
  </section>`;
}

function renderRocketLeagueMaps(config, game) {
  const liveArena = rocketLeagueArenaMeta(game.rocketLeague?.live?.arena);
  const activeRow = game.mapRows[game.activeMap] || game.mapRows[0];
  return `<section class="view-stack">
    <div class="section-heading"><div><span class="section-number">01</span><div><h2>Rocket League series history</h2><p>${escapeHtml(config.format)} - arenas and scores populate from the live Stats API</p></div></div>
      <button class="secondary-button" data-action="clear-maps">Clear results</button>
    </div>
    <div class="map-summary">
      <div><span>SERIES</span><strong>${escapeHtml(game.teams[0].shortName)} ${game.teams[0].score} <i>-</i> ${game.teams[1].score} ${escapeHtml(game.teams[1].shortName)}</strong></div>
      <div><span>ACTIVE</span><strong>GAME ${game.activeMap + 1}</strong></div>
      <div><span>CURRENT ARENA</span><strong>${escapeHtml(activeRow?.map || liveArena.name)}</strong></div>
    </div>
    <div class="map-list rl-map-list">
      ${game.mapRows.map((row, index) => renderRocketLeagueMapRow(row, index, game)).join('')}
    </div>
    <div class="map-note"><span>API DRIVEN</span> Rocket League arenas and game scores update from live telemetry. Manual winner buttons are available for correction.</div>
  </section>`;
}

function renderRocketLeagueMapRow(row, index, game) {
  const isActive = index === game.activeMap;
  const scoreText = row.score?.some(Boolean) ? `${row.score[0] || '0'} - ${row.score[1] || '0'}` : isActive ? `${game.teams[0].detailScore || 0} - ${game.teams[1].detailScore || 0}` : 'Waiting';
  const image = rocketLeagueArenaImage(row);
  return `<article class="map-row rl-api-map-row ${isActive ? 'active' : ''} ${row.winner !== null ? 'complete' : ''}" style="${image ? `--arena-image:url('${escapeHtml(image)}')` : ''}">
    <button class="map-index" data-action="activate-map" data-index="${index}"><span>${isActive ? 'LIVE' : row.winner !== null ? 'FINAL' : 'GAME'}</span><strong>${String(index + 1).padStart(2, '0')}</strong></button>
    <div class="rl-map-art"></div>
    <div class="rl-map-copy"><span>${escapeHtml(row.mode || `Game ${index + 1}`)}</span><strong>${escapeHtml(row.map || 'Pending arena')}</strong><small>${escapeHtml(row.arenaId || '')}</small></div>
    <div class="map-score rl-api-score"><span>${escapeHtml(game.teams[0].shortName)}</span><b>${escapeHtml(scoreText)}</b><span>${escapeHtml(game.teams[1].shortName)}</span></div>
    <div class="winner-buttons"><button class="${row.winner === 0 ? 'selected' : ''}" data-action="map-winner" data-index="${index}" data-winner="0">${escapeHtml(game.teams[0].shortName)}</button><button class="${row.winner === 1 ? 'selected' : ''}" data-action="map-winner" data-index="${index}" data-winner="1">${escapeHtml(game.teams[1].shortName)}</button></div>
  </article>`;
}

function renderValorantVetoEditor(config, game) {
  const vetoOptions = (currentValue, slotType, slotIndex) => {
    const usedMaps = new Set([
      ...game.veto.bans.filter((_, index) => slotType !== 'ban' || index !== slotIndex),
      ...game.veto.picks.filter((_, index) => slotType !== 'pick' || index !== slotIndex).map((pick) => pick.map)
    ].filter(Boolean));
    const availableMaps = config.maps.filter((map) => map === currentValue || !usedMaps.has(map));
    return `<option value="" ${currentValue ? '' : 'selected'}>Select map…</option>${availableMaps.map((option) => `<option value="${escapeHtml(option)}" ${option === currentValue ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}`;
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
  return `<article class="map-row ${isActive ? 'active' : ''} ${row.winner !== null ? 'complete' : ''}">
    <button class="map-index" data-action="activate-map" data-index="${index}"><span>${isActive ? 'LIVE' : row.winner !== null ? 'FINAL' : 'MAP'}</span><strong>${String(index + 1).padStart(2, '0')}</strong></button>
    <label><span>MODE</span><select data-map-index="${index}" data-map-prop="mode">${config.modes.map((mode) => `<option ${mode === row.mode ? 'selected' : ''}>${escapeHtml(mode)}</option>`).join('')}</select></label>
    <label class="map-name"><span>MAP / STAGE</span><select data-map-index="${index}" data-map-prop="map">${config.maps.map((map) => `<option ${map === row.map ? 'selected' : ''}>${escapeHtml(map)}</option>`).join('')}</select></label>
    <div class="map-score"><span>${escapeHtml(game.teams[0].shortName)}</span><input data-map-index="${index}" data-map-score="0" value="${escapeHtml(row.score[0])}" inputmode="numeric" maxlength="3"><i>—</i><input data-map-index="${index}" data-map-score="1" value="${escapeHtml(row.score[1])}" inputmode="numeric" maxlength="3"><span>${escapeHtml(game.teams[1].shortName)}</span></div>
    <div class="winner-buttons"><button class="${row.winner === 0 ? 'selected' : ''}" data-action="map-winner" data-index="${index}" data-winner="0">${escapeHtml(game.teams[0].shortName)}</button><button class="${row.winner === 1 ? 'selected' : ''}" data-action="map-winner" data-index="${index}" data-winner="1">${escapeHtml(game.teams[1].shortName)}</button></div>
  </article>`;
}

function renderRosters(config) {
  const game = current();
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
        ${game.showAwayRoster ? `<button class="${state.activeRosterSide === 'away' ? 'active' : ''}" data-roster-side="away"><span>AWAY</span><strong>${escapeHtml(game.teams[1].name)}</strong></button>` : ''}
      </div>
      <label class="away-roster-toggle"><div><strong>Include away-team roster</strong><small>${game.showAwayRoster ? 'Overlay cycles Home → Away' : 'Overlay shows Home only'}</small></div><input type="checkbox" data-away-roster-toggle ${game.showAwayRoster ? 'checked' : ''}><i></i></label>
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
  const isRocketLeague = state.selectedGame === 'rocketleague';
  const selectedArt = game.characterArt[player.character] || {};
  const imageTile = (type, label, value, filename, character = '') => `<div class="roster-asset-tile">
    <div class="asset-thumb ${value ? 'has-image' : ''}">${value ? `<img src="${escapeHtml(value)}" alt="">` : `<span>${type === 'playerImage' ? 'PLAYER' : escapeHtml(config.characterLabel).toUpperCase()}</span>`}</div>
    <div><b>${label}</b><small>${escapeHtml(filename || (character ? `No ${character} artwork yet` : 'No image selected'))}</small><button data-action="pick-player-image" data-image-type="${type}" data-character="${escapeHtml(character)}" data-index="${index}" ${type === 'characterArtwork' && !character ? 'disabled' : ''}>${value ? 'REPLACE' : 'CHOOSE PNG'}</button>${value ? `<button class="clear-asset" data-action="clear-player-image" data-image-type="${type}" data-character="${escapeHtml(character)}" data-index="${index}">CLEAR</button>` : ''}</div>
  </div>`;
  return `<div class="player-entry">
    <div class="player-row">
      <span class="player-number">${String(index + 1).padStart(2, '0')}</span>
      <label><span>GAMERTAG</span><input data-player="${index}" data-player-prop="handle" value="${escapeHtml(player.handle)}" placeholder="Player tag" maxlength="24"></label>
      <label><span>PLAYER NAME</span><input data-player="${index}" data-player-prop="name" value="${escapeHtml(player.name)}" placeholder="First Last" maxlength="40"></label>
      <label><span>ROLE</span><select data-player="${index}" data-player-prop="role">${config.roles.map((role) => `<option ${player.role === role ? 'selected' : ''}>${escapeHtml(role)}</option>`).join('')}</select></label>
      <span class="starter-state ${index < config.rosterSize ? 'on' : ''}">${index < config.rosterSize ? 'STARTER' : 'RESERVE'}</span>
      <button class="remove-player" data-action="remove-player" data-index="${index}" title="Remove player">×</button>
    </div>
    <div class="player-media-row">
      ${imageTile('playerImage', 'Player portrait', player.playerImage, player.playerImageName)}
      <label class="character-field"><span>${escapeHtml(config.characterLabel).toUpperCase()} SELECTOR</span><select data-player="${index}" data-player-prop="character"><option value="">Select ${escapeHtml(config.characterLabel)}</option>${config.characters.map((character) => `<option value="${escapeHtml(character)}" ${player.character === character ? 'selected' : ''}>${escapeHtml(character)}</option>`).join('')}</select><small>${isRocketLeague ? 'Car PNG is unique to this player.' : `Artwork is shared across every ${escapeHtml(config.name)} roster.`}</small></label>
      ${isRocketLeague
        ? imageTile('characterImage', 'Player car PNG', player.characterImage, player.characterImageName)
        : imageTile('characterArtwork', `${config.characterLabel} artwork`, selectedArt.url, selectedArt.name, player.character)}
    </div>
  </div>`;
}

function renderOutputs() {
  const outputs = [
    { name: 'scoreboard', tag: 'SCORE', title: 'Main Scoreboard', description: 'Automatically changes design and labels with the selected game.' },
    { name: 'map-pool', tag: 'MAPS', title: 'Map Pool & Bans', description: 'Valorant veto cards plus game-aware series map layouts.' },
    { name: 'roster', tag: 'TEAM', title: 'Roster Screen', description: current().showAwayRoster ? 'Home and Away lineups cycle through player and character artwork.' : 'Home player portraits transition to character artwork after seven seconds.', query: { program: state.activeRoster } }
  ];
  const urlFor = (output) => {
    const url = new URL(`${overlayBaseUrl}/overlays/${output.name}.html`);
    for (const [key, value] of Object.entries(output.query || {})) url.searchParams.set(key, value);
    return url.toString();
  };
  return `<section class="view-stack">
    <div class="coming-banner live-output-banner"><div class="coming-icon">&lt;/&gt;</div><div><span>LOCAL OVERLAY SERVER</span><h2>OBS graphics are ready</h2><p>Keep this application open during the broadcast. Add each URL below as an OBS Browser Source at 1920 × 1080; every saved control change is pushed live.</p></div><strong><i></i>ONLINE · PORT 3174</strong></div>
    <div class="section-heading"><div><span class="section-number">01</span><div><h2>Browser-source outputs</h2><p>Transparent HTML graphics · current game: ${escapeHtml(GAME_CONFIGS[state.selectedGame].name)}</p></div></div></div>
    <div class="output-grid">${outputs.map((output) => `<article class="output-card"><div class="output-thumb"><span>${output.tag}</span><div class="ghost-score"><i></i><b>ISU</b><strong>${output.name === 'roster' ? 'PLAYER → HERO' : '0 — 0'}</strong><b>OPP</b><i></i></div></div><div class="output-info"><div><h3>${output.title}</h3><p>${output.description}</p></div><span>1920 × 1080</span></div><div class="output-url">${escapeHtml(urlFor(output))}</div><footer><span class="planned-dot online"></span>LIVE OUTPUT <button data-action="preview-overlay" data-overlay="${output.name}" data-query='${escapeHtml(JSON.stringify(output.query || {}))}'>PREVIEW</button><button data-action="copy-overlay-url" data-url="${escapeHtml(urlFor(output))}">COPY URL</button></footer></article>`).join('')}</div>
  </section>`;
}

function renderSettings() {
  return `<section class="view-stack settings-view">
    <div class="section-heading"><div><span class="section-number">01</span><div><h2>Workspace data</h2><p>Local-first settings for a dependable broadcast desk</p></div></div></div>
    <div class="settings-grid">
      <article class="panel setting-card"><div class="setting-icon">↻</div><div><h3>Reset active game</h3><p>Restore ${escapeHtml(GAME_CONFIGS[state.selectedGame].name)} match, map, and roster data to its defaults.</p></div><button class="danger-button" data-action="reset-game">RESET GAME</button></article>
      <article class="panel setting-card"><div class="setting-icon">✓</div><div><h3>Automatic local save</h3><p>All edits persist on this computer as soon as they are made. No account or network is required.</p></div><span class="setting-on">ENABLED</span></article>
      <article class="panel setting-card"><div class="setting-icon">i</div><div><h3>Application</h3><p>ISU Esports Broadcast Control · Rocket League live telemetry</p></div><span class="version-badge">v0.4.3</span></article>
    </div>
    <div class="brand-statement"><div class="brand-mark large"><span>IS</span><i></i></div><div><span>BUILT FOR</span><strong>IDAHO STATE ESPORTS</strong><p>Roarange. Bengal Black. Broadcast ready.</p></div></div>
  </section>`;
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

function scheduleLiveUpdate() {
  if (!livePublishTimer) {
    livePublishTimer = window.setTimeout(() => {
      livePublishTimer = null;
      window.isuDesktop?.publishState(state);
    }, Math.max(1, Math.min(50, Number(state.games.rocketleague.rocketLeague.updateIntervalMs) || 33)));
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

function updateRocketLeagueActiveMap(game) {
  const rl = game.rocketLeague;
  const row = game.mapRows[game.activeMap];
  if (!row) return;
  const arena = rocketLeagueArenaMeta(rl.live.arena);
  row.mode = `Game ${game.activeMap + 1}`;
  if (arena.id) row.arenaId = arena.id;
  if (arena.name && arena.name !== 'Waiting for arena') row.map = arena.name;
  if (arena.image) row.arenaImage = arena.image;
  row.status = 'ready';
  row.score = [String(game.teams[0].detailScore || 0), String(game.teams[1].detailScore || 0)];
}

function rocketLeaguePlayerId(player) {
  const primaryId = String(player.PrimaryId || '').trim();
  if (primaryId && primaryId !== 'Unknown|0|0') return primaryId;
  return `${player.TeamNum}|${player.Shortcut}|${player.Name}`;
}

function normalizeLivePlayers(data, rl) {
  const target = data.Game?.Target?.Name || '';
  const playersById = new Map();
  (data.Players || []).forEach((player) => {
    const id = rocketLeaguePlayerId(player);
    playersById.set(id, {
      id,
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
    });
  });
  return [...playersById.values()].sort((a, b) => mapRocketLeagueTeam(a.teamNum, rl) - mapRocketLeagueTeam(b.teamNum, rl));
}

function handleRocketLeagueEvent(envelope) {
  const game = state.games.rocketleague;
  const rl = game.rocketLeague;
  const data = envelope?.Data || {};
  if (envelope?.Event === 'UpdateState') {
    const gameData = data.Game || {};
    rl.live.matchGuid = data.MatchGuid || rl.live.matchGuid;
    if (rl.syncClock) {
      rl.live.timeSeconds = Number(gameData.TimeSeconds ?? rl.live.timeSeconds);
      rl.live.overtime = Boolean(gameData.bOvertime);
    }
    rl.live.arena = gameData.Arena || rl.live.arena;
    rl.live.spectatedPlayer = gameData.Target?.Name || '';
    rl.live.teamScores = (gameData.Teams || []).reduce((scores, team) => {
      scores[Number(team.TeamNum)] = Number(team.Score) || 0;
      return scores;
    }, rl.live.teamScores || [0, 0]);
    applyRocketLeagueScores(game);
    updateRocketLeagueActiveMap(game);
    if (rl.syncPlayers) rl.live.players = normalizeLivePlayers(data, rl);
    scheduleLiveUpdate();
    return;
  }
  if (envelope?.Event === 'ClockUpdatedSeconds' && rl.syncClock) {
    rl.live.matchGuid = data.MatchGuid || rl.live.matchGuid;
    rl.live.timeSeconds = Number(data.TimeSeconds ?? rl.live.timeSeconds);
    rl.live.overtime = Boolean(data.bOvertime);
    scheduleLiveUpdate();
    return;
  }
  if (envelope?.Event === 'MatchCreated') {
    rl.live.matchGuid = data.MatchGuid || '';
    rl.live.timeSeconds = 300;
    rl.live.overtime = false;
    rl.live.players = [];
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
      activeRow.winner = winner;
      activeRow.status = 'complete';
      activeRow.score = [String(game.teams[0].detailScore), String(game.teams[1].detailScore)];
    }
    if (rl.autoSeriesScore) game.teams[winner].score = Math.min(GAME_CONFIGS.rocketleague.maxScore, game.teams[winner].score + 1);
  }, `${game.teams[winner].shortName} game win received`);
  persistState();
  render();
  if (rl.autoAdvance && Math.max(...game.teams.map((team) => team.score)) < GAME_CONFIGS.rocketleague.maxScore) {
    window.setTimeout(() => {
      const nextIndex = Math.min(game.activeMap + 1, game.mapRows.length - 1);
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
  if (button.dataset.action === 'preview-overlay') {
    let query = {};
    try { query = JSON.parse(button.dataset.query || '{}'); } catch {}
    window.isuDesktop?.openOverlayPreview({ name: button.dataset.overlay, query });
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
  const actions = {
    'toggle-live': () => commit(() => { game.match.live = !game.match.live; }, game.match.live ? 'Overlay taken off air' : 'Overlay is live'),
    'score-plus': () => commit(() => { game.teams[index].score = Math.min(config.maxScore, game.teams[index].score + 1); }),
    'score-minus': () => commit(() => { game.teams[index].score = Math.max(0, game.teams[index].score - 1); }),
    'detail-plus': () => commit(() => { game.teams[index].detailScore += 1; }),
    'detail-minus': () => commit(() => { game.teams[index].detailScore = Math.max(0, game.teams[index].detailScore - 1); }),
    'swap-teams': () => commit(() => {
      game.teams.reverse();
      [game.rosters, game.awayRosters] = [game.awayRosters, game.rosters];
      game.mapRows.forEach((row) => { row.score.reverse(); if (row.winner !== null) row.winner = row.winner === 0 ? 1 : 0; });
      game.veto?.picks?.forEach((pick) => { pick.attackers = Number(pick.attackers) === 0 ? 1 : 0; });
    }, 'Team sides swapped'),
    'reset-scores': () => commit(() => { game.teams.forEach((team) => { team.score = 0; team.detailScore = 0; }); }, 'Scores reset'),
    'next-match': () => {
      const nextIndex = (game.activeMap + 1) % game.mapRows.length;
      commit(() => {
        game.activeMap = nextIndex;
        game.teams.forEach((team) => { team.detailScore = 0; });
        game.mapRows.forEach((row, rowIndex) => {
          row.status = row.winner !== null ? 'complete' : (rowIndex === nextIndex ? 'ready' : 'upcoming');
        });
      }, `Advanced to ${state.selectedGame === 'rocketleague' || state.selectedGame === 'smash' ? 'game' : 'map'} ${nextIndex + 1}`);
    },
    'activate-map': () => commit(() => { game.activeMap = index; game.mapRows.forEach((row, i) => { if (row.winner === null) row.status = i === index ? 'ready' : 'upcoming'; }); }, `Map ${index + 1} active`),
    'map-winner': () => commit(() => {
      const winner = Number(button.dataset.winner);
      game.mapRows[index].winner = game.mapRows[index].winner === winner ? null : winner;
      game.mapRows[index].status = game.mapRows[index].winner === null ? 'ready' : 'complete';
      game.teams.forEach((team, teamIndex) => { team.score = game.mapRows.filter((row) => row.winner === teamIndex).length; });
    }, 'Map result saved'),
    'clear-maps': () => commit(() => {
      game.mapRows.forEach((row, i) => {
        row.winner = null;
        row.score = ['', ''];
        row.status = i === 0 ? 'ready' : 'upcoming';
        if (state.selectedGame === 'rocketleague') {
          row.map = '';
          row.arenaId = '';
          row.arenaImage = '';
          row.mode = `Game ${i + 1}`;
        }
      });
      game.teams.forEach((team) => { team.score = 0; team.detailScore = 0; });
      game.activeMap = 0;
    }, 'Map results cleared'),
    'reset-veto': () => commit(() => {
      game.veto.bans = game.veto.bans.map(() => '');
      game.veto.picks = game.veto.picks.map((pick) => ({ ...pick, map: '', score: ['', ''], winner: null }));
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

root.addEventListener('change', (event) => {
  const target = event.target;
  if (target.id === 'game-select') {
    state.selectedGame = target.value;
    persistState();
    syncRocketLeagueConnection();
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
  if (target.dataset.field) {
    commit(() => updatePath(target.dataset.field, target.dataset.field === 'activeMap' ? Number(target.value) : target.value));
  }
  if (target.dataset.team !== undefined) {
    commit(() => { current().teams[Number(target.dataset.team)][target.dataset.prop] = target.type === 'checkbox' ? target.checked : target.value; });
  }
  if (target.dataset.awayRosterToggle !== undefined) {
    commit(() => {
      current().showAwayRoster = target.checked;
      if (!target.checked) state.activeRosterSide = 'home';
    }, target.checked ? 'Away roster enabled' : 'Home-only roster enabled');
  }
  if (target.dataset.mapIndex !== undefined) {
    const row = current().mapRows[Number(target.dataset.mapIndex)];
    commit(() => {
      if (target.dataset.mapScore !== undefined) row.score[Number(target.dataset.mapScore)] = target.value;
      else row[target.dataset.mapProp] = target.value;
    });
  }
  if (target.dataset.vetoBan !== undefined) {
    commit(() => { current().veto.bans[Number(target.dataset.vetoBan)] = target.value; });
  }
  if (target.dataset.vetoPick !== undefined) {
    commit(() => {
      current().veto.picks[Number(target.dataset.vetoPick)][target.dataset.vetoProp] = target.dataset.vetoProp === 'attackers' ? Number(target.value) : target.value;
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
  window.isuDesktop?.getNetworkAddresses().then((addresses) => {
    networkAddresses = Array.isArray(addresses) ? addresses : [];
    if (state.selectedGame === 'rocketleague' && state.activeView === 'control') render();
  });
}

initialize();
