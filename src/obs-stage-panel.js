// Stage displays through OBS: the controller tells each station page what to show
// (state.stageObs.stations[N].mode), OBS draws the 10 pages and sends NDI "ISU Stage NN".
export const OBS_STAGE_MODES = [
  ['hold', 'Hold'], ['intro', 'Team intro'], ['player', 'Player'], ['score', 'Score'], ['blackout', 'Black']
];

export function ensureStageObsState(state) {
  if (!state.stageObs || typeof state.stageObs !== 'object') state.stageObs = { stations: {} };
  if (!state.stageObs.stations || typeof state.stageObs.stations !== 'object') state.stageObs.stations = {};
  for (let n = 1; n <= 10; n += 1) {
    const entry = state.stageObs.stations[n];
    if (!entry || !OBS_STAGE_MODES.some(([m]) => m === entry.mode)) state.stageObs.stations[n] = { mode: 'hold' };
  }
  return state.stageObs;
}

export function setStageObsMode(state, station, mode) {
  ensureStageObsState(state);
  if (!OBS_STAGE_MODES.some(([m]) => m === mode)) throw new Error(`Unknown stage mode: ${mode}`);
  const targets = station === 'all' ? Array.from({ length: 10 }, (_v, i) => i + 1) : [Math.round(Number(station))];
  for (const n of targets) if (n >= 1 && n <= 10) state.stageObs.stations[n] = { mode };
  return targets;
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderObsStagePanel(state, obs = {}) {
  ensureStageObsState(state);
  const cfg = obs.config || {};
  const live = obs.status || null;
  const liveByStation = new Map((live?.stations || []).map((s) => [s.station, s]));
  const modeButtons = (station) => OBS_STAGE_MODES.map(([m, label]) => {
    const on = station !== 'all' && state.stageObs.stations[station]?.mode === m;
    return `<button class="${on ? 'active' : ''}" data-action="obs-stage-mode" data-obs-station="${station}" data-obs-mode="${m}">${label}</button>`;
  }).join('');
  const rows = Array.from({ length: 10 }, (_v, i) => {
    const n = i + 1; const s = liveByStation.get(n);
    const health = !live ? '' : s?.active && s?.ndiOn ? 'NDI live' : s ? (s.ndiOn ? 'not showing' : 'NDI off') : '';
    return `<div class="obs-stage-row"><b>${String(n).padStart(2, '0')}</b><span class="obs-stage-ndi ${health === 'NDI live' ? 'ok' : health ? 'bad' : ''}">ISU Stage ${String(n).padStart(2, '0')}${health ? ` · ${esc(health)}` : ''}</span><div class="obs-stage-modes">${modeButtons(n)}</div></div>`;
  }).join('');
  const summary = live ? `OBS ${esc(live.resolution)} · ${esc(live.fps)}/${esc(live.targetFps)} fps · CPU ${esc(live.cpu)}% · render ${esc(live.renderMs)} ms · skipped ${esc(live.skippedRender)}/${esc(live.skippedOutput)}` : 'Not checked yet';
  return `<article class="panel obs-stage-panel" data-key="obs-stage-panel">
    <div class="panel-title"><span class="section-number">OBS</span><div><h2>Stage displays through OBS (NDI)</h2><p>OBS draws each station page on the GPU and sends <b>ISU Stage 01-10</b> over NDI (DistroAV). Set a station to <b>Stage NDI</b> on the display client to show it. Mode changes here are instant; OBS doesn't reload.</p></div></div>
    <div class="obs-stage-connect">
      <label class="field"><span>OBS PC</span><input data-obs-cfg="host" value="${esc(cfg.host || '127.0.0.1')}"></label>
      <label class="field"><span>WEBSOCKET PORT</span><input type="number" data-obs-cfg="port" value="${esc(cfg.port || 4455)}"></label>
      <label class="field"><span>PASSWORD</span><input type="password" data-obs-cfg="password" placeholder="${cfg.hasPassword ? 'saved · blank keeps it' : 'Tools → WebSocket Server Settings'}" autocomplete="off"></label>
      <label class="field"><span>OUTPUT</span><select data-obs-cfg="format">${[['1280x720', 30], ['1280x720', 60], ['1920x1080', 30], ['1920x1080', 60]].map(([r, f]) => `<option value="${r}@${f}" ${cfg.resolution === r && Number(cfg.fps) === f ? 'selected' : ''}>${r.replace('x', '×')} @ ${f}</option>`).join('')}</select></label>
      <label class="field"><span>CONTROLLER URL FOR OBS</span><input data-obs-cfg="controllerUrl" value="${esc(cfg.controllerUrl || '')}" placeholder="blank = this PC's LAN address :3174"></label>
    </div>
    <div class="obs-stage-actions">
      <button data-action="obs-stage-save">SAVE</button>
      <button class="primary" data-action="obs-stage-setup">SET UP OBS</button>
      <button data-action="obs-stage-check">CHECK OBS</button>
    </div>
    <p class="ow-ocr-status ${obs.error ? 'is-bad' : ''}">${esc(obs.error || obs.message || summary)}</p>
    <div class="obs-stage-row obs-stage-all"><b>ALL</b><span>Every station</span><div class="obs-stage-modes">${modeButtons('all')}</div></div>
    <div class="obs-stage-rows">${rows}</div>
  </article>`;
}
