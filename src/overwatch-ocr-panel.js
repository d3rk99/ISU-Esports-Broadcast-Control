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

const FIELD_LABEL = { name: 'NAME', ultimate: 'ULT', elims: 'E', assists: 'A', deaths: 'D', damage: 'DMG', healing: 'HEAL', mitigation: 'MIT' };

// Debug capture: the full captured frame with every box drawn on it (green = accepted,
// red = rejected), and per cell the raw crop, the black/white image the OCR reads, the raw
// OCR text + confidence, the digit count measured from the pixels and the accepted value.
export function renderOverwatchDebugCapture(debug) {
  if (!debug) return '';
  const pct = (v, total) => `${((v / total) * 100).toFixed(3)}%`;
  const boxes = debug.cells.map((c) => `<i class="ow-dbg-box ${c.accepted === null ? 'bad' : 'ok'}" title="${esc(`${c.side}${c.row + 1} ${FIELD_LABEL[c.field]}: ${c.text}`)}" style="left:${pct(c.roi.x, 1920)};top:${pct(c.roi.y, 1080)};width:${pct(c.roi.w, 1920)};height:${pct(c.roi.h, 1080)}"></i>`).join('');
  const cell = (c) => `<div class="ow-dbg-cell ${c.accepted === null ? 'bad' : 'ok'}">
      <span>${esc(c.side === 'home' ? 'TOP' : 'BOT')} ${c.row + 1} · ${FIELD_LABEL[c.field]}</span>
      ${c.rawDataUrl ? `<img src="${esc(c.rawDataUrl)}" alt="">` : ''}${c.processedDataUrl ? `<img class="proc" src="${esc(c.processedDataUrl)}" alt="">` : ''}
      <small>read “${esc(c.text)}” ${c.confidence}%${c.glyphs === null ? '' : ` · ${c.glyphs} digit${c.glyphs === 1 ? '' : 's'} seen`} → <b>${esc(c.accepted === null ? 'rejected' : c.accepted)}</b></small>
    </div>`;
  const age = Math.max(0, Math.round((Date.now() - Number(debug.capturedAt || Date.now())) / 1000));
  return `<div class="ow-dbg">
    <p class="ow-ocr-status">DEBUG CAPTURE · ${age}s old · ${esc(debug.sourceName || 'window')} · ${debug.sourceWidth}×${debug.sourceHeight} → ${debug.width}×${debug.height} · ${esc(debug.backend || '')}</p>
    ${debug.frameDataUrl ? `<div class="ow-dbg-frame"><img src="${esc(debug.frameDataUrl)}" alt="Captured Overwatch frame">${boxes}</div>` : ''}
    <div class="ow-dbg-cells">${debug.cells.map(cell).join('')}</div>
  </div>`;
}

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
      <div class="ow-ocr-buttons"><button data-action="ow-ocr-test">TEST READ</button><button data-action="ow-ocr-debug">DEBUG CAPTURE</button>${ocr.debug ? '<button data-action="ow-ocr-debug-close">HIDE DEBUG</button>' : ''}<button data-action="ow-ocr-clear" data-confirm="Clear?">CLEAR</button></div>
    </div>
    <p class="ow-ocr-status is-${tone}">${esc((status.state || 'disabled').toUpperCase())} · ${esc(status.message || '')}${status.sweepMs ? ` · ${status.sweepMs} ms per read` : ''}</p>
    <div class="ow-ocr-tables">${table}</div>
    ${renderOverwatchDebugCapture(ocr.debug)}
  </article>`;
}

// Merge a snapshot from the service into the controller state (only what overlays need).
export function mergeOverwatchOcrSnapshot(ocr, snapshot) {
  if (!snapshot?.teams) return ocr;
  const strip = (players = []) => players.map(({ side, slot, name, ultimate, elims, assists, deaths, damage, healing, mitigation }) => ({ side, slot, name, ultimate, elims, assists, deaths, damage, healing, mitigation }));
  return { ...ocr, live: { teams: { home: { players: strip(snapshot.teams.home?.players) }, away: { players: strip(snapshot.teams.away?.players) } }, updatedAt: snapshot.updatedAt || Date.now() }, status: snapshot.status || ocr.status };
}
