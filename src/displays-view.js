// Controller "Displays" page.
//   1. Stations: each display client is in GAME MIRROR or NDI mode (one click each, or all).
//   2. Presets: what OBS draws on each station's NDI feed (ISU Stage NN).
//   3. OBS: connection + one-click setup of the 10 scenes / browser pages / NDI filters.
import { DISPLAY_PRESETS, ensureDisplayState } from './display-presets.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');

export function ensureDisplayView(state) { return ensureDisplayState(state); }

function noiseTitle(s) {
  if (!s.online) return 'Station offline: it starts as soon as the client connects';
  if (s.noiseError) return s.noiseError;
  return `${s.noiseState || 'off'}${s.noiseDevice ? ` · ${s.noiseDevice}` : ''} · ${s.noiseVolume ?? 30}%`;
}

function stationRows(state, displayStatus, obsStatus, numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
  const rows = new Map((displayStatus.stations || []).map((s) => [s.station, s]));
  const obs = new Map((obsStatus?.stations || []).map((s) => [s.station, s]));
  return numbers.map((n) => {
    const s = rows.get(n) || { station: n, online: false, mode: 'ndi', source: `ISU Stage ${pad(n)}` };
    const preset = state.displays.stations[n]?.preset || 'idle';
    const feed = obs.get(n);
    const health = !s.online ? 'offline' : s.error ? s.error : s.mode === 'mirror' ? 'mirroring' : s.state === 'receiving' ? `NDI ${s.fps || ''} fps`.trim() : s.state || 'connecting';
    const healthClass = !s.online ? 'off' : s.error ? 'bad' : (s.mode === 'mirror' || s.state === 'receiving') ? 'ok' : 'warn';
    return `<article class="disp-station" data-key="disp-${n}">
      <header><b>${pad(n)}</b><span>${esc(s.hostname || 'no client')}</span><i class="disp-dot ${healthClass}" title="${esc(health)}"></i></header>
      <small class="disp-health ${healthClass}">${esc(health)}</small>
      <div class="disp-modes">
        <button class="${s.mode === 'mirror' ? 'active' : ''}" data-action="display-mode" data-station="${n}" data-mode="mirror">GAME MIRROR</button>
        <button class="${s.mode === 'ndi' ? 'active' : ''}" data-action="display-mode" data-station="${n}" data-mode="ndi">NDI</button>
      </div>
      <button class="disp-noise-btn ${s.noise ? 'on' : ''}" data-action="display-noise" data-station="${n}" data-on="${s.noise ? 'off' : 'on'}" title="${esc(noiseTitle(s))}">${s.noise ? 'PINK NOISE ON' : 'PINK NOISE OFF'}${s.noise && s.online && s.noiseState !== 'playing' ? ' · !' : ''}</button>
      <label class="disp-preset"><span>NDI PRESET</span><select data-display-preset="${n}">${DISPLAY_PRESETS.map((p) => `<option value="${p.id}" ${p.id === preset ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></label>
      <small class="disp-feed ${feed ? (feed.active && feed.ndiOn ? 'ok' : 'bad') : ''}">${esc(s.source || `ISU Stage ${pad(n)}`)}${feed ? (feed.active && feed.ndiOn ? ' · OBS sending' : ' · OBS not sending') : ''}</small>
    </article>`;
  }).join('');
}

export function renderDisplaysView(state, { displayStatus = {}, obsDisplays = {} } = {}) {
  ensureDisplayState(state);
  // Typed-but-unsaved values win over the saved config, so live re-renders don't wipe them.
  const draft = obsDisplays.draft || {};
  const saved = obsDisplays.config || {};
  const cfg = { ...saved, ...draft };
  if (draft.format) [cfg.resolution, cfg.fps] = draft.format.split('@');
  const obs = obsDisplays.status || null;
  // Group control: each half (1-5, 6-10) can be a different match, so each has its own
  // mirror/NDI + preset buttons (e.g. one half stays on game mirror while the other shows player cards).
  const all = Array.from({ length: 10 }, (_v, i) => i + 1);
  const presetOf = (n) => state.displays.stations[n]?.preset || 'idle';
  const modeOf = (n) => (displayStatus.stations || []).find((s) => s.station === n)?.mode || 'ndi';
  const allSame = (list, fn, v) => list.every((n) => fn(n) === v);
  const presetButtons = (group, list) => DISPLAY_PRESETS.map((p) => `<button class="disp-preset-btn ${allSame(list, presetOf, p.id) ? 'active' : ''}" data-action="display-preset" data-station="${group}" data-preset="${p.id}" title="${esc(p.description)}"><b>${esc(p.label)}</b><small>${esc(p.description)}</small></button>`).join('');
  const modeButtons = (group, list, label) => `<button class="${allSame(list, modeOf, 'mirror') ? 'active' : ''}" data-action="display-mode" data-station="${group}" data-mode="mirror">${label}: GAME MIRROR</button><button class="${allSame(list, modeOf, 'ndi') ? 'active' : ''}" data-action="display-mode" data-station="${group}" data-mode="ndi">${label}: NDI</button>`;
  const noiseOf = (n) => Boolean((displayStatus.stations || []).find((s) => s.station === n)?.noise);
  const noiseButtons = (key, list, label) => `<div class="disp-noise-row"><span>PINK NOISE${label ? ` ${label}` : ''}</span><button class="${allSame(list, noiseOf, true) ? 'active on' : ''}" data-action="display-noise" data-station="${key}" data-on="on">ON</button><button class="${allSame(list, noiseOf, false) ? 'active' : ''}" data-action="display-noise" data-station="${key}" data-on="off">OFF</button></div>`;
  const group = (key, title, sub, list) => `<article class="panel disp-group" data-key="disp-group-${key}">
      <div class="disp-group-head"><div><h2>${title}</h2><p>${sub}</p></div><div class="disp-modes disp-group-modes">${modeButtons(key, list, key === '1-5' ? '1-5' : '6-10')}</div>${noiseButtons(key, list, '')}</div>
      <div class="disp-grid">${stationRows(state, displayStatus, obs, list)}</div>
      <div class="disp-preset-grid">${presetButtons(key, list)}</div>
    </article>`;
  const noiseVolume = Math.round(Number((displayStatus.stations || [])[0]?.noiseVolume ?? 30));
  const noisePlaying = (displayStatus.stations || []).filter((s) => s.online && s.noise && s.noiseState === 'playing').length;
  const obsSummary = obs ? `OBS ${esc(obs.resolution)} · ${esc(obs.fps)}/${esc(obs.targetFps)} fps · CPU ${esc(obs.cpu)}% · render ${esc(obs.renderMs)} ms · skipped ${esc(obs.skippedRender)}/${esc(obs.skippedOutput)} · ${obs.stations.filter((s) => s.active && s.ndiOn).length}/10 feeds live` : 'OBS not checked yet';
  return `<section class="view-stack displays-view">
    <div class="section-heading"><div><span class="section-number">01</span><div><h2>Stations</h2><p>${Number(displayStatus.onlineCount || 0)} of 10 display clients online · port ${Number(displayStatus.port || 3178)}${displayStatus.error ? ` · <b class="bad">${esc(displayStatus.error)}</b>` : ''}</p></div></div>
      <div class="heading-actions">
        <button class="secondary-button" data-action="display-mode" data-station="all" data-mode="mirror">ALL: GAME MIRROR</button>
        <button class="secondary-button" data-action="display-mode" data-station="all" data-mode="ndi">ALL: NDI</button>
      </div>
    </div>
    ${group('1-5', 'Stations 1-5', 'Game mirror or NDI preset for these five only', [1, 2, 3, 4, 5])}
    ${group('6-10', 'Stations 6-10', 'Game mirror or NDI preset for these five only', [6, 7, 8, 9, 10])}


    <article class="panel" data-key="disp-noise">
      <div class="panel-title"><span class="section-number">02</span><div><h2>Pink noise (player headsets)</h2><p>Players hear game + comms in their IEMs; the headset on top plays pink noise so they can't hear the room. Each display client plays it on the headset output picked in its settings (Ctrl+Alt+S), capped by that PC's max volume. Turn it on per station, per group above, or for everyone here.</p></div></div>
      <div class="disp-noise-all">
        ${noiseButtons('all', all, '· ALL 10')}
        <label class="field disp-noise-volume"><span>VOLUME (%)</span><input type="range" min="0" max="100" step="5" data-display-noise-volume value="${noiseVolume}"><b>${noiseVolume}%</b></label>
        <small>${noisePlaying} of 10 playing</small>
      </div>
    </article>

    <article class="panel" data-key="disp-presets">
      <div class="panel-title"><span class="section-number">03</span><div><h2>NDI presets (all 10 stations)</h2><p>What OBS draws on every <b>ISU Stage NN</b> feed. Pick per station or per group above, or for all here. Changes are instant: the pages update live, OBS never reloads.</p></div></div>
      <div class="disp-preset-grid">${presetButtons('all', all)}</div>
      <div class="disp-banner-teams"><span>Team banners:</span>
        <button data-action="display-preset" data-station="all" data-preset="banner" data-team="">AUTO (1-5 home · 6-10 away)</button>
        <button data-action="display-preset" data-station="all" data-preset="banner" data-team="home">ALL HOME</button>
        <button data-action="display-preset" data-station="all" data-preset="banner" data-team="away">ALL AWAY</button>
      </div>
    </article>

    <article class="panel" data-key="disp-obs">
      <div class="panel-title"><span class="section-number">04</span><div><h2>OBS (draws + sends the NDI feeds)</h2><p>Needs OBS 31.1+ with <b>DistroAV</b> and <b>Tools → WebSocket Server</b> on. SET UP OBS makes 10 scenes with a browser page each and a DistroAV NDI filter named <b>ISU Stage 01-10</b>. Run it again any time; it only adds what's missing.</p></div></div>
      <div class="obs-connect">
        <label class="field"><span>OBS PC</span><input data-obs-cfg="host" value="${esc(cfg.host || '127.0.0.1')}"></label>
        <label class="field"><span>PORT</span><input type="number" data-obs-cfg="port" value="${esc(cfg.port || 4455)}"></label>
        <label class="field"><span>PASSWORD</span><input type="password" data-obs-cfg="password" value="${esc(draft.password || '')}" placeholder="${saved.hasPassword ? 'saved · blank keeps it' : 'from OBS WebSocket settings'}" autocomplete="off"></label>
        <label class="field"><span>OUTPUT</span><select data-obs-cfg="format">${[['1280x720', 30], ['1280x720', 60], ['1920x1080', 30], ['1920x1080', 60]].map(([r, f]) => `<option value="${r}@${f}" ${(cfg.resolution || '1280x720') === r && (Number(cfg.fps) || 30) === f ? 'selected' : ''}>${r.replace('x', '×')} @ ${f}</option>`).join('')}</select></label>
        <label class="field"><span>CONTROLLER URL FOR OBS</span><input data-obs-cfg="controllerUrl" value="${esc(cfg.controllerUrl || '')}" placeholder="blank = this PC's LAN IP :3174"></label>
      </div>
      <div class="obs-actions">
        <button data-action="obs-displays-save">SAVE</button>
        <button class="primary" data-action="obs-displays-setup">SET UP OBS</button>
        <button data-action="obs-displays-check">CHECK OBS</button>
      </div>
      <p class="ow-ocr-status ${obsDisplays.error ? 'is-bad' : ''}">${esc(obsDisplays.error || obsDisplays.message || obsSummary)}</p>
    </article>

    <article class="panel" data-key="disp-key">
      <div class="panel-title compact"><div><h2>Display key</h2><p>Optional. If set, every display client must enter the same key in its settings (Ctrl+Alt+S on the station).</p></div></div>
      <div class="obs-actions"><input id="display-key-input" data-preserve type="password" autocomplete="off" placeholder="${displayStatus.keyRequired ? 'key set · type a new one or leave blank to clear' : 'no key (open)'}"><button data-action="display-key-save">SAVE KEY</button></div>
    </article>
  </section>`;
}
