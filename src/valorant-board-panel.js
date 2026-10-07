import { matchRosterToOcr, NAME_MATCH } from './overwatch-ocr-panel.js';
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

// Roster sync, same rules as Overwatch (src/overwatch-ocr-panel.js): gamertags match at >= 90%
// similarity; matched players get the agent + role from the board; board players nobody
// matched fill empty roster slots. Agent slugs ('kay-o') map to the roster names ('KAY/O').
export const VALORANT_AGENT_ROLES = {
  Jett: 'Duelist', Raze: 'Duelist', Reyna: 'Duelist', Phoenix: 'Duelist', Neon: 'Duelist', Yoru: 'Duelist', Iso: 'Duelist', Waylay: 'Duelist',
  Sova: 'Initiator', Skye: 'Initiator', Breach: 'Initiator', 'KAY/O': 'Initiator', Fade: 'Initiator', Gekko: 'Initiator', Tejo: 'Initiator',
  Brimstone: 'Controller', Omen: 'Controller', Viper: 'Controller', Astra: 'Controller', Harbor: 'Controller', Clove: 'Controller', Miks: 'Controller',
  Sage: 'Sentinel', Cypher: 'Sentinel', Killjoy: 'Sentinel', Chamber: 'Sentinel', Deadlock: 'Sentinel', Vyse: 'Sentinel', Veto: 'Sentinel'
};
const slug = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export function agentNameFromSlug(s) { return Object.keys(VALORANT_AGENT_ROLES).find((n) => slug(n) === s) || ''; }

export function syncValorantRoster(game, rosterKey = 'varsity', { threshold = NAME_MATCH, fillEmpty = true } = {}) {
  const live = game?.valorantBoard?.live?.teams;
  if (!live) return [];
  const changes = [];
  const apply = (side, player, field, value) => {
    if (!value || player[field] === value) return;
    changes.push({ side, handle: player.handle || '', field, from: player[field] || '', to: value });
    player[field] = value;
  };
  const isEmpty = (p) => p && !String(p.handle || '').trim() && !String(p.name || '').trim();
  for (const [side, roster] of [['home', game.rosters?.[rosterKey]], ['away', game.awayRosters?.[rosterKey]]]) {
    if (!Array.isArray(roster)) continue;
    const rows = (live[side]?.players || []).map((r) => ({ ...r, agentName: agentNameFromSlug(r?.agent) }));
    const pairs = matchRosterToOcr(roster, rows, threshold);
    const matched = new Set(pairs.map((p) => p.ri));
    for (const { pi, ri } of pairs) { apply(side, roster[pi], 'character', rows[ri].agentName); apply(side, roster[pi], 'role', VALORANT_AGENT_ROLES[rows[ri].agentName]); }
    if (!fillEmpty) continue;
    for (const [ri, row] of rows.entries()) {
      if (matched.has(ri) || !row?.name) continue;
      const slot = roster.find(isEmpty); if (!slot) break;
      changes.push({ side, handle: row.name, field: 'handle', from: '', to: row.name });
      slot.handle = row.name; slot.autoAdded = true;
      apply(side, slot, 'character', row.agentName); apply(side, slot, 'role', VALORANT_AGENT_ROLES[row.agentName]);
    }
  }
  return changes;
}
