(() => {
  // Audience display preset page. ?station=N. Reads state.displays.stations[N] = { preset, team }
  // from the controller (/api/state + /events) and renders it; changes are instant, no reload.
  const query = new URLSearchParams(location.search);
  const station = Math.max(1, Math.min(10, Math.round(Number(query.get('station')) || 1)));
  const PRESETS = ['idle', 'intro', 'player', 'banner', 'score', 'black'];
  const $ = (id) => document.getElementById(id);
  const setText = (id, v) => { const el = $(id); if (el) el.textContent = String(v ?? ''); };
  const pad = (n) => String(n).padStart(2, '0');
  const safeUrl = (v) => {
    let u = String(v || '');
    // Uploads are served by the controller. Saved roster URLs can contain its
    // loopback address, which points at the wrong PC when OBS runs remotely.
    if (/^https?:\/\//i.test(u)) {
      try {
        const url = new URL(u);
        if (url.pathname.startsWith('/user-assets/')) u = `${url.pathname}${url.search}`;
      } catch { return ''; }
    }
    return (/^(https?:|data:image\/)/i.test(u) || u.startsWith('/')) ? u.replace(/["\\]/g, '') : '';
  };
  const num = (v) => { if (v === null || v === undefined || v === '') return '–'; const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US') : '–'; };

  // Same >= 90% gamertag match the controller roster sync uses.
  const fold = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL|]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/[\s_.\-#]/g, '');
  function similarity(a, b) {
    const x = fold(a); const y = fold(b); if (!x || !y) return 0; if (x === y) return 1;
    const prev = Array.from({ length: y.length + 1 }, (_v, i) => i);
    for (let i = 1; i <= x.length; i += 1) { let diag = prev[0]; prev[0] = i; for (let j = 1; j <= y.length; j += 1) { const up = prev[j]; prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (x[i - 1] === y[j - 1] ? 0 : 1)); diag = up; } }
    return 1 - prev[y.length] / Math.max(x.length, y.length);
  }
  const bestByTag = (list, tag) => { let best = null; let score = 0.9; for (const item of list || []) { const s = similarity(item?.name, tag); if (s >= score) { best = item; score = s; } } return best; };

  function logo(id, team) {
    const node = $(id); if (!node) return;
    const url = safeUrl(team?.logoImage);
    node.replaceChildren();
    if (url) { const img = document.createElement('img'); img.src = url; img.alt = ''; node.append(img); } else node.textContent = team?.shortName || '';
  }

  // The player sitting at this station. Varsity and JV can be on stage at the same time (e.g.
  // Varsity at 1-3, JV at 4-6), so every roster is searched; the roster open in the controller
  // wins if two players claim the same station.
  function stationPlayer(game, rosterKey) {
    const keys = [rosterKey, ...['varsity', 'jv'].filter((k) => k !== rosterKey)];
    for (const key of keys) {
      for (const [side, team, roster] of [['home', game.teams?.[0], game.rosters?.[key]], ['away', game.teams?.[1], game.awayRosters?.[key]]]) {
        const player = (roster || []).find((p) => Math.round(Number(p?.stageStation) || 0) === station);
        if (player) return { side, team: team || {}, player, roster: key };
      }
    }
    return null;
  }

  // Hero art placement: line every hero's face up at the same spot. faces.json maps the art's
  // file slug -> [faceX, faceY, width/height] (0-1 of the picture, from a face detector or the
  // top of the silhouette). Art without an entry is shown bottom-right, scaled to fit.
  const FACE_X = 0.70; const FACE_Y = 0.24; // where the face goes, as a share of the screen
  const FACE_SIZE = 0.115;                  // face height on screen, as a share of the screen height
  const TYPICAL_FACE = 0.083;               // face height in a typical picture (for art where no face was found)
  let faces = null;
  fetch('/assets/overwatch/hero-art-hd/faces.json', { cache: 'force-cache' }).then((r) => r.json()).then((f) => { faces = f; if (lastState) render(lastState); }).catch(() => { faces = {}; });
  // faces.json: art file slug -> [faceX, faceY, width/height, faceHeight] (0-1 of the picture;
  // faceHeight 0 = found from the silhouette top, no face size). Art without an entry: bottom-right, fit.
  function placeHero(url, kind = 'hero') {
    const img = $('player-hero-img');
    if (!url) { img.classList.remove('on'); img.removeAttribute('src'); return; }
    if (img.getAttribute('src') !== url) img.src = url;
    img.classList.add('on');
    img.classList.toggle('is-car', kind === 'car');
    if (kind === 'car') {
      // Car PNGs are wide side/3-quarter shots: show the whole car, big, on the right half,
      // sitting a little below the middle (behind the stats column).
      const vw = window.innerWidth; const vh = window.innerHeight;
      const ratio = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 16 / 9;
      const width = Math.min(vw * 0.58, vh * 0.85 * ratio); const height = width / ratio;
      Object.assign(img.style, { width: `${width}px`, height: `${height}px`, left: 'auto', top: 'auto', right: `${vw * 0.01}px`, bottom: `${vh * 0.04}px` });
      if (!img.naturalWidth) img.onload = () => { img.onload = null; placeHero(url, kind); };
      return;
    }
    const slug = url.split('/').pop().replace(/\.[a-z]+$/i, '');
    const f = url.includes('/hero-art-hd/') ? faces?.[slug] : null;
    const vw = window.innerWidth; const vh = window.innerHeight;
    if (!f) {
      // Old placement: fit inside a 62vw x 100vh box, bottom-right, 2vw past the right edge.
      const ratio = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 0.6;
      const height = Math.min(vh, (vw * 0.62) / ratio); const width = height * ratio;
      Object.assign(img.style, { height: `${height}px`, width: `${width}px`, left: 'auto', top: 'auto', right: `${-vw * 0.02}px`, bottom: '0' });
      if (!img.naturalWidth) img.onload = () => { img.onload = null; placeHero(url); };
      return;
    }
    const [fx, fy, ar, fh] = f;
    // Same head size for everyone, kept between 0.75 and 2.6 screen heights.
    const height = Math.min(2.6, Math.max(0.75, FACE_SIZE / (fh || TYPICAL_FACE))) * vh;
    const width = height * ar;
    Object.assign(img.style, { height: `${height}px`, width: `${width}px`, right: 'auto', bottom: 'auto',
      left: `${vw * FACE_X - fx * width}px`, top: `${vh * FACE_Y - fy * height}px` });
  }
  let lastState = null;
  window.addEventListener('resize', () => { if (lastState) render(lastState); });
  // Player portrait: only hide the initials once the picture has really loaded. If it fails
  // (wrong host, file missing on this controller) the initials stay and the reason is logged.
  let portraitUrl = null; let portraitOk = false;
  function showPortrait(url) {
    const el = $('player-portrait');
    if (url === portraitUrl) { el.classList.toggle('has-image', portraitOk); return; }
    portraitUrl = url; portraitOk = false;
    el.classList.remove('has-image'); el.style.backgroundImage = '';
    if (!url) return;
    const probe = new Image();
    probe.onload = () => { if (portraitUrl !== url) return; portraitOk = true; el.style.backgroundImage = `url("${url}")`; el.classList.add('has-image'); };
    probe.onerror = () => { if (portraitUrl === url) console.warn(`[station] player portrait did not load: ${url}`); };
    probe.src = url;
  }
  // Gamertag on one line: start at 13vh and shrink just enough to fit the text column.
  function fitName() {
    const el = $('player-handle'); const box = el?.parentElement; if (!el || !box) return;
    const max = window.innerHeight * 0.13; const min = window.innerHeight * 0.04;
    el.style.setProperty('--name-size', `${max}px`);
    const room = box.clientWidth - (parseFloat(getComputedStyle(box).paddingRight) || 0);
    const need = el.scrollWidth;
    if (room > 0 && need > room) el.style.setProperty('--name-size', `${Math.max(min, Math.floor(max * room / need * 0.98))}px`);
  }
  window.addEventListener('resize', fitName);
  document.fonts?.ready?.then(fitName);
  let lastPreset = '';
  function render(state) {
    lastState = state;
    const game = state?.games?.[state?.selectedGame] || {};
    const teams = game.teams || [];
    const rosterKey = state?.activeRoster || 'varsity';
    const cfg = state?.displays?.stations?.[station] || {};
    const preset = PRESETS.includes(cfg.preset) ? cfg.preset : 'idle';
    const st = $('st');
    const found = stationPlayer(game, rosterKey);
    // Banner/team colour: explicit team on the preset, else the station's player's team, else by
    // position (1-5 home, 6-10 away).
    const sideIndex = cfg.team === 'away' ? 1 : cfg.team === 'home' ? 0 : found ? (found.side === 'away' ? 1 : 0) : (station > 5 ? 1 : 0);
    const team = teams[sideIndex] || {};
    st.style.setProperty('--home', teams[0]?.color || '#f47920');
    st.style.setProperty('--away', teams[1]?.color || '#5e6673');
    st.style.setProperty('--team', team.color || '#f47920');
    if (preset !== lastPreset) { st.dataset.preset = ''; void st.offsetWidth; st.dataset.preset = preset; lastPreset = preset; }

    setText('idle-title', `STATION ${pad(station)}`);
    setText('idle-event', game.match?.event || '');

    setText('intro-home-name', teams[0]?.name || 'HOME');
    setText('intro-away-name', teams[1]?.name || 'AWAY');
    setText('intro-event', [game.match?.event, game.match?.round].filter(Boolean).join(' · '));
    logo('intro-home-logo', teams[0]); logo('intro-away-logo', teams[1]);

    const player = found?.player;
    setText('player-team', found?.team?.name || team.name || '');
    const handle = player?.handle || player?.name || `STATION ${pad(station)}`;
    setText('player-handle', handle);
    fitName();
    setText('player-initials', handle.slice(0, 2).toUpperCase());
    setText('player-station', pad(station));
    const gameKey = state?.selectedGame || '';
    const isValorant = gameKey === 'valorant';
    const isRocketLeague = gameKey === 'rocketleague';
    // Player cards run BETWEEN matches: they show the game that just ended (saved per station
    // when it ended), never a live readout. Nothing saved yet = name + art only, no stats.
    const savedAll = game.lastGameStats || game.overwatchLastMapStats || {};
    const saved0 = savedAll[station];
    const tagOk = (a, b) => similarity(a, b) >= 0.9;
    const saved = saved0 && (!saved0.game || saved0.game === gameKey) && (!player?.handle || !saved0.handle || tagOk(saved0.handle, player.handle)) ? saved0 : null;
    // VALORANT agents come back as slugs ('kay-o'); the art table uses display names ('KAY/O').
    const agentName = (slug) => Object.keys(game.characterArt || {}).find((k) => k.toLowerCase().replace(/[^a-z0-9]+/g, '-') === slug) || '';
    const savedChar = saved?.character || saved?.hero || '';
    const hero = (isValorant ? agentName(savedChar) || savedChar : savedChar) || player?.character || '';
    setText('player-meta', [player?.name !== handle ? player?.name : '', player?.role, isRocketLeague ? player?.character : hero].filter(Boolean).join(' · '));
    showPortrait(safeUrl(player?.playerImage));
    // Background art: Rocket League = the player's own car PNG (roster 'Player car PNG', manual or
    // auto-rendered from the loadout); other games = the hero/agent/fighter art.
    const art = isRocketLeague ? player?.characterImage : (hero ? game.characterArt?.[hero]?.url : '');
    placeHero(safeUrl(art), isRocketLeague ? 'car' : 'hero');
    $('st').classList.toggle('game-rl', isRocketLeague);
    const COLUMNS = {
      overwatch: [['elims', 'ELIMS'], ['deaths', 'DEATHS'], ['assists', 'ASSISTS'], ['damage', 'DAMAGE'], ['healing', 'HEALING'], ['mitigation', 'MITIGATED']],
      valorant: [['kills', 'KILLS'], ['deaths', 'DEATHS'], ['assists', 'ASSISTS']],
      rocketleague: [['score', 'SCORE'], ['goals', 'GOALS'], ['assists', 'ASSISTS'], ['saves', 'SAVES'], ['shots', 'SHOTS'], ['demos', 'DEMOS']]
    };
    let rows = []; let label = '';
    if (saved?.stats && COLUMNS[gameKey]) {
      const unit = isRocketLeague ? 'LAST GAME' : 'LAST MAP';
      label = `${unit}${saved.map ? ` · ${String(saved.map).toUpperCase()}` : ''}`;
      rows = COLUMNS[gameKey].map(([k, l]) => [saved.stats[k], l]);
    }
    $('st').classList.toggle('stats-3', rows.length === 3);
    setText('player-stats-label', label);
    $('player-stats').replaceChildren(...rows.map(([v, l]) => {
      const d = document.createElement('div'); const b = document.createElement('b'); const i = document.createElement('i');
      b.textContent = typeof v === 'string' && !/^\d+$/.test(v) ? v : num(v); i.textContent = l; d.append(b, i); return d;
    }));

    // banner: 5-screen canvas, this station shows slot (station-1) % 5
    const canvas = $('banner-canvas');
    canvas.style.setProperty('--span', '5');
    canvas.style.setProperty('--slot', String((station - 1) % 5));
    logo('banner-logo', team);
    setText('banner-kicker', team.shortName || (sideIndex ? 'AWAY' : 'HOME'));
    setText('banner-name', team.name || '');
    // Banner lists the roster of the player at this station (Varsity or JV), else the open one.
    const bannerKey = found?.roster || rosterKey;
    const roster = (sideIndex ? game.awayRosters?.[bannerKey] : game.rosters?.[bannerKey]) || [];
    $('banner-roster').replaceChildren(...roster.filter((p) => p?.handle).slice(0, 5).map((p) => {
      const d = document.createElement('div'); const i = document.createElement('i');
      i.textContent = (p.role || '').toUpperCase(); d.append(i, document.createTextNode(p.handle)); return d;
    }));

    setText('score-home', Number(teams[0]?.score) || 0);
    setText('score-away', Number(teams[1]?.score) || 0);
    setText('score-map', game.mapRows?.[game.activeMap || 0]?.map || '');
    logo('score-home-logo', teams[0]); logo('score-away-logo', teams[1]);
  }

  async function start() {
    try { render(await fetch('/api/state', { cache: 'no-store' }).then((r) => r.json())); } catch {}
    if (window.isuLiveState) window.isuLiveState(render);
    else { const events = new EventSource('/events'); events.onmessage = (event) => { try { render(JSON.parse(event.data)); } catch {} }; }
  }
  window.__station = { render, station };
  start();
})();
