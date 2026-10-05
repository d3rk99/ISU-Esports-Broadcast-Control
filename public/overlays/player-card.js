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
    const row = handle ? live.find((p) => String(p?.name || '').toUpperCase() === handle) : null;
    if (row) return { stats: row, label: 'THIS MAP · LIVE', map: '' };
    return { stats: null, label: 'LAST MAP', map: '' };
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
    setText('pc-hero-name', player?.character ? player.character.toUpperCase() : '');
    setText('pc-initials', handle.slice(0, 2).toUpperCase());
    const portrait = safeUrl(player?.playerImage);
    $('pc-portrait').classList.toggle('has-image', Boolean(portrait));
    $('pc-portrait').style.backgroundImage = portrait ? `url("${portrait}")` : '';
    const heroUrl = safeUrl(player?.character ? game.characterArt?.[player.character]?.url : '');
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
