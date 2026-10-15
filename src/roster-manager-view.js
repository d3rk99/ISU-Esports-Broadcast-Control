// Roster tab -> ROSTER MANAGER sub-tab (Derk 2026-10-15). Markup only; handlers live in app.js
// (data-rm-* attributes / data-action="rm-*"). Logic: src/roster-manager.js.
import { ensureLibrary, findTeam, sortedPlayers, STATUSES, STATUS_LABEL, isuSide } from './roster-manager.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderRosterSubTabs(active) {
  return `<div class="roster-subtabs">
    <button class="${active === 'manager' ? 'active' : ''}" data-roster-subtab="manager"><strong>ROSTER MANAGER</strong><small>Teams &amp; players library · source of truth</small></button>
    <button class="${active !== 'manager' ? 'active' : ''}" data-roster-subtab="lineup"><strong>MATCH ROSTER</strong><small>Who is loaded for this match</small></button>
  </div>`;
}

export function renderRosterManager(game, { selectedTeamId = '', selected = new Set(), assetUrl = (u) => u, filter = 'all', bulkText = '' } = {}) {
  const lib = ensureLibrary(game);
  const team = findTeam(game, selectedTeamId) || lib.teams[0] || null;
  const isu = isuSide(game);
  const teamList = lib.teams.map((t) => {
    const count = (s) => t.players.filter((p) => p.status === s).length;
    const loaded = ['home', 'away'].filter((side) => game.rosterAssign?.[side] === t.id).map((s) => s.toUpperCase()).join(' + ');
    return `<button class="rm-team ${team && t.id === team.id ? 'active' : ''}" data-rm-team="${esc(t.id)}" style="--team-color:${esc(t.color)}">
      <strong>${esc(t.name)}${t.isISU ? ' <em>ISU</em>' : ''}</strong>
      <small>${count('starter')} starters · ${count('sixth')} 6th · ${count('sub')} subs · ${count('coach')} coaches${loaded ? ` · <b>LOADED ${loaded}</b>` : ''}</small></button>`;
  }).join('');
  const header = team ? `<div class="rm-team-edit">
      <label class="field"><span>TEAM NAME</span><input data-rm-team-prop="name" value="${esc(team.name)}" maxlength="40"></label>
      <label class="field"><span>SHORT</span><input data-rm-team-prop="shortName" value="${esc(team.shortName)}" maxlength="6"></label>
      <label class="field"><span>COLOR</span><input type="color" data-rm-team-prop="color" value="${esc(team.color || '#5e6673')}"></label>
      <label class="rl-enable-toggle"><input type="checkbox" data-rm-team-prop="isISU" ${team.isISU ? 'checked' : ''}><i></i><span><b>IDAHO STATE (HOME PROGRAM)</b><small>The reader treats this team as ISU</small></span></label>
      <div class="rm-load"><button class="primary-button" data-action="rm-load" data-side="home">LOAD AS HOME</button><button class="primary-button" data-action="rm-load" data-side="away">LOAD AS AWAY</button><button data-action="rm-delete-team" data-confirm="Delete this team from the library?">DELETE TEAM</button></div>
    </div>` : '';
  const players = team ? sortedPlayers(team).filter((p) => filter === 'all' || p.program === filter || p.status === filter) : [];
  const rows = players.map((p) => `<div class="rm-player status-${esc(p.status)}">
      <input type="checkbox" data-rm-select="${esc(p.id)}" ${selected.has(p.id) ? 'checked' : ''}>
      <div class="asset-thumb ${p.playerImage ? 'has-image' : ''}" data-action="rm-pick-headshot" data-id="${esc(p.id)}" title="Choose headshot">${p.playerImage ? `<img src="${esc(assetUrl(p.playerImage))}" alt="">` : '<span>PHOTO</span>'}</div>
      <label><span>GAMERTAG</span><input data-rm-player="${esc(p.id)}" data-rm-prop="handle" value="${esc(p.handle)}" maxlength="24" placeholder="As it shows in game"></label>
      <label><span>NAME</span><input data-rm-player="${esc(p.id)}" data-rm-prop="name" value="${esc(p.name)}" maxlength="40" placeholder="First Last"></label>
      <label><span>STATUS</span><select data-rm-player="${esc(p.id)}" data-rm-prop="status">${STATUSES.map((s) => `<option value="${s}" ${p.status === s ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select></label>
      <label><span>PROGRAM</span><select data-rm-player="${esc(p.id)}" data-rm-prop="program"><option value="varsity" ${p.program === 'varsity' ? 'selected' : ''}>VARSITY</option><option value="jv" ${p.program === 'jv' ? 'selected' : ''}>JV</option></select></label>
      <button class="remove-player" data-action="rm-remove" data-id="${esc(p.id)}" data-index="${esc(p.id)}" data-confirm="Remove?" title="Remove (click twice)">&times;</button>
    </div>`).join('');
  const filters = [['all', 'ALL'], ['varsity', 'VARSITY'], ['jv', 'JV'], ['starter', 'STARTERS'], ['sixth', '6TH MAN'], ['sub', 'SUBS'], ['coach', 'COACHES']]
    .map(([k, l]) => `<button class="${filter === k ? 'active' : ''}" data-rm-filter="${k}">${l}</button>`).join('');
  return `<section class="view-stack roster-manager">
    <div class="section-heading"><div><span class="section-number">00</span><div><h2>Roster manager</h2><p>Build every team once. Loading a team fills the match roster, and the scoreboard reader links players by gamertag. ${isu ? `Idaho State is loaded as <b>${isu.toUpperCase()}</b>.` : 'No team marked Idaho State is loaded yet.'}</p></div></div>
      <button class="primary-button" data-action="rm-new-team">+ NEW TEAM</button></div>
    <div class="rm-layout">
      <aside class="rm-teams">${teamList || '<p class="rm-empty">No teams yet. Click + NEW TEAM.</p>'}</aside>
      <article class="panel rm-panel">${team ? `${header}
        <div class="rm-bulk">
          <label class="field rm-paste"><span>ADD MANY (one per line: gamertag, name, starter/6th/sub/coach, varsity/jv)</span><textarea data-rm-bulk rows="3" placeholder="Sn0wfal, Sam Snow, starter&#10;BaldReaper, Bob Reap, 6th, varsity&#10;CoachK, Kim Coach, coach">${esc(bulkText)}</textarea></label>
          <div class="rm-bulk-buttons"><button data-action="rm-bulk-add">ADD PLAYERS</button><button data-action="rm-add-one">+ ONE PLAYER</button></div>
        </div>
        <div class="rm-filters">${filters}</div>
        <div class="rm-selected"><span><b>${selected.size}</b> selected</span>
          <select data-rm-bulk-status><option value="">Set status…</option>${STATUSES.map((s) => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join('')}</select>
          <select data-rm-bulk-program><option value="">Set program…</option><option value="varsity">VARSITY</option><option value="jv">JV</option></select>
          <button data-action="rm-select-all">SELECT ALL SHOWN</button><button data-action="rm-select-none">CLEAR</button><button data-action="rm-remove-selected" data-confirm="Remove selected players?">REMOVE SELECTED</button></div>
        <div class="rm-players">${rows || '<p class="rm-empty">No players here yet.</p>'}</div>
        <footer><span><b>${team.players.length}</b> players in ${esc(team.name)}</span></footer>` : '<p class="rm-empty">Pick or create a team.</p>'}</article>
    </div>
  </section>`;
}
