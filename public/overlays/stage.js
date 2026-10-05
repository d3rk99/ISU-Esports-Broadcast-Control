(() => {
  // One stage station for OBS (Browser Source -> DistroAV NDI "ISU Stage NN").
  //   ?station=N           which station (1-10)
  //   state.stageObs.stations[N].mode   hold | intro | player | score | blackout  (set by the controller)
  // Content comes from the same /api/state + /events feed as every overlay.
  const query = new URLSearchParams(location.search);
  const station = Math.max(1, Math.min(10, Math.round(Number(query.get('station')) || 1)));
  const MODES = ['hold', 'intro', 'player', 'score', 'blackout'];
  const $ = (id) => document.getElementById(id);
  const setText = (id, value) => { const el = $(id); if (el) el.textContent = String(value ?? ''); };
  const pad = (n) => String(n).padStart(2, '0');

  function safeUrl(value) {
    const url = String(value || '');
    if (/^(https?:|data:image\/|blob:)/i.test(url) || url.startsWith('/')) return url.replace(/["\\]/g, '');
    return '';
  }
  function number(value) { const n = Number(value); return Number.isFinite(n) ? n.toLocaleString('en-US') : '–'; }

  // Same >= 90% gamertag match as the controller roster sync.
  function fold(v) { return String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL|]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/[\s_.\-#]/g, ''); }
  function similarity(a, b) {
    const x = fold(a); const y = fold(b); if (!x || !y) return 0; if (x === y) return 1;
    const prev = Array.from({ length: y.length + 1 }, (_v, i) => i);
    for (let i = 1; i <= x.length; i += 1) { let diag = prev[0]; prev[0] = i; for (let j = 1; j <= y.length; j += 1) { const up = prev[j]; prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (x[i - 1] === y[j - 1] ? 0 : 1)); diag = up; } }
    return 1 - prev[y.length] / Math.max(x.length, y.length);
  }
  function bestByTag(list, tag) { let best = null; let score = 0.9; for (const item of list || []) { const s = similarity(item?.name, tag); if (s >= score) { best = item; score = s; } } return best; }

  function logo(id, team) {
    const node = $(id); if (!node) return;
    const url = safeUrl(team?.logoImage);
    node.replaceChildren();
    if (url) { const img = document.createElement('img'); img.src = url; img.alt = ''; node.append(img); } else node.textContent = team?.shortName || '';
  }

  function findPlayer(game, rosterKey) {
    const sides = [
      { side: 'home', team: game.teams?.[0], roster: game.rosters?.[rosterKey] || [] },
      { side: 'away', team: game.teams?.[1], roster: game.awayRosters?.[rosterKey] || [] }
    ];
    for (const s of sides) {
      const player = s.roster.find((p) => Math.round(Number(p?.stageStation) || 0) === station);
      if (player) return { ...s, player };
    }
    return null;
  }

  let lastMode = '';
  function render(state) {
    const game = state?.games?.[state?.selectedGame] || {};
    const teams = game.teams || [];
    const stage = $('stage');
    const mode = MODES.includes(state?.stageObs?.stations?.[station]?.mode) ? state.stageObs.stations[station].mode : 'hold';
    const found = findPlayer(game, state?.activeRoster || 'varsity');
    stage.style.setProperty('--home', teams[0]?.color || '#f47920');
    stage.style.setProperty('--away', teams[1]?.color || '#5e6673');
    stage.style.setProperty('--team', found?.team?.color || teams[0]?.color || '#f47920');
    // Re-trigger the entrance animations only when the mode actually changes.
    if (mode !== lastMode) { stage.dataset.mode = ''; void stage.offsetWidth; stage.dataset.mode = mode; lastMode = mode; }

    setText('st-hold-title', 'STAGE');
    setText('st-hold-sub', `STATION ${pad(station)}`);

    setText('st-home-name', teams[0]?.name || 'HOME');
    setText('st-away-name', teams[1]?.name || 'AWAY');
    logo('st-home-logo', teams[0]); logo('st-away-logo', teams[1]);

    setText('st-score-home', Number(teams[0]?.score) || 0);
    setText('st-score-away', Number(teams[1]?.score) || 0);
    logo('st-score-home-logo', teams[0]); logo('st-score-away-logo', teams[1]);
    const activeMap = game.mapRows?.[game.activeMap || 0];
    setText('st-score-label', 'SERIES');
    setText('st-score-map', activeMap?.map || '');

    setText('st-station', pad(station));
    const player = found?.player;
    setText('st-player-team', found?.team?.name || '');
    setText('st-player-handle', player?.handle || player?.name || `STATION ${pad(station)}`);
    const live = player?.handle ? bestByTag(game.overwatchOcr?.live?.teams?.[found.side]?.players, player.handle) : null;
    const hero = live?.hero || game.overwatchLastMapStats?.[station]?.hero || player?.character || '';
    setText('st-player-meta', [player?.name, player?.role, hero].filter(Boolean).join(' · '));
    const portrait = safeUrl(player?.playerImage);
    $('st-portrait').style.backgroundImage = portrait ? `url("${portrait}")` : '';
    const heroUrl = safeUrl(hero ? game.characterArt?.[hero]?.url : '');
    $('st-hero').style.backgroundImage = heroUrl ? `url("${heroUrl}")` : '';
    const stats = game.overwatchLastMapStats?.[station]?.stats || live;
    const statsBox = $('st-stats');
    statsBox.replaceChildren(...(stats ? [['elims', 'ELIMS'], ['deaths', 'DEATHS'], ['assists', 'ASSISTS'], ['damage', 'DAMAGE'], ['healing', 'HEALING'], ['mitigation', 'MITIGATED']].map(([k, label]) => {
      const div = document.createElement('div'); const b = document.createElement('b'); const em = document.createElement('em');
      b.textContent = number(stats[k]); em.textContent = label; div.append(b, em); return div;
    }) : []));
  }

  async function start() {
    try { render(await fetch('/api/state', { cache: 'no-store' }).then((r) => r.json())); } catch {}
    const events = new EventSource('/events');
    events.onmessage = (event) => { try { render(JSON.parse(event.data)); } catch {} };
  }
  window.__stage = { render, station };
  start();
})();
