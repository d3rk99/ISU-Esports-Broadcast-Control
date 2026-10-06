// Controller "Displays" page.
//   1. Stations: each display client is in GAME MIRROR or NDI mode (one click each, or all).
//   2. Presets: what OBS draws on each station's NDI feed (ISU Stage NN).
//   3. OBS: connection + one-click setup of the 10 scenes / browser pages / NDI filters.
import { DISPLAY_PRESETS, ensureDisplayState } from './display-presets.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');

export function ensureDisplayView(state) { return ensureDisplayState(state); }

function stationRows(state, displayStatus, obsStatus) {
  const rows = new Map((displayStatus.stations || []).map((s) => [s.station, s]));
  const obs = new Map((obsStatus?.stations || []).map((s) => [s.station, s]));
  return Array.from({ length: 10 }, (_v, i) => {
    const n = i + 1; const s = rows.get(n) || { station: n, online: false, mode: 'ndi', source: `ISU Stage ${pad(n)}` };
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
      <label class="disp-preset"><span>NDI PRESET</span><select data-display-preset="${n}">${DISPLAY_PRESETS.map((p) => `<option value="${p.id}" ${p.id === preset ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></label>
      <small class="disp-feed ${feed ? (feed.active && feed.ndiOn ? 'ok' : 'bad') : ''}">${esc(s.source || `ISU Stage ${pad(n)}`)}${feed ? (feed.active && feed.ndiOn ? ' · OBS sending' : ' · OBS not sending') : ''}</small>
    </article>`;
  }).join('');
}

export function renderDisplaysView(state, { displayStatus = {}, obsDisplays = {} } = {}) {
  ensureDisplayState(state);
  const cfg = obsDisplays.config || {};
  const obs = obsDisplays.status || null;
  const counts = DISPLAY_PRESETS.map((p) => [p.id, Object.values(state.displays.stations).filter((s) => s.preset === p.id).length]);
  const presetButtons = DISPLAY_PRESETS.map((p) => `<button class="disp-preset-btn ${counts.find(([id]) => id === p.id)[1] === 10 ? 'active' : ''}" data-action="display-preset" data-station="all" data-preset="${p.id}" title="${esc(p.description)}"><b>${esc(p.label)}</b><small>${esc(p.description)}</small></button>`).join('');
  const obsSummary = obs ? `OBS ${esc(obs.resolution)} · ${esc(obs.fps)}/${esc(obs.targetFps)} fps · CPU ${esc(obs.cpu)}% · render ${esc(obs.renderMs)} ms · skipped ${esc(obs.skippedRender)}/${esc(obs.skippedOutput)} · ${obs.stations.filter((s) => s.active && s.ndiOn).length}/10 feeds live` : 'OBS not checked yet';
  return `<section class="view-stack displays-view">
    <div class="section-heading"><div><span class="section-number">01</span><div><h2>Stations</h2><p>${Number(displayStatus.onlineCount || 0)} of 10 display clients online · port ${Number(displayStatus.port || 3178)}${displayStatus.error ? ` · <b class="bad">${esc(displayStatus.error)}</b>` : ''}</p></div></div>
      <div class="heading-actions">
        <button class="secondary-button" data-action="display-mode" data-station="all" data-mode="mirror">ALL: GAME MIRROR</button>
        <button class="secondary-button" data-action="display-mode" data-station="all" data-mode="ndi">ALL: NDI</button>
      </div>
    </div>
    <div class="disp-grid">${stationRows(state, displayStatus, obs)}</div>

    <article class="panel" data-key="disp-presets">
      <div class="panel-title"><span class="section-number">02</span><div><h2>NDI presets (all stations)</h2><p>What OBS draws on every <b>ISU Stage NN</b> feed. Pick per station above, or for all here. Changes are instant: the pages update live, OBS never reloads.</p></div></div>
      <div class="disp-preset-grid">${presetButtons}</div>
      <div class="disp-banner-teams"><span>Team banners:</span>
        <button data-action="display-preset" data-station="all" data-preset="banner" data-team="">AUTO (1-5 home · 6-10 away)</button>
        <button data-action="display-preset" data-station="all" data-preset="banner" data-team="home">ALL HOME</button>
        <button data-action="display-preset" data-station="all" data-preset="banner" data-team="away">ALL AWAY</button>
      </div>
    </article>

    <article class="panel" data-key="disp-obs">
      <div class="panel-title"><span class="section-number">03</span><div><h2>OBS (draws + sends the NDI feeds)</h2><p>Needs OBS 31.1+ with <b>DistroAV</b> and <b>Tools → WebSocket Server</b> on. SET UP OBS makes 10 scenes with a browser page each and a DistroAV NDI filter named <b>ISU Stage 01-10</b>. Run it again any time; it only adds what's missing.</p></div></div>
      <div class="obs-connect">
        <label class="field"><span>OBS PC</span><input data-obs-cfg="host" value="${esc(cfg.host || '127.0.0.1')}"></label>
        <label class="field"><span>PORT</span><input type="number" data-obs-cfg="port" value="${esc(cfg.port || 4455)}"></label>
        <label class="field"><span>PASSWORD</span><input type="password" data-obs-cfg="password" placeholder="${cfg.hasPassword ? 'saved · blank keeps it' : 'from OBS WebSocket settings'}" autocomplete="off"></label>
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
      <div class="obs-actions"><input id="display-key-input" type="password" autocomplete="off" placeholder="${displayStatus.keyRequired ? 'key set · type a new one or leave blank to clear' : 'no key (open)'}"><button data-action="display-key-save">SAVE KEY</button></div>
    </article>
  </section>`;
}
