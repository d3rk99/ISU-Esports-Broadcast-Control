(() => {
  // Full-screen player card for one stage station. Data comes from the controller state
  // (same /api/state + /events feed as every overlay):
  //   roster   : handle, name, role, portrait (playerImage), hero (character), STATION (stageStation)
  //   stats    : game.overwatchLastMapStats[station] (saved when a map ends = "previous game"),
  //              falling back to the live scoreboard OCR row matched by handle.
  const query = new URLSearchParams(location.search);
  const station = Math.max(1, Math.min(10, Math.round(Number(query.get('station')) || 1)));
  const $ = (id) => document.getElementById(id);
  const setText = (id, value) => { const el = $(id); if (el) el.textContent = String(value ?? ''); };

  function safeUrl(value) {
    const url = String(value || '');
    if (!url) return '';
    if (/^(https?:|data:image\/|blob:)/i.test(url) || url.startsWith('/')) return url.replace(/["\\]/g, '');
    return '';
  }

  function number(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('en-US') : '–';
  }


  // Same gamertag matching as the controller's roster sync (src/overwatch-ocr-panel.js):
  // folded (case, accents, O->0, I/L->1, S->5, B->8, spaces/_-.#) then >= 90% similarity.
  function owFoldTag(v) { return String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL|]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/[\s_.\-#]/g, ''); }
  function owTagSimilarity(a, b) {
    const x = owFoldTag(a); const y = owFoldTag(b); if (!x || !y) return 0; if (x === y) return 1;
    const prev = Array.from({ length: y.length + 1 }, (_v, i) => i);
    for (let i = 1; i <= x.length; i += 1) { let diag = prev[0]; prev[0] = i; for (let j = 1; j <= y.length; j += 1) { const up = prev[j]; prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (x[i - 1] === y[j - 1] ? 0 : 1)); diag = up; } }
    return 1 - prev[y.length] / Math.max(x.length, y.length);
  }
  function owBestByTag(list, tag, key) { let best = null; let score = 0.9; for (const item of list || []) { const s = owTagSimilarity(item?.[key], tag); if (s >= score) { best = item; score = s; } } return best; }

  function findPlayer(state) {
    const gameKey = state?.selectedGame;
    const game = state?.games?.[gameKey];
    if (!game) return null;
    const rosterKey = state.activeRoster || 'varsity';
    const sides = [
      { side: 'home', team: game.teams?.[0], roster: game.rosters?.[rosterKey] || [] },
      { side: 'away', team: game.teams?.[1], roster: game.awayRosters?.[rosterKey] || [] }
    ];
    for (const { side, team, roster } of sides) {
      const player = roster.find((p) => Math.round(Number(p?.stageStation) || 0) === station);
      if (player) return { gameKey, game, side, team: team || {}, player };
    }
    return { gameKey, game, side: 'home', team: game.teams?.[0] || {}, player: null };
  }

  function statsFor(found) {
    const { game, side, player } = found;
    const saved = game.overwatchLastMapStats?.[station];
    if (saved?.stats) return { stats: saved.stats, label: 'LAST MAP', map: saved.map || '' };
    const live = game.overwatchOcr?.live?.teams?.[side]?.players || [];
    const handle = String(player?.handle || '').toUpperCase();
    const row = handle ? owBestByTag(live, player.handle, 'name') : null;
    if (row) return { stats: row, label: 'THIS MAP · LIVE', map: '' };
    return { stats: null, label: 'LAST MAP', map: '' };
  }

  // Hero shown on the card: what the scoreboard OCR sees this player on right now, else the
  // hero from their last map, else the roster's hero.
  function heroFor(found) {
    const { game, side, player } = found;
    const handle = String(player?.handle || '').toUpperCase();
    const live = handle ? owBestByTag(game.overwatchOcr?.live?.teams?.[side]?.players, player.handle, 'name') : null;
    return live?.hero || game.overwatchLastMapStats?.[station]?.hero || player?.character || '';
  }

  function render(state) {
    const found = findPlayer(state);
    const card = $('pc');
    if (!found) { card.dataset.state = 'empty'; return; }
    const { game, team, player } = found;
    card.dataset.state = player ? 'player' : 'empty';
    card.style.setProperty('--team', team.color || '#f47920');
    setText('pc-station', `STATION ${String(station).padStart(2, '0')}`);
    setText('pc-team-short', team.shortName || '');
    setText('pc-team-name', team.name || '');
    setText('pc-event', game.match?.event || 'COLLEGIATE ESPORTS');
    const logo = $('pc-logo');
    const logoUrl = safeUrl(team.logoImage);
    logo.replaceChildren();
    if (logoUrl) { const img = document.createElement('img'); img.src = logoUrl; img.alt = ''; logo.append(img); } else logo.textContent = team.shortName || '';
    const handle = player?.handle || player?.name || 'NO PLAYER';
    setText('pc-handle', handle);
    setText('pc-name', player?.name && player.name !== handle ? player.name : '');
    setText('pc-role', (player?.role || 'PLAYER').toUpperCase());
    const hero = player ? heroFor(found) : '';
    setText('pc-hero-name', hero ? hero.toUpperCase() : '');
    setText('pc-initials', handle.slice(0, 2).toUpperCase());
    const portrait = safeUrl(player?.playerImage);
    $('pc-portrait').classList.toggle('has-image', Boolean(portrait));
    $('pc-portrait').style.backgroundImage = portrait ? `url("${portrait}")` : '';
    const heroUrl = safeUrl(hero ? game.characterArt?.[hero]?.url : '');
    $('pc-hero').style.backgroundImage = heroUrl ? `url("${heroUrl}")` : '';
    const { stats, label, map } = statsFor(found);
    card.classList.toggle('no-stats', !stats);
    setText('pc-stats-label', label);
    setText('pc-stats-map', map ? map.toUpperCase() : '');
    for (const k of ['elims', 'assists', 'deaths', 'damage', 'healing', 'mitigation']) setText(`pc-${k}`, stats ? number(stats[k]) : '–');
  }

  async function start() {
    try { render(await fetch('/api/state', { cache: 'no-store' }).then((r) => r.json())); } catch {}
    const events = new EventSource('/events');
    events.onmessage = (event) => { try { render(JSON.parse(event.data)); } catch {} };
  }
  window.__playerCard = { render, station };
  start();
})();
