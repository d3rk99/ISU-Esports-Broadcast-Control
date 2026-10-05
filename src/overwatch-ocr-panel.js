import { OVERWATCH_HERO_ROLES } from './overwatch-hero-roles.js';
// Controller panel for the Overwatch scoreboard OCR (Observer 3 keeps Tab open). The service
// runs in the main process; this file renders its settings/status and the live player table,
// and merges OCR snapshots into state.games.overwatch.overwatchOcr.live for the overlays.

export const OW_OCR_STATS = [
  ['hero', 'HERO'], ['ultimate', 'ULT'], ['elims', 'E'], ['assists', 'A'], ['deaths', 'D'],
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
      ${c.field === 'name' && c.accepted === null && String(c.text || '').trim() ? `<button data-action="ow-ocr-use-name" data-side="${c.side}" data-row="${c.row}" data-name="${esc(String(c.text).trim().toUpperCase())}">USE “${esc(String(c.text).trim().toUpperCase())}”</button>` : ''}
    </div>`;
  const age = Math.max(0, Math.round((Date.now() - Number(debug.capturedAt || Date.now())) / 1000));
  return `<div class="ow-dbg">
    <p class="ow-ocr-status">DEBUG CAPTURE · ${age}s old · ${esc(debug.sourceName || 'window')} · ${debug.sourceWidth}×${debug.sourceHeight} → ${debug.width}×${debug.height} · ${esc(debug.backend || '')}</p>
    ${debug.frameDataUrl ? `<div class="ow-dbg-frame"><img src="${esc(debug.frameDataUrl)}" alt="Captured Overwatch frame">${boxes}</div>` : ''}
    ${debug.heroes?.length ? `<p class="ow-ocr-status">HEROES · ${debug.heroes.map((h) => `${h.side === 'home' ? 'TOP' : 'BOT'} ${h.row + 1}: ${esc(h.hero || `? (${h.candidate} ${h.score})`)}`).join(' · ')}</p>` : ''}
    <div class="ow-dbg-cells">${debug.cells.map(cell).join('')}</div>
  </div>`;
}

export function renderOverwatchOcrPanel(ocr = emptyOverwatchOcr(), teams = [], game = {}) {
  const s = ocr.settings || {};
  const status = ocr.status || {};
  const tone = status.state === 'reading' ? 'ok' : status.state === 'error' || status.state === 'no-board' ? 'bad' : 'idle';
  const table = ['home', 'away'].map((side, t) => {
    const players = ocr.live?.teams?.[side]?.players || [];
    const rows = Array.from({ length: 5 }, (_v, i) => {
      const p = players[i] || {};
      // Name is editable: type to override a misread / unread name (sticks until cleared).
      const name = `<input class="ow-ocr-name-input ${p.nameManual ? 'is-manual' : ''}" data-ow-name-side="${side}" data-ow-name-row="${i}" data-key="ow-name-${side}-${i}" value="${esc(p.name || '')}" placeholder="set name" maxlength="24" title="${p.nameManual ? 'Set by hand. Clear it to go back to OCR.' : 'Read by OCR. Type to set it by hand.'}">`;
      return `<tr><td>${i + 1}</td><td class="ow-ocr-name">${name}</td>${OW_OCR_STATS.map(([k]) => `<td>${esc(show(p[k]))}</td>`).join('')}</tr>`;
    }).join('');
    return `<table class="ow-ocr-table"><caption>${esc(teams[t]?.shortName || side.toUpperCase())} · ${t === 0 ? 'top' : 'bottom'} of the board</caption>
      <thead><tr><th>#</th><th>PLAYER</th>${OW_OCR_STATS.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
  }).join('');
  return `<article class="panel ow-ocr-panel" data-key="ow-ocr-panel">
    <div class="panel-title"><span class="section-number">OCR</span><div><h2>Overwatch scoreboard OCR</h2><p>Observer 3 keeps the Tab scoreboard open; stats are read from it. Map score stays manual (Companion).</p></div></div>
    <div class="ow-ocr-controls">
      <label class="rl-enable-toggle"><input type="checkbox" data-ow-ocr="enabled" ${s.enabled ? 'checked' : ''}><i></i><span><b>READ SCOREBOARD</b><small>Off by default; turn on when Observer 3 is on the board</small></span></label>
      <label class="rl-enable-toggle"><input type="checkbox" data-ow-stat-cards ${game.overwatchShowStatCards ? 'checked' : ''}><i></i><span><b>PLAYER STAT CARDS (EXPERIMENTAL)</b><small>Bottom-left / bottom-right cards on the scoreboard overlay</small></span></label>
      <label class="rl-enable-toggle"><input type="checkbox" data-ow-hero-autofill ${game.overwatchHeroAutofill === false ? '' : 'checked'}><i></i><span><b>AUTO-FILL ROSTER FROM OCR</b><small>Matches gamertags at ≥90% similarity: hero + role follow the game; empty roster slots get filled from the board</small></span></label>
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
  const strip = (players = []) => players.map(({ side, slot, name, nameManual, hero, ultimate, elims, assists, deaths, damage, healing, mitigation }) => ({ side, slot, name, nameManual: Boolean(nameManual), hero, ultimate, elims, assists, deaths, damage, healing, mitigation }));
  return { ...ocr, live: { teams: { home: { players: strip(snapshot.teams.home?.players) }, away: { players: strip(snapshot.teams.away?.players) } }, updatedAt: snapshot.updatedAt || Date.now() }, status: snapshot.status || ocr.status };
}

// ---- Roster sync from the scoreboard OCR --------------------------------------------------
// Gamertags from OCR are close but not always exact (a misread letter, O/0, I/1, clan tags), so
// matching is fuzzy: names are folded (case, accents, O->0, I/L->1, S->5, B->8, spaces/_-.),
// then compared by similarity = 1 - editDistance / longerLength. A roster player matches an
// OCR row at >= NAME_MATCH (0.9 by default, Derk's ask), best pair first, one-to-one.
//   matched player : hero + role follow the OCR live (role from the hero: Tank/Damage/Support)
//   no match + empty roster slot (no gamertag) : the slot is filled with the OCR name, hero, role
// Roster players the OCR never sees are left alone.

export const NAME_MATCH = 0.9;

export function foldTag(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()
    .replace(/O/g, '0').replace(/[IL|]/g, '1').replace(/S/g, '5').replace(/B/g, '8')
    .replace(/[\s_.\-#]/g, '');
}

export function editDistance(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_v, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

export function tagSimilarity(a, b) {
  const x = foldTag(a); const y = foldTag(b);
  if (!x || !y) return 0;
  return 1 - editDistance(x, y) / Math.max(x.length, y.length);
}

// Best one-to-one pairs between roster players (with a gamertag) and OCR rows (with a name).
export function matchRosterToOcr(roster, rows, threshold = NAME_MATCH) {
  const pairs = [];
  roster.forEach((player, pi) => {
    if (!player?.handle) return;
    rows.forEach((row, ri) => {
      if (!row?.name) return;
      const score = tagSimilarity(player.handle, row.name);
      if (score >= threshold) pairs.push({ pi, ri, score });
    });
  });
  pairs.sort((l, r) => r.score - l.score);
  const usedP = new Set(); const usedR = new Set(); const out = [];
  for (const pair of pairs) {
    if (usedP.has(pair.pi) || usedR.has(pair.ri)) continue;
    usedP.add(pair.pi); usedR.add(pair.ri); out.push(pair);
  }
  return out;
}

const isEmptySlot = (p) => p && !String(p.handle || '').trim() && !String(p.name || '').trim();

// Applies the sync to `game` (mutates) and returns the list of changes, for one commit + toast.
export function syncRosterFromOcr(game, rosterKey = 'varsity', { threshold = NAME_MATCH, fillEmpty = true } = {}) {
  const live = game?.overwatchOcr?.live?.teams;
  if (!live) return [];
  const changes = [];
  const apply = (side, player, field, value) => {
    if (!value || player[field] === value) return;
    changes.push({ side, handle: player.handle || '', field, from: player[field] || '', to: value });
    player[field] = value;
  };
  for (const [side, roster] of [['home', game.rosters?.[rosterKey]], ['away', game.awayRosters?.[rosterKey]]]) {
    if (!Array.isArray(roster)) continue;
    const rows = live[side]?.players || [];
    const pairs = matchRosterToOcr(roster, rows, threshold);
    const matchedRows = new Set(pairs.map((p) => p.ri));
    for (const { pi, ri } of pairs) {
      const row = rows[ri]; const player = roster[pi];
      apply(side, player, 'character', row.hero);
      apply(side, player, 'role', OVERWATCH_HERO_ROLES[row.hero]);
    }
    if (!fillEmpty) continue;
    // OCR players nobody in the roster matched go into empty slots, in board order.
    for (const [ri, row] of rows.entries()) {
      if (matchedRows.has(ri) || !row?.name) continue;
      const slot = roster.find(isEmptySlot);
      if (!slot) break;
      changes.push({ side, handle: row.name, field: 'handle', from: '', to: row.name });
      slot.handle = row.name;
      slot.autoAdded = true;
      apply(side, slot, 'character', row.hero);
      apply(side, slot, 'role', OVERWATCH_HERO_ROLES[row.hero]);
    }
  }
  return changes;
}

// Kept for older callers: hero-only sync with the same fuzzy matching.
export function syncRosterHeroes(game, rosterKey = 'varsity') {
  return syncRosterFromOcr(game, rosterKey, { fillEmpty: false }).filter((c) => c.field === 'character');
}
