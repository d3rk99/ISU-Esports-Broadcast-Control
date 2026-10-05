// Controller panel for the Overwatch scoreboard OCR (Observer 3 keeps Tab open). The service
// runs in the main process; this file renders its settings/status and the live player table,
// and merges OCR snapshots into state.games.overwatch.overwatchOcr.live for the overlays.

export const OW_OCR_STATS = [
  ['ultimate', 'ULT'], ['elims', 'E'], ['assists', 'A'], ['deaths', 'D'],
  ['damage', 'DMG'], ['healing', 'HEAL'], ['mitigation', 'MIT']
];

export function emptyOverwatchOcr() {
  return { settings: { enabled: false, windowName: 'Overwatch', intervalMs: 500 }, status: { state: 'disabled', message: 'Overwatch OCR is off' }, live: null };
}

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const show = (value) => (value === null || value === undefined || value === '' ? '–' : value === 'READY' ? 'RDY' : value);

export function renderOverwatchOcrPanel(ocr = emptyOverwatchOcr(), teams = []) {
  const s = ocr.settings || {};
  const status = ocr.status || {};
  const tone = status.state === 'reading' ? 'ok' : status.state === 'error' || status.state === 'no-board' ? 'bad' : 'idle';
  const table = ['home', 'away'].map((side, t) => {
    const players = ocr.live?.teams?.[side]?.players || [];
    const rows = Array.from({ length: 5 }, (_v, i) => {
      const p = players[i] || {};
      return `<tr><td>${i + 1}</td><td class="ow-ocr-name">${esc(p.name || '')}</td>${OW_OCR_STATS.map(([k]) => `<td>${esc(show(p[k]))}</td>`).join('')}</tr>`;
    }).join('');
    return `<table class="ow-ocr-table"><caption>${esc(teams[t]?.shortName || side.toUpperCase())} · ${t === 0 ? 'top' : 'bottom'} of the board</caption>
      <thead><tr><th>#</th><th>PLAYER</th>${OW_OCR_STATS.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
  }).join('');
  return `<article class="panel ow-ocr-panel" data-key="ow-ocr-panel">
    <div class="panel-title"><span class="section-number">OCR</span><div><h2>Overwatch scoreboard OCR</h2><p>Observer 3 keeps the Tab scoreboard open; stats are read from it. Map score stays manual (Companion).</p></div></div>
    <div class="ow-ocr-controls">
      <label class="rl-enable-toggle"><input type="checkbox" data-ow-ocr="enabled" ${s.enabled ? 'checked' : ''}><i></i><span><b>READ SCOREBOARD</b><small>Off by default; turn on when Observer 3 is on the board</small></span></label>
      <label class="field"><span>WINDOW TITLE CONTAINS</span><input data-ow-ocr="windowName" value="${esc(s.windowName || 'Overwatch')}"></label>
      <label class="field"><span>READ EVERY (MS)</span><input type="number" min="200" max="5000" step="50" data-ow-ocr="intervalMs" value="${Number(s.intervalMs) || 500}"></label>
      <label class="field"><span>CPU CORES (OCR WORKERS)</span><input type="number" min="1" max="16" step="1" data-ow-ocr="workers" value="${Number(s.workers) || 4}"><small>More = faster reads; default is half your cores</small></label>
      <div class="ow-ocr-buttons"><button data-action="ow-ocr-test">TEST READ</button><button data-action="ow-ocr-clear" data-confirm="Clear?">CLEAR</button></div>
    </div>
    <p class="ow-ocr-status is-${tone}">${esc((status.state || 'disabled').toUpperCase())} · ${esc(status.message || '')}${status.sweepMs ? ` · ${status.sweepMs} ms per read` : ''}</p>
    <div class="ow-ocr-tables">${table}</div>
  </article>`;
}

// Merge a snapshot from the service into the controller state (only what overlays need).
export function mergeOverwatchOcrSnapshot(ocr, snapshot) {
  if (!snapshot?.teams) return ocr;
  const strip = (players = []) => players.map(({ side, slot, name, ultimate, elims, assists, deaths, damage, healing, mitigation }) => ({ side, slot, name, ultimate, elims, assists, deaths, damage, healing, mitigation }));
  return { ...ocr, live: { teams: { home: { players: strip(snapshot.teams.home?.players) }, away: { players: strip(snapshot.teams.away?.players) } }, updatedAt: snapshot.updatedAt || Date.now() }, status: snapshot.status || ocr.status };
}
