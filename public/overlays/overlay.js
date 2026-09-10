(() => {
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

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const setText = (selector, value, root = document) => {
    const element = $(selector, root);
    if (element) element.textContent = String(value ?? '');
  };

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
      UtopiaStadium_P: 'UTOPIA COLISEUM', Park_P: 'BECKWITH PARK', CHN_Stadium_P: 'FORBIDDEN TEMPLE'
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
    const updateInterval = Math.max(1, Math.min(50, Number(game.rocketLeague?.updateIntervalMs) || 33));
    board.style.setProperty('--boost-transition-ms', `${updateInterval}ms`);
    const blueTeam = Number(game.rocketLeague?.blueTeam) || 0;
    const destinationFor = (teamNum) => Number(teamNum) === 0 ? blueTeam : 1 - blueTeam;
    [0, 1].forEach((teamIndex) => {
      const container = teamIndex === 0 ? $('#rl-home-players') : $('#rl-away-players');
      const existing = new Map([...container.children].map((card) => [card.dataset.playerKey, card]));
      players.filter((player) => destinationFor(player.teamNum) === teamIndex).slice(0, 4).forEach((player) => {
        const boost = player.boost === null || player.boost === undefined ? null : Math.max(0, Math.min(100, Number(player.boost)));
        const playerKey = String(player.id || `${player.teamNum}|${player.shortcut}|${player.name}`);
        let card = existing.get(playerKey);
        if (!card) {
          card = document.createElement('div');
          card.dataset.playerKey = playerKey;
          const name = document.createElement('strong');
          name.className = 'rl-boost-name';
          const meter = document.createElement('span');
          const fill = document.createElement('i');
          fill.className = 'rl-boost-fill';
          meter.append(fill);
          const amount = document.createElement('b');
          amount.className = 'rl-boost-value';
          card.append(name, meter, amount);
        }
        card.className = `rl-boost-player${player.spectated ? ' spectated' : ''}${player.demolished ? ' demolished' : ''}`;
        card.querySelector('.rl-boost-name').textContent = player.name || 'PLAYER';
        const fill = card.querySelector('.rl-boost-fill');
        fill.style.width = `${boost ?? 0}%`;
        card.querySelector('.rl-boost-value').textContent = boost === null ? '—' : String(Math.round(boost));
        container.append(card);
        existing.delete(playerKey);
      });
      existing.forEach((card) => card.remove());
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
    setText('#home-logo', teams[0]?.shortName);
    setText('#away-logo', teams[1]?.shortName);
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
    $$('[data-ban]').forEach((element, index) => { element.textContent = veto.bans?.[index] || 'TBD'; });
    $$('[data-pick-card]').forEach((card, index) => {
      const pick = veto.picks?.[index] || {};
      const attacker = Number(pick.attackers) === 1 ? 1 : 0;
      const defender = attacker === 0 ? 1 : 0;
      setText(`[data-pick-map="${index}"]`, pick.map || 'TBD');
      setText(`[data-attacker="${index}"]`, teams[attacker]?.shortName || 'TBD');
      setText(`[data-defender="${index}"]`, teams[defender]?.shortName || 'TBD');
      card.style.setProperty('--attacker-primary', teams[attacker]?.color || '#f47920');
      card.style.setProperty('--attacker-secondary', teams[attacker]?.secondaryColorEnabled ? teams[attacker].secondaryColor : teams[attacker]?.color || '#f47920');
      card.style.setProperty('--defender-primary', teams[defender]?.color || '#4da1ff');
      card.style.setProperty('--defender-secondary', teams[defender]?.secondaryColorEnabled ? teams[defender].secondaryColor : teams[defender]?.color || '#4da1ff');
      const line = pick.score?.filter((value) => value !== '').join(' — ');
      card.classList.toggle('has-result', Boolean(line));
      card.dataset.score = line || '';
    });
  }

  function renderGenericMaps(game) {
    const container = $('#generic-map-pool');
    container.replaceChildren();
    const teams = game.teams || FALLBACK.games.overwatch.teams;
    (game.mapRows || []).slice(0, 7).forEach((row, index) => {
      const card = document.createElement('article');
      card.className = `generic-map-card${index === game.activeMap ? ' active' : ''}${row.winner !== null ? ' complete' : ''}`;
      const number = document.createElement('span');
      number.textContent = `MAP ${String(index + 1).padStart(2, '0')}`;
      const map = document.createElement('strong');
      map.textContent = row.map || 'TBD';
      const mode = document.createElement('small');
      mode.textContent = row.mode || '';
      const score = document.createElement('p');
      score.textContent = row.score?.some(Boolean) ? `${row.score[0] || '0'} — ${row.score[1] || '0'}` : row.winner !== null ? `${teams[row.winner]?.shortName || ''} WINS` : 'UPCOMING';
      card.append(number, map, mode, score);
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
    const root = $('[data-overlay="map-pool"]');
    root.style.setProperty('--home-color', teams[0]?.color || '#f47920');
    root.style.setProperty('--home-secondary', teams[0]?.secondaryColorEnabled ? teams[0].secondaryColor : teams[0]?.color || '#f47920');
    root.style.setProperty('--away-color', teams[1]?.color || '#5e6673');
    root.style.setProperty('--away-secondary', teams[1]?.secondaryColorEnabled ? teams[1].secondaryColor : teams[1]?.color || '#5e6673');
    const valorant = $('#valorant-veto');
    const generic = $('#generic-map-pool');
    valorant.hidden = selectedGame !== 'valorant';
    generic.hidden = selectedGame === 'valorant';
    setText('.overlay-titlebar h1', selectedGame === 'valorant' ? 'MAP PICKS / BANS' : 'MAP POOL / SERIES');
    if (selectedGame === 'valorant') renderValorantVeto(game);
    else renderGenericMaps(game);
  }

  let rosterTimers = [];

  function safeImageUrl(value, fallback) {
    if (typeof value === 'string' && value.startsWith('http://127.0.0.1:3174/user-assets/')) return value;
    return fallback;
  }

  function clearRosterTimers() {
    rosterTimers.forEach((timer) => clearTimeout(timer));
    rosterTimers = [];
  }

  function rosterAfter(callback, delay) {
    rosterTimers.push(setTimeout(callback, delay));
  }

  function renderRosterTeam(game, meta, program, side) {
    const container = $('#roster-cards');
    const teamIndex = side === 'away' ? 1 : 0;
    const team = game.teams?.[teamIndex] || FALLBACK.games.overwatch.teams[teamIndex];
    const rosterCollection = side === 'away' ? game.awayRosters : game.rosters;
    const roster = rosterCollection?.[program] || [];
    const visibleRoster = roster.filter((player) => player.handle || player.name || player.playerImage || player.character || player.characterImage);
    const players = (visibleRoster.length ? visibleRoster : roster).slice(0, 6);
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
      playerImage.src = safeImageUrl(player.playerImage, './assets/player-placeholder.svg');
      const characterImage = document.createElement('img');
      characterImage.className = 'character-photo';
      characterImage.alt = '';
      const sharedArtwork = game.characterArt?.[player.character]?.url;
      characterImage.src = safeImageUrl(sharedArtwork || player.characterImage, './assets/character-placeholder.svg');
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
    clearRosterTimers();
    const query = new URLSearchParams(location.search);
    const requestedProgram = query.get('program') || query.get('team');
    const program = requestedProgram === 'jv' ? 'jv' : (requestedProgram === 'varsity' ? 'varsity' : state.activeRoster || 'varsity');
    const stage = $('.roster-stage');
    stage.classList.remove('team-slide-out', 'team-slide-in');
    setText('#roster-cycle-label', game.showAwayRoster ? 'HOME → AWAY · 15 SEC' : 'PLAYER → CHARACTER · 7 SEC');
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

  function render(state) {
    renderScoreboard(state);
    renderMapPool(state);
    renderRoster(state);
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
