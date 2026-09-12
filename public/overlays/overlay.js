(() => {
  const OVERLAY_QUERY = new URLSearchParams(location.search);
  const OUTPUT_MODES = new Set(['fill', 'key', 'pair', 'test-fill', 'test-key']);
  const requestedOutput = (OVERLAY_QUERY.get('output') || '').toLowerCase();
  const legacyKeyOutput = ['1', 'true', 'yes'].includes((OVERLAY_QUERY.get('key') || '').toLowerCase());
  const OUTPUT_MODE = legacyKeyOutput ? 'key' : (requestedOutput || 'fill');
  const OUTPUT_VALID = OUTPUT_MODES.has(OUTPUT_MODE);
  const IS_KEY_OUTPUT = OUTPUT_MODE === 'key' || OUTPUT_MODE === 'test-key';
  const IS_PAIR_OUTPUT = OUTPUT_MODE === 'pair';
  const IS_TEST_OUTPUT = OUTPUT_MODE === 'test-fill' || OUTPUT_MODE === 'test-key';
  document.documentElement.dataset.output = OUTPUT_VALID ? OUTPUT_MODE : 'invalid';
  document.body.dataset.output = OUTPUT_VALID ? OUTPUT_MODE : 'invalid';
  document.body.classList.toggle('key-output', OUTPUT_VALID && IS_KEY_OUTPUT);
  document.body.classList.toggle('test-output', OUTPUT_VALID && IS_TEST_OUTPUT);

  const GAME_META = {
    overwatch: { name: 'OVERWATCH 2', code: 'OW2', accent: '#f06414', score: 'MAP SCORE' },
    valorant: { name: 'VALORANT', code: 'VAL', accent: '#ff4655', score: 'SERIES SCORE' },
    rocketleague: { name: 'ROCKET LEAGUE', code: 'RL', accent: '#2d8cff', score: 'SERIES SCORE' },
    smash: { name: 'SMASH BROS. ULTIMATE', code: 'SSBU', accent: '#e03b32', score: 'SET SCORE' },
    callofduty: { name: 'CALL OF DUTY', code: 'COD', accent: '#8dd936', score: 'MAP SCORE' }
  };

  const FALLBACK = {
    selectedGame: 'overwatch',
    activeRoster: 'varsity',
    games: {
      overwatch: {
        teams: [
          { name: 'IDAHO STATE', shortName: 'ISU', color: '#f47920', secondaryColor: '#101012', secondaryColorEnabled: true, score: 0, detailScore: 0 },
          { name: 'OPPONENT', shortName: 'OPP', color: '#5e6673', secondaryColor: '#d9dce2', secondaryColorEnabled: false, score: 0, detailScore: 0 }
        ],
        match: { event: 'COLLEGIATE ESPORTS', round: 'REGULAR SEASON', format: 'FIRST TO 3 MAPS', live: false },
        activeMap: 0,
        mapRows: [{ map: 'BUSAN', mode: 'CONTROL', score: ['', ''], winner: null }],
        veto: { bans: ['BREEZE', 'ICEBOX', 'PEARL', 'SUNSET'], picks: [{ map: 'ASCENT', attackers: 0 }, { map: 'BIND', attackers: 1 }, { map: 'HAVEN', attackers: 0 }] },
        rosters: { varsity: [], jv: [] },
        awayRosters: { varsity: [], jv: [] },
        showAwayRoster: false,
        characterArt: {}
      }
    }
  };

  let activeRenderRoot = null;
  let pairRoots = null;
  const $ = (selector, root = activeRenderRoot || document) => root.querySelector(selector);
  const $$ = (selector, root = activeRenderRoot || document) => [...root.querySelectorAll(selector)];
  const lastMapPoolSignatureByRoot = new WeakMap();
  const setText = (selector, value, root = activeRenderRoot || document) => {
    const element = $(selector, root);
    if (element) element.textContent = String(value ?? '');
  };

  function renderLogo(selector, team) {
    const node = typeof selector === 'string' ? $(selector) : selector;
    if (!node) return;
    const logo = safeImageUrl(team?.logoImage, '');
    node.classList.toggle('has-image', Boolean(logo));
    node.replaceChildren();
    if (logo) {
      const image = document.createElement('img');
      image.src = logo;
      image.alt = '';
      node.append(image);
    } else {
      node.textContent = team?.shortName || '';
    }
  }

  function getActive(state) {
    const selectedGame = GAME_META[state?.selectedGame] ? state.selectedGame : 'overwatch';
    const game = state?.games?.[selectedGame] || FALLBACK.games.overwatch;
    return { selectedGame, game, meta: GAME_META[selectedGame] };
  }

  function applyTheme(selectedGame, meta) {
    document.body.dataset.game = selectedGame;
    document.documentElement.style.setProperty('--game-accent', meta.accent);
  }

  function formatClock(seconds, overtime = false) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    const formatted = `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
    return overtime ? `OVERTIME · ${formatted}` : formatted;
  }

  function arenaName(value) {
    const known = {
      Stadium_P: 'DFH STADIUM', EuroStadium_P: 'MANNFIELD', ChampsStadium_P: 'CHAMPIONS FIELD',
      UtopiaStadium_P: 'UTOPIA COLISEUM', Park_P: 'BECKWITH PARK', CHN_Stadium_P: 'FORBIDDEN TEMPLE',
      cs_day_p: 'DEADEYE CANYON', CS_Day_P: 'DEADEYE CANYON', CS_HW_P: 'DEADEYE CANYON',
      Farm_P: 'FARMSTEAD', NeoTokyo_P: 'NEO TOKYO', TrainStation_P: 'URBAN CENTRAL',
      Underwater_P: 'AQUADOME', Beach_P: 'SALTY SHORES', Wasteland_P: 'WASTELAND',
      ARC_P: 'STARBASE ARC', ThrowbackStadium_P: 'THROWBACK STADIUM',
      SovereignHeights_P: 'SOVEREIGN HEIGHTS', Core707_P: 'CORE 707', Rivals_P: 'RIVALS ARENA'
    };
    if (!value) return '';
    return known[value] || String(value).replace(/_P$/i, '').replaceAll('_', ' ').toUpperCase();
  }

  function renderRocketLeaguePlayers(game, selectedGame) {
    const board = $('#rl-boost-board');
    if (!board) return;
    const live = game.rocketLeague?.live;
    const players = live?.players || [];
    board.hidden = selectedGame !== 'rocketleague' || !players.length;
    if (board.hidden) return;
    const blueTeam = Number(game.rocketLeague?.blueTeam) || 0;
    const destinationFor = (teamNum) => Number(teamNum) === 0 ? blueTeam : 1 - blueTeam;
    [0, 1].forEach((teamIndex) => {
      const container = teamIndex === 0 ? $('#rl-home-players') : $('#rl-away-players');
      container.replaceChildren();
      players.filter((player) => destinationFor(player.teamNum) === teamIndex).slice(0, 4).forEach((player) => {
        const boost = player.boost === null || player.boost === undefined ? null : Math.max(0, Math.min(100, Number(player.boost)));
        const card = document.createElement('div');
        card.className = `rl-boost-player${player.spectated ? ' spectated' : ''}${player.demolished ? ' demolished' : ''}`;
        const name = document.createElement('strong');
        name.textContent = player.name || 'PLAYER';
        const meter = document.createElement('span');
        const fill = document.createElement('i');
        fill.style.width = `${boost ?? 0}%`;
        meter.append(fill);
        const amount = document.createElement('b');
        amount.textContent = boost === null ? '—' : String(Math.round(boost));
        card.append(name, meter, amount);
        container.append(card);
      });
    });
  }

  function renderScoreboard(state) {
    const root = $('[data-overlay="scoreboard"]');
    if (!root) return;
    const { selectedGame, game, meta } = getActive(state);
    applyTheme(selectedGame, meta);
    const teams = game.teams || FALLBACK.games.overwatch.teams;
    const activeMap = game.mapRows?.[game.activeMap || 0] || game.mapRows?.[0] || FALLBACK.games.overwatch.mapRows[0];
    setText('#score-event', game.match?.event);
    setText('#score-round', game.match?.round);
    setText('#score-format', game.match?.format);
    setText('#score-label', meta.score);
    setText('#game-code', game.match?.live ? 'LIVE' : meta.code);
    setText('#home-name', teams[0]?.name);
    setText('#away-name', teams[1]?.name);
    renderLogo('#home-logo', teams[0]);
    renderLogo('#away-logo', teams[1]);
    setText('#home-score', teams[0]?.score ?? 0);
    setText('#away-score', teams[1]?.score ?? 0);
    const rlLive = game.rocketLeague?.live;
    setText('#home-detail', selectedGame === 'rocketleague' ? `GOALS · ${teams[0]?.detailScore ?? 0}` : teams[0]?.detailScore ? `LIVE · ${teams[0].detailScore}` : '');
    setText('#away-detail', selectedGame === 'rocketleague' ? `GOALS · ${teams[1]?.detailScore ?? 0}` : teams[1]?.detailScore ? `LIVE · ${teams[1].detailScore}` : '');
    setText('#map-number', `${selectedGame === 'rocketleague' ? 'GAME' : 'MAP'} ${(game.activeMap || 0) + 1}`);
    setText('#map-name', selectedGame === 'rocketleague' && rlLive?.arena ? arenaName(rlLive.arena) : activeMap.map);
    setText('#map-mode', selectedGame === 'rocketleague' && rlLive ? formatClock(rlLive.timeSeconds, rlLive.overtime) : activeMap.mode);
    root.style.setProperty('--home-color', teams[0]?.color || '#f47920');
    root.style.setProperty('--away-color', teams[1]?.color || '#5e6673');
    root.style.setProperty('--home-secondary', teams[0]?.secondaryColorEnabled ? teams[0].secondaryColor : teams[0]?.color || '#f47920');
    root.style.setProperty('--away-secondary', teams[1]?.secondaryColorEnabled ? teams[1].secondaryColor : teams[1]?.color || '#5e6673');
    root.classList.toggle('is-live', Boolean(game.match?.live));
    renderRocketLeaguePlayers(game, selectedGame);
  }

  function renderValorantVeto(game) {
    const teams = game.teams || FALLBACK.games.overwatch.teams;
    const veto = game.veto || FALLBACK.games.overwatch.veto;
    $$('[data-ban]').forEach((element, index) => {
      const map = veto.bans?.[index] || 'TBD';
      element.textContent = map;
      const half = element.closest('.ban-half');
      const card = element.closest('.ban-card');
      const artwork = safeImageUrl(game.mapArt?.[map]?.url, '');
      if (half) half.style.setProperty('--map-art', artwork ? `url("${artwork}")` : 'none');
      if (card) card.classList.toggle('has-map-art', Boolean(artwork));
    });
    $$('[data-pick-card]').forEach((card, index) => {
      const pick = veto.picks?.[index] || {};
      const attacker = Number(pick.attackers) === 1 ? 1 : 0;
      const defender = attacker === 0 ? 1 : 0;
      setText(`[data-pick-map="${index}"]`, pick.map || 'TBD');
      const artwork = safeImageUrl(game.mapArt?.[pick.map]?.url, '');
      card.classList.toggle('has-map-art', Boolean(artwork));
      card.style.setProperty('--map-art', artwork ? `url("${artwork}")` : 'none');
      renderLogo(`[data-attacker="${index}"]`, teams[attacker]);
      renderLogo(`[data-defender="${index}"]`, teams[defender]);
      card.style.setProperty('--attacker-primary', teams[attacker]?.color || '#f47920');
      card.style.setProperty('--attacker-secondary', teams[attacker]?.secondaryColorEnabled ? teams[attacker].secondaryColor : teams[attacker]?.color || '#f47920');
      card.style.setProperty('--defender-primary', teams[defender]?.color || '#4da1ff');
      card.style.setProperty('--defender-secondary', teams[defender]?.secondaryColorEnabled ? teams[defender].secondaryColor : teams[defender]?.color || '#4da1ff');
      const line = pick.score?.filter((value) => value !== '').join(' — ');
      card.classList.toggle('has-result', Boolean(line));
      card.dataset.score = line || '';
    });
  }

  function visibleMapRows(game, selectedGame) {
    const length = Math.max(1, Number(game.seriesLength) || (game.mapRows || []).length);
    const cappedLength = selectedGame === 'valorant' ? Math.min(3, length) : length;
    return (game.mapRows || []).slice(0, Math.min((game.mapRows || []).length, cappedLength));
  }

  function hasStartedScore(score = []) {
    return score.some((value) => Number(value) > 0);
  }

  function valorantHasMapResults(game) {
    return visibleMapRows(game, 'valorant').some((row) => hasStartedScore(row.score || []))
      || (game.veto?.picks || []).some((pick) => hasStartedScore(pick.score || []));
  }

  function formatDuration(seconds) {
    const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`;
  }

  function renderGenericMaps(game, selectedGame) {
    const container = $('#generic-map-pool');
    const rows = visibleMapRows(game, selectedGame);
    const signature = JSON.stringify({
      selectedGame,
      activeMap: game.activeMap,
      seriesLength: game.seriesLength,
      teams: (game.teams || []).map((team) => ({ shortName: team.shortName, score: team.score })),
      rows: rows.map((row) => ({ map: row.map, mode: row.mode, score: row.score, winner: row.winner, status: row.status, overtime: row.overtime, overtimeSeconds: row.overtimeSeconds }))
    });
    const renderRoot = activeRenderRoot || document;
    if (signature === lastMapPoolSignatureByRoot.get(renderRoot)) return;
    lastMapPoolSignatureByRoot.set(renderRoot, signature);
    container.replaceChildren();
    container.style.setProperty('--map-count', Math.max(1, Math.min(7, rows.length)));
    const teams = game.teams || FALLBACK.games.overwatch.teams;
    rows.forEach((row, index) => {
      const card = document.createElement('article');
      card.className = `generic-map-card${index === game.activeMap ? ' active' : ''}${row.winner !== null ? ' complete' : ''}`;
      const artwork = game.mapArt?.[row.map] || {};
      const image = document.createElement('img');
      image.className = 'generic-map-image';
      image.alt = '';
      const artworkUrl = safeImageUrl(artwork.url, '');
      if (artworkUrl) image.src = artworkUrl;
      else image.hidden = true;
      const number = document.createElement('span');
      number.textContent = `MAP ${String(index + 1).padStart(2, '0')}`;
      const map = document.createElement('strong');
      map.textContent = row.map || 'TBD';
      const mode = document.createElement('small');
      mode.textContent = row.mode || '';
      const score = document.createElement('p');
      score.textContent = row.score?.some(Boolean) ? `${row.score[0] || '0'} - ${row.score[1] || '0'}` : row.winner !== null ? `${teams[row.winner]?.shortName || ''} WINS` : 'UPCOMING';
      if (row.overtime) {
        const overtime = document.createElement('span');
        overtime.className = 'map-overtime';
        const label = document.createElement('b');
        label.textContent = 'OT';
        overtime.append(label, document.createTextNode(` ${formatDuration(row.overtimeSeconds)}`));
        score.append(overtime);
      }
      card.append(image, number, map, mode, score);
      container.append(card);
    });
  }

  function renderMapPool(state) {
    if (!$('[data-overlay="map-pool"]')) return;
    const { selectedGame, game, meta } = getActive(state);
    applyTheme(selectedGame, meta);
    const teams = game.teams || FALLBACK.games.overwatch.teams;
    setText('#map-game-code', meta.code);
    setText('#map-game-name', meta.name);
    setText('#map-event', game.match?.event);
    setText('#map-series', `${teams[0]?.shortName || 'HOME'} ${teams[0]?.score || 0} — ${teams[1]?.score || 0} ${teams[1]?.shortName || 'AWAY'}`);
    renderLogo('#map-home-logo', teams[0]);
    renderLogo('#map-away-logo', teams[1]);
    const root = $('[data-overlay="map-pool"]');
    root.style.setProperty('--home-color', teams[0]?.color || '#f47920');
    root.style.setProperty('--home-secondary', teams[0]?.secondaryColorEnabled ? teams[0].secondaryColor : teams[0]?.color || '#f47920');
    root.style.setProperty('--away-color', teams[1]?.color || '#5e6673');
    root.style.setProperty('--away-secondary', teams[1]?.secondaryColorEnabled ? teams[1].secondaryColor : teams[1]?.color || '#5e6673');
    const valorant = $('#valorant-veto');
    const generic = $('#generic-map-pool');
    const showValorantVeto = selectedGame === 'valorant' && !valorantHasMapResults(game);
    valorant.hidden = !showValorantVeto;
    generic.hidden = showValorantVeto;
    if (showValorantVeto) {
      setText('.overlay-titlebar h1', 'MAP PICKS / BANS');
      renderValorantVeto(game);
    } else {
      setText('.overlay-titlebar h1', 'MAP POOL / SERIES');
      renderGenericMaps(game, selectedGame);
    }
  }

  const rosterTimersByRoot = new WeakMap();
  const lastRosterSignatureByRoot = new WeakMap();

  function safeImageUrl(value, fallback) {
    if (typeof value === 'string' && value.startsWith('http://127.0.0.1:3174/user-assets/')) return value;
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
    if (typeof value === 'string' && value.startsWith('/assets/')) return value;
    return fallback;
  }

  function clearRosterTimers() {
    const root = activeRenderRoot || document;
    const timers = rosterTimersByRoot.get(root) || [];
    timers.forEach((timer) => clearTimeout(timer));
    rosterTimersByRoot.set(root, []);
  }

  function rosterAfter(callback, delay) {
    const root = activeRenderRoot || document;
    const timers = rosterTimersByRoot.get(root) || [];
    const renderRoot = activeRenderRoot;
    timers.push(setTimeout(() => {
      const previousRoot = activeRenderRoot;
      activeRenderRoot = renderRoot;
      callback();
      activeRenderRoot = previousRoot;
    }, delay));
    rosterTimersByRoot.set(root, timers);
  }

  function renderRosterTeam(game, meta, program, side) {
    const container = $('#roster-cards');
    const selectedGame = document.body.dataset.game || '';
    const teamIndex = side === 'away' ? 1 : 0;
    const team = game.teams?.[teamIndex] || FALLBACK.games.overwatch.teams[teamIndex];
    const rosterCollection = side === 'away' ? game.awayRosters : game.rosters;
    const roster = rosterCollection?.[program] || [];
    const visibleRoster = roster.filter((player) => player.handle || player.name || player.playerImage || player.character || player.characterImage);
    const fallbackCount = selectedGame === 'rocketleague' ? 3 : selectedGame === 'smash' ? 1 : selectedGame === 'callofduty' ? 4 : 5;
    const fallbackRoster = Array.from({ length: fallbackCount }, (_, index) => ({ role: index === 0 ? 'Starter' : 'Starter' }));
    const players = (visibleRoster.length ? visibleRoster : roster.length ? roster : fallbackRoster).slice(0, 6);
    setText('#roster-game', meta.name);
    setText('#roster-team-name', team.name || (side === 'home' ? 'HOME TEAM' : 'AWAY TEAM'));
    setText('#roster-program', program === 'jv' ? 'JUNIOR VARSITY' : 'VARSITY');
    setText('#roster-footer-game', meta.name);
    setText('#roster-phase-label', `${side.toUpperCase()} PLAYERS`);
    const stage = $('.roster-stage');
    stage.style.setProperty('--team-primary', team.color || '#f47920');
    stage.style.setProperty('--team-secondary', team.secondaryColorEnabled ? team.secondaryColor : team.color || '#f47920');
    stage.dataset.side = side;
    stage.classList.remove('character-mode');
    stage.classList.add('roster-sequence');
    container.style.setProperty('--roster-count', Math.max(players.length, 1));
    container.replaceChildren();

    players.forEach((player, index) => {
      const card = document.createElement('article');
      card.className = 'roster-card';
      card.style.setProperty('--card-index', index);
      const media = document.createElement('div');
      media.className = 'roster-media';
      const playerImage = document.createElement('img');
      playerImage.className = 'player-photo';
      playerImage.alt = '';
      const characterImage = document.createElement('img');
      characterImage.className = 'character-photo';
      characterImage.alt = '';
      const sharedArtwork = game.characterArt?.[player.character] || {};
      const characterArtUrl = selectedGame === 'rocketleague' ? player.characterImage : sharedArtwork.url || player.characterImage;
      playerImage.src = safeImageUrl(player.playerImage || (selectedGame === 'rocketleague' ? characterArtUrl : ''), './assets/player-placeholder.svg');
      characterImage.src = safeImageUrl(characterArtUrl, './assets/character-placeholder.svg');
      const number = document.createElement('span');
      number.className = 'roster-number';
      number.textContent = String(index + 1).padStart(2, '0');
      media.append(playerImage, characterImage, number);
      const copy = document.createElement('div');
      copy.className = 'roster-copy';
      const role = document.createElement('span');
      role.textContent = player.role || 'PLAYER';
      const name = document.createElement('strong');
      name.textContent = player.handle || player.name || `PLAYER ${index + 1}`;
      const realName = document.createElement('small');
      realName.className = 'player-real-name';
      realName.textContent = player.name || 'IDAHO STATE';
      const character = document.createElement('small');
      character.className = 'character-name';
      character.textContent = player.character || 'CHARACTER TBD';
      copy.append(role, name, realName, character);
      card.append(media, copy);
      container.append(card);
      rosterAfter(() => card.classList.add('is-visible'), 250 + (index * 140));
    });
  }

  function showRosterCharacters(side) {
    const stage = $('.roster-stage');
    stage?.classList.add('character-mode');
    setText('#roster-phase-label', `${side.toUpperCase()} IN-GAME`);
  }

  function renderRoster(state) {
    const container = $('#roster-cards');
    if (!container) return;
    const { selectedGame, game, meta } = getActive(state);
    applyTheme(selectedGame, meta);
    const requestedProgram = OVERLAY_QUERY.get('program') || OVERLAY_QUERY.get('team');
    const program = requestedProgram === 'jv' ? 'jv' : (requestedProgram === 'varsity' ? 'varsity' : state.activeRoster || 'varsity');
    const renderRoot = activeRenderRoot || document;
    const rosterSignature = JSON.stringify({
      selectedGame,
      program,
      showAwayRoster: game.showAwayRoster,
      teams: (game.teams || []).map((team) => ({
        name: team.name,
        color: team.color,
        secondaryColor: team.secondaryColor,
        secondaryColorEnabled: team.secondaryColorEnabled
      })),
      home: (game.rosters?.[program] || []).map((player) => ({
        handle: player.handle,
        name: player.name,
        role: player.role,
        character: player.character,
        playerImage: player.playerImage,
        characterImage: player.characterImage
      })),
      away: (game.awayRosters?.[program] || []).map((player) => ({
        handle: player.handle,
        name: player.name,
        role: player.role,
        character: player.character,
        playerImage: player.playerImage,
        characterImage: player.characterImage
      }))
    });
    if (rosterSignature === lastRosterSignatureByRoot.get(renderRoot)) return;
    lastRosterSignatureByRoot.set(renderRoot, rosterSignature);
    clearRosterTimers();
    const stage = $('.roster-stage');
    stage.classList.remove('team-slide-out', 'team-slide-in');
    setText('#roster-cycle-label', game.showAwayRoster ? 'HOME -> AWAY - 15 SEC' : selectedGame === 'rocketleague' ? 'PLAYER -> CAR - 7 SEC' : 'PLAYER -> CHARACTER - 7 SEC');
    renderRosterTeam(game, meta, program, 'home');
    rosterAfter(() => showRosterCharacters('home'), 7000);

    if (game.showAwayRoster) {
      rosterAfter(() => {
        stage.classList.remove('character-mode');
        stage.classList.add('team-slide-out');
        setText('#roster-phase-label', 'CHANGING SIDES');
      }, 14500);
      rosterAfter(() => {
        renderRosterTeam(game, meta, program, 'away');
        stage.classList.remove('team-slide-out');
        stage.classList.add('team-slide-in');
      }, 15350);
      rosterAfter(() => stage.classList.remove('team-slide-in'), 16300);
      rosterAfter(() => showRosterCharacters('away'), 22350);
    }
  }

  function ensurePairRoots() {
    if (pairRoots) return pairRoots;
    const sourceRoot = $('[data-overlay]', document);
    if (!sourceRoot) return null;
    const fillRoot = sourceRoot;
    const keyRoot = sourceRoot.cloneNode(true);
    const wrapper = document.createElement('main');
    const fillScene = document.createElement('section');
    const keyScene = document.createElement('section');
    wrapper.className = 'paired-output-root';
    fillScene.className = 'paired-scene paired-fill-scene';
    keyScene.className = 'paired-scene paired-key-scene';
    fillScene.append(fillRoot);
    keyScene.append(keyRoot);
    wrapper.append(fillScene, keyScene);
    document.body.replaceChildren(wrapper);
    pairRoots = { fill: fillRoot, key: keyRoot };
    return pairRoots;
  }

  function renderCurrentOverlay(state) {
    renderScoreboard(state);
    renderMapPool(state);
    renderRoster(state);
  }

  function renderPaired(state) {
    const roots = ensurePairRoots();
    if (!roots) return;
    const previousRoot = activeRenderRoot;
    activeRenderRoot = roots.fill;
    renderCurrentOverlay(state);
    roots.fill.dataset.outputMode = 'fill';
    roots.fill.dataset.pairedSide = 'fill';
    updateDiagnostics(state, roots.fill, 'PAIR FILL');
    activeRenderRoot = roots.key;
    renderCurrentOverlay(state);
    roots.key.dataset.outputMode = 'key';
    roots.key.dataset.pairedSide = 'key';
    updateDiagnostics(state, roots.key, 'PAIR KEY');
    activeRenderRoot = previousRoot;
  }

  function render(state) {
    if (!OUTPUT_VALID) {
      renderDiagnosticsPage(`Invalid output mode: ${OUTPUT_MODE || 'empty'}`);
      return;
    }
    if (IS_TEST_OUTPUT) {
      renderTestOutput(state);
      return;
    }
    if (IS_PAIR_OUTPUT) {
      renderPaired(state);
      return;
    }
    renderCurrentOverlay(state);
    updateDiagnostics(state);
  }

  function stateRevision(state) {
    return state?.updatedAt ? Date.parse(state.updatedAt) || 0 : 0;
  }

  function animationEpoch(state) {
    return state?.animationStartMs || stateRevision(state);
  }

  function updateDiagnostics(state, targetRoot = null, label = OUTPUT_MODE.toUpperCase()) {
    const root = targetRoot || $('[data-overlay]');
    if (!root) return;
    root.dataset.outputMode = label.toLowerCase();
    root.dataset.stateRevision = String(stateRevision(state));
    root.dataset.animationEpoch = String(animationEpoch(state));
    if (OVERLAY_QUERY.get('diagnostics') !== '1') return;
    let diagnostics = $('.overlay-diagnostics', root);
    if (!diagnostics) {
      diagnostics = document.createElement('div');
      diagnostics.className = 'overlay-diagnostics';
      root.append(diagnostics);
    }
    const size = IS_PAIR_OUTPUT ? '3840x1080' : '1920x1080';
    diagnostics.textContent = `${label} - REV ${stateRevision(state)} - ${size} - EPOCH ${animationEpoch(state)}`;
  }

  function renderDiagnosticsPage(message) {
    document.body.replaceChildren();
    const diagnostics = document.createElement('main');
    diagnostics.className = 'overlay-diagnostics-page';
    diagnostics.innerHTML = `<strong>OVERLAY OUTPUT ERROR</strong><span>${message}</span><small>Use output=fill, output=key, output=pair, output=test-fill, or output=test-key.</small>`;
    document.body.append(diagnostics);
  }

  function renderTestOutput(state) {
    const revision = stateRevision(state);
    const epoch = animationEpoch(state) || revision || Date.now();
    let root = $('#overlay-test-root');
    if (!root) {
      document.body.replaceChildren();
      root = document.createElement('main');
      root.id = 'overlay-test-root';
      root.dataset.overlay = 'test';
      root.className = 'overlay-test-root';
      root.innerHTML = `
        <section class="test-ramp">
          ${[0, 25, 50, 75, 100].map((value) => `<div style="--alpha:${value / 100}"><b>${value}%</b></div>`).join('')}
        </section>
        <section class="test-copy"><h1>ISU ESPORTS KEY/FILL TEST</h1><p>Colored antialiased text, alpha panels, shadow, glow, and motion.</p></section>
        <div class="test-logo"><b>IS</b></div>
        <div class="test-glow"></div>
        <div class="test-motion"></div>
        <footer class="overlay-diagnostics"></footer>`;
      document.body.append(root);
    }
    root.style.setProperty('--animation-epoch', String(epoch));
    root.querySelector('.overlay-diagnostics').textContent = `${OUTPUT_MODE.toUpperCase()} - REV ${revision} - 1920x1080 - EPOCH ${epoch}`;
  }

  async function start() {
    try {
      const state = await fetch('/api/state', { cache: 'no-store' }).then((response) => response.json());
      render(state?.games ? state : FALLBACK);
    } catch {
      render(FALLBACK);
    }
    const events = new EventSource('/events');
    events.onmessage = (event) => {
      try { render(JSON.parse(event.data)); } catch {}
    };
  }

  document.addEventListener('DOMContentLoaded', start);
})();
