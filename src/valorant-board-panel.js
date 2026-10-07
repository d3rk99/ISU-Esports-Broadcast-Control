// Controller panel for the rebuilt VALORANT scoreboard reader (electron/valorant-board-service.cjs).
// Same idea as the Overwatch OCR panel: on/off, window, live table, test read, clear.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const SHIELD = { light: 'LIGHT', heavy: 'HEAVY', regen: 'REGEN', none: '—' };

export function emptyValorantBoard() {
  const players = (side) => Array.from({ length: 5 }, (_v, row) => ({ side, row, agent: null, weapon: null, shield: null, name: '', ultimate: null, kills: null, deaths: null, assists: null, credits: null, ping: null }));
  return { live: { updatedAt: 0, teams: { home: { players: players('home') }, away: { players: players('away') } } }, settings: {}, status: { state: 'disabled', message: '' } };
}

export function mergeValorantBoardSnapshot(current, snapshot) {
  if (!snapshot) return current;
  const { status, align, ...board } = snapshot;
  return { ...current, live: { ...board, align: align || null }, status: status || current.status };
}

const v = (x) => (x === null || x === undefined || x === '' ? '<i class="vb-blank">·</i>' : esc(x));

export function renderValorantBoardPanel(vb, teams = []) {
  const s = vb.settings || {}; const status = vb.status || {};
  const tone = status.state === 'reading' ? 'ok' : status.state === 'error' ? 'bad' : status.state === 'no-board' ? 'warn' : '';
  const table = ['home', 'away'].map((side, i) => {
    const players = vb.live?.teams?.[side]?.players || [];
    return `<div class="vb-team"><h3>${esc(teams[i]?.name || (side === 'home' ? 'TOP TEAM' : 'BOTTOM TEAM'))}</h3>
      <table><thead><tr><th>AGENT</th><th>NAME</th><th>ULT</th><th>K</th><th>D</th><th>A</th><th>GUN</th><th>SHIELD</th><th>CREDS</th><th>PING</th></tr></thead><tbody>
      ${players.map((p) => `<tr data-key="vb-${side}-${p.row}">
        <td>${p.agent ? `<img src="/assets/valorant/agents/${esc(p.agent)}.webp" alt=""><span>${esc(p.agent.toUpperCase())}</span>` : v(null)}</td>
        <td><input data-vb-name data-side="${side}" data-row="${p.row}" value="${esc(p.name)}" placeholder="(OCR)" class="${p.nameManual ? 'manual' : ''}"></td>
        <td>${v(p.ultimate)}</td><td>${v(p.kills)}</td><td>${v(p.deaths)}</td><td>${v(p.assists)}</td>
        <td>${v(p.weapon ? p.weapon.toUpperCase() : null)}</td><td>${v(p.shield ? SHIELD[p.shield] : null)}</td>
        <td>${v(Number.isFinite(p.credits) ? p.credits.toLocaleString('en-US') : null)}</td><td>${v(p.ping)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }).join('');
  return `<article class="panel vb-panel" data-key="vb-panel">
    <div class="panel-title"><span class="section-number">OCR</span><div><h2>VALORANT scoreboard reader</h2><p>Observer 3 keeps <b>Tab</b> open. The board is found by itself (it follows the window moving), then every cell is read. A value only shows after it reads the same twice, and a number stays blank instead of guessing.</p></div></div>
    <div class="ow-ocr-controls">
      <label class="rl-enable-toggle"><input type="checkbox" data-vb-cfg="enabled" ${s.enabled ? 'checked' : ''}><i></i><span><b>READ SCOREBOARD</b><small>Off by default; turn on when Observer 3 is on the board</small></span></label>
      <label class="field"><span>WINDOW TITLE CONTAINS</span><input data-vb-cfg="windowName" value="${esc(s.windowName || 'VALORANT')}"></label>
      <label class="field"><span>READ EVERY (MS)</span><input type="number" min="200" max="5000" step="50" data-vb-cfg="intervalMs" value="${Number(s.intervalMs) || 500}"></label>
      <label class="field"><span>CPU CORES (OCR WORKERS)</span><input type="number" min="1" max="16" data-vb-cfg="workers" value="${Number(s.workers) || 4}"></label>
      <div class="ow-ocr-buttons"><button data-action="vb-test">TEST READ</button><button data-action="vb-clear" data-confirm="Clear?">CLEAR</button></div>
    </div>
    <p class="ow-ocr-status is-${tone}">${esc((status.state || 'disabled').toUpperCase())} · ${esc(status.message || 'off')}${status.sweepMs ? ` · ${status.sweepMs} ms per read` : ''}</p>
    <div class="vb-tables">${table}</div>
  </article>`;
}
