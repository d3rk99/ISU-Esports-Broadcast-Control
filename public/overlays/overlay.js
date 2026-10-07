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
  document.body.dataset.setup = (OVERLAY_QUERY.get('setup') || '').toLowerCase();
  document.body.classList.toggle('key-output', OUTPUT_VALID && IS_KEY_OUTPUT);
  document.body.classList.toggle('test-output', OUTPUT_VALID && IS_TEST_OUTPUT);

  const GAME_META = {
    overwatch: { name: 'OVERWATCH 2', code: 'OW2', accent: '#f06414', score: 'MAP SCORE' },
    valorant: { name: 'VALORANT', code: 'VAL', accent: '#ff4655', score: 'SERIES SCORE' },
    rocketleague: { name: 'ROCKET LEAGUE', code: 'RL', accent: '#2d8cff', score: 'SERIES SCORE' },
    smash: { name: 'SMASH BROS. ULTIMATE', code: 'SSBU', accent: '#e03b32', score: 'SET SCORE' },
    callofduty: { name: 'CALL OF DUTY', code: 'COD', accent: '#8dd936', score: 'MAP SCORE' }
  };
  const ROCKET_LEAGUE_BADGE_ICONS = {
    goals: '../assets/rocket league/points/Goal_points_icon.png',
    assists: '../assets/rocket league/points/Assist_points_icon.png',
    saves: '../assets/rocket league/points/Save_points_icon.png',
    shots: '../assets/rocket league/points/Shot_on_Goal_points_icon.png',
    demos: '../assets/rocket league/points/Demolition_points_icon.png'
  };
  const VALORANT_WEAPON_ICON_BY_SLUG = {
    classic: '../assets/valorant/weapons/classic.png',
    shorty: '../assets/valorant/weapons/shorty.png',
    frenzy: '../assets/valorant/weapons/frenzy.png',
    ghost: '../assets/valorant/weapons/ghost.png',
    sheriff: '../assets/valorant/weapons/sheriff.png',
    bandit: '../assets/valorant/weapons/bandit.png',
    stinger: '../assets/valorant/weapons/stinger.png',
    spectre: '../assets/valorant/weapons/spectre.png',
    bucky: '../assets/valorant/weapons/bucky.png',
    judge: '../assets/valorant/weapons/judge.png',
    bulldog: '../assets/valorant/weapons/bulldog.png',
    guardian: '../assets/valorant/weapons/guardian.png',
    phantom: '../assets/valorant/weapons/phantom.png',
    vandal: '../assets/valorant/weapons/vandal.png',
    warden: '../assets/valorant/weapons/warden.png',
    marshal: '../assets/valorant/weapons/marshal.png',
    marshall: '../assets/valorant/weapons/marshal.png',
    outlaw: '../assets/valorant/weapons/outlaw.png',
    operator: '../assets/valorant/weapons/operator.png',
    ares: '../assets/valorant/weapons/ares.png',
    odin: '../assets/valorant/weapons/odin.png',
    melee: '../assets/valorant/weapons/melee.png'
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
        rosterFirstSide: 'home',
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
  const rocketLeagueScorecardSequences = new WeakMap();
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

  function rocketLeagueSeriesLength(game) {
    const allowed = [3, 5, 7];
    const requested = Number(game.seriesLength) || 7;
    return allowed.includes(requested) ? requested : 7;
  }

  function rocketLeagueSeriesTarget(game) {
    return Math.ceil(rocketLeagueSeriesLength(game) / 2);
  }

  function renderSeriesDots(selector, wins, count) {
    const container = $(selector);
    if (!container) return;
    const safeWins = Math.max(0, Math.min(count, Number(wins) || 0));
    container.replaceChildren();
    for (let index = 0; index < count; index += 1) {
      const dot = document.createElement('i');
      dot.className = index < safeWins ? 'filled' : '';
      container.append(dot);
    }
  }

  function replayRocketLeagueScorecard(card) {
    const current = rocketLeagueScorecardSequences.get(card) || { id: 0, started: false };
    const sequence = { id: current.id + 1, started: true };
    const overlayRoot = card.closest('[data-overlay]');
    overlayRoot?.classList.remove('rl-boost-ready');
    rocketLeagueScorecardSequences.set(card, sequence);
    card.className = 'rl-scorecard is-hidden';
    card.getBoundingClientRect();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (rocketLeagueScorecardSequences.get(card)?.id !== sequence.id) return;
        card.className = 'rl-scorecard is-core';
        window.setTimeout(() => {
          if (rocketLeagueScorecardSequences.get(card)?.id !== sequence.id) return;
          card.className = 'rl-scorecard is-expanded';
          window.setTimeout(() => {
            if (rocketLeagueScorecardSequences.get(card)?.id !== sequence.id) return;
            card.className = 'rl-scorecard is-compact';
            window.setTimeout(() => {
              if (rocketLeagueScorecardSequences.get(card)?.id !== sequence.id) return;
              overlayRoot?.classList.add('rl-boost-ready');
            }, 650);
          }, 7900);
        }, 950);
      });
    });
  }

  function hideRocketLeagueScorecard(card) {
    const current = rocketLeagueScorecardSequences.get(card) || { id: 0 };
    card.closest('[data-overlay]')?.classList.remove('rl-boost-ready');
    rocketLeagueScorecardSequences.set(card, { id: current.id + 1, started: false });
    card.className = 'rl-scorecard is-hidden';
  }

  function renderRocketLeagueScorecard(selectedGame, game, teams, activeMap) {
    const card = $('#rl-scorecard');
    if (!card) return;
    if (selectedGame !== 'rocketleague') {
      hideRocketLeagueScorecard(card);
      return;
    }
    const live = game.rocketLeague?.live || {};
    const seriesLength = rocketLeagueSeriesLength(game);
    const dotCount = rocketLeagueSeriesTarget(game);
    const clockSeconds = live.timeSeconds === null || live.timeSeconds === undefined ? 300 : live.timeSeconds;
    const clock = live.overtime ? `OT ${formatDuration(clockSeconds)}` : formatDuration(clockSeconds);
    const footerParts = [game.match?.event, game.match?.round].filter(Boolean);
    const blueTeam = Number(game.rocketLeague?.blueTeam) || 0;

    card.dataset.homeRlColor = blueTeam === 0 ? 'blue' : 'orange';
    card.dataset.awayRlColor = blueTeam === 1 ? 'blue' : 'orange';
    setText('#rl-home-name', teams[0]?.name || 'HOME');
    setText('#rl-away-name', teams[1]?.name || 'AWAY');
    renderLogo('#rl-home-logo', teams[0]);
    renderLogo('#rl-away-logo', teams[1]);
    setText('#rl-home-goals', teams[0]?.detailScore ?? activeMap?.score?.[0] ?? 0);
    setText('#rl-away-goals', teams[1]?.detailScore ?? activeMap?.score?.[1] ?? 0);
    setText('#rl-clock', clock);
    setText('#rl-game-label', `GAME ${(game.activeMap || 0) + 1} / Best of ${seriesLength}`);
    setText('#rl-card-footer', footerParts.join(' - ') || 'COLLEGIATE ESPORTS');
    renderSeriesDots('#rl-home-series', teams[0]?.score, dotCount);
    renderSeriesDots('#rl-away-series', teams[1]?.score, dotCount);

    const sequence = rocketLeagueScorecardSequences.get(card);
    if (!sequence?.started) replayRocketLeagueScorecard(card);
  }

  function renderRocketLeaguePlayers(game, selectedGame) {
    const board = $('#rl-boost-board');
    if (!board) return;
    const live = game.rocketLeague?.live;
    const players = live?.players || [];
    board.hidden = selectedGame !== 'rocketleague' || !players.length;
    if (board.hidden) {
      const radial = $('#rl-spectated-boost');
      if (radial) radial.hidden = true;
      const replayIndicator = $('#rl-replay-indicator');
      if (replayIndicator) replayIndicator.hidden = true;
      return;
    }
    const blueTeam = Number(game.rocketLeague?.blueTeam) || 0;
    const destinationFor = (teamNum) => Number(teamNum) === 0 ? blueTeam : 1 - blueTeam;
    const now = Date.now();
    const recentEvents = Array.isArray(live?.recentEvents) ? live.recentEvents : [];
    [0, 1].forEach((teamIndex) => {
      const container = teamIndex === 0 ? $('#rl-home-players') : $('#rl-away-players');
      container.replaceChildren();
      players.filter((player) => destinationFor(player.teamNum) === teamIndex).slice(0, 3).forEach((player) => {
        const boost = player.boost === null || player.boost === undefined ? null : Math.max(0, Math.min(100, Number(player.boost)));
        const playerId = player.id || `${player.teamNum}|${player.shortcut}|${player.name}`;
        const card = document.createElement('div');
        card.className = `rl-boost-player${player.spectated ? ' spectated' : ''}${player.demolished ? ' demolished' : ''}`;
        card.dataset.rlColor = Number(player.teamNum) === 0 ? 'blue' : 'orange';
        const name = document.createElement('strong');
        name.textContent = player.name || 'PLAYER';
        const icons = document.createElement('div');
        icons.className = 'rl-boost-icons';
        const badge = recentEvents.find((event) => (
          (event.playerId && event.playerId === playerId) ||
          (!event.playerId && event.playerName && event.playerName === player.name)
        ));
        if (badge && Number(badge.removeAt) > now) {
          card.classList.add('has-badge');
          if (Number(badge.expiresAt) <= now) card.classList.add('badge-expiring');
          const icon = document.createElement('em');
          const age = Math.max(0, now - (Number(badge.createdAt) || now));
          const fadeIn = Math.min(1, age / 180);
          const fadeOut = Number(badge.expiresAt) <= now
            ? Math.max(0, (Number(badge.removeAt) - now) / Math.max(1, Number(badge.removeAt) - Number(badge.expiresAt)))
            : 1;
          const visibility = Math.min(fadeIn, fadeOut);
          const returnInset = 44 * (1 - fadeOut);
          card.style.setProperty('--rl-card-inset', `${returnInset.toFixed(2)}px`);
          card.style.setProperty('--rl-badge-slot', `${(48 * fadeOut).toFixed(2)}px`);
          icon.className = `rl-stat-icon rl-stat-${badge.key}`;
          icon.style.setProperty('--rl-badge-opacity', String(visibility));
          icon.style.setProperty('--rl-badge-scale', String(0.68 + (visibility * 0.32)));
          icon.title = `${badge.title}${badge.count > 1 ? ` x${badge.count}` : ''}`;
          const iconUrl = ROCKET_LEAGUE_BADGE_ICONS[badge.key];
          if (iconUrl) {
            icon.classList.add('has-image');
            icon.style.setProperty('--rl-badge-image', `url("${iconUrl}")`);
          } else {
            icon.textContent = badge.label;
          }
          if (badge.count > 1) icon.dataset.count = String(badge.count);
          icons.append(icon);
        }
        const meter = document.createElement('span');
        const fill = document.createElement('i');
        fill.style.width = `${boost ?? 0}%`;
        meter.append(fill);
        const amount = document.createElement('b');
        amount.textContent = boost === null ? '—' : String(Math.round(boost));
        card.append(name, icons, meter, amount);
        container.append(card);
      });
    });
    const radial = $('#rl-spectated-boost');
    const replayIndicator = $('#rl-replay-indicator');
    const replayActive = selectedGame === 'rocketleague' && Boolean(live?.replay);
    if (radial) {
      const spectated = players.find((player) => player.spectated);
      const boost = spectated?.boost === null || spectated?.boost === undefined ? 0 : Math.max(0, Math.min(100, Number(spectated.boost)));
      radial.hidden = selectedGame !== 'rocketleague' || !spectated || replayActive;
      radial.dataset.rlColor = spectated ? (Number(spectated.teamNum) === 0 ? 'blue' : 'orange') : '';
      radial.style.setProperty('--rl-spectated-boost', `${boost || 0}%`);
      setText('#rl-spectated-boost-value', Math.round(boost));
    }
    if (replayIndicator) replayIndicator.hidden = !replayActive;
  }

  function valorantOcrLive(game) {
    return game?.valorantOcr?.live || {};
  }

  // Player rows for the HUD cards. The rebuilt scoreboard reader (game.valorantBoard, agents /
  // guns / shields / K-D-A / creds / ult) wins when it has data; otherwise the old Observer 3
  // reader (valorantOcr.live.observer3). Both are mapped to the same shape.
  function valorantBoardPlayers(game, side) {
    const board = game?.valorantBoard?.live?.teams?.[side]?.players;
    if (Array.isArray(board) && board.some((p) => p && (p.name || p.agent || Number.isFinite(Number(p.kills))))) {
      return board.map((p) => {
        const ult = String(p?.ultimate || '');
        const m = ult.match(/(\d+)\s*\/\s*(\d+)/);
        return {
          name: p?.name || '',
          agent: p?.agent || '',
          shield: p?.shield || '',
          kda: { kills: p?.kills, deaths: p?.deaths, assists: p?.assists },
          credits: p?.credits,
          ultimateState: ult === 'READY' ? { status: 'ready', current: null, required: null, display: 'READY' }
            : m ? { status: 'charging', current: Number(m[1]), required: Number(m[2]), display: ult } : { status: 'unknown' },
          loadout: p?.weapon ? { status: 'matched', weapon: p.weapon } : { status: 'pending', weapon: '' }
        };
      });
    }
    return valorantOcrLive(game).observer3?.teams?.[side]?.players || [];
  }

  function renderRocketLeagueStatCard(game, selectedGame, program) {
    const card = $('#rl-player-stats');
    if (!card) return;
    const live = game.rocketLeague?.live;
    const player = live?.players?.find((entry) => entry.spectated);
    card.hidden = selectedGame !== 'rocketleague' || !player || Boolean(live?.replay) || !['connected', 'simulating'].includes(live?.status) || (live?.dataAgeMs ?? 0) >= 3000;
    if (card.hidden) return;
    const teamIndex = Number(player.teamNum) === 0 ? Number(game.rocketLeague?.blueTeam) || 0 : 1 - (Number(game.rocketLeague?.blueTeam) || 0);
    const team = game.teams?.[teamIndex] || {};
    const roster = (teamIndex === 0 ? game.rosters : game.awayRosters)?.[program === 'jv' ? 'jv' : 'varsity'] || [];
    const normalize = (value) => String(value || '').trim().toLowerCase();
    const matches = roster.filter((entry) => [entry.handle, entry.name].some((name) => normalize(name) && normalize(name) === normalize(player.name)));
    const carImage = game.rocketLeague?.carRenderer?.enabled ? safeImageUrl(player.carImage, '') : '';
    const portrait = carImage || (matches.length === 1 ? safeImageUrl(matches[0].playerImage, '') : '');
    const logo = safeImageUrl(team.logoImage, '');
    const artwork = $('#rl-player-art');
    const signature = JSON.stringify([portrait, logo, team.shortName]);
    if (artwork.dataset.signature !== signature) {
      artwork.dataset.signature = signature;
      artwork.replaceChildren();
      const showImage = (url, isPortrait) => {
        if (!url) { artwork.textContent = team.shortName || 'RL'; return; }
        const image = document.createElement('img');
        image.alt = '';
        image.className = isPortrait ? 'portrait' : 'logo';
        image.onerror = () => { image.remove(); if (isPortrait) showImage(logo, false); else artwork.textContent = team.shortName || 'RL'; };
        image.src = url;
        artwork.append(image);
      };
      showImage(portrait || logo, Boolean(portrait));
    }
    card.style.setProperty('--player-color', team.color || '#f47920');
    setText('#rl-player-name', player.name);
    setText('#rl-player-team', team.name || 'SPECTATING');
    for (const stat of ['shots', 'goals', 'assists', 'saves', 'demos']) {
      const value = Math.max(0, Number(player[stat]) || 0);
      const node = $(`#rl-player-${stat}`);
      if (node.textContent !== String(value)) node.textContent = String(value);
    }
  }

  function trustedValorantScore(live, side, fallback) {
    const value = live?.teams?.[side]?.score ?? live?.fields?.[`${side}Score`]?.value;
    return Number.isFinite(Number(value)) ? Number(value) : Number(fallback) || 0;
  }

  function valorantTimerDisplay(live) {
    const display = live?.match?.timerDisplay || live?.fields?.timer?.displayValue;
    if (display) return String(display).toUpperCase();
    const seconds = live?.match?.timerSeconds ?? live?.fields?.timer?.value;
    return Number.isFinite(Number(seconds)) ? formatDuration(seconds) : '--';
  }

  function valorantWeaponSlug(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  function valorantWeaponIcon(player) {
    const loadout = player?.loadout || {};
    if (loadout.status !== 'matched' || !loadout.weapon) return '';
    return VALORANT_WEAPON_ICON_BY_SLUG[valorantWeaponSlug(loadout.weapon)] || '';
  }

  function valorantCredits(value) {
    if (value === null || value === undefined || value === '') return '--';
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString('en-US') : '--';
  }

  function valorantKda(player) {
    const kda = player?.kda || {};
    const k = Number.isFinite(Number(kda.kills)) ? Number(kda.kills) : 0;
    const d = Number.isFinite(Number(kda.deaths)) ? Number(kda.deaths) : 0;
    const a = Number.isFinite(Number(kda.assists)) ? Number(kda.assists) : 0;
    return `${k} / ${d} / ${a}`;
  }

  function valorantUltimateLabel(player) {
    const ultimate = player?.ultimateState || {};
    if (ultimate.status === 'ready') return 'READY';
    if (ultimate.display) return ultimate.display;
    if (player?.ultimate) return player.ultimate;
    return '--';
  }

  function valorantRoundNumber(live, homeScore, awayScore) {
    const timelineRound = Number(live?.observer3?.roundTimeline?.currentRound);
    if (Number.isFinite(timelineRound) && timelineRound > 0) return timelineRound;
    return Math.max(1, homeScore + awayScore + 1);
  }

  // Home starts on the side shown in teal (defense) and swaps at halftime: rounds 13-24 are
  // the other side. Overtime (25+) swaps every round, starting back on the original side.
  function valorantSidesSwapped(roundNumber) {
    const round = Number(roundNumber) || 1;
    if (round <= 12) return false;
    if (round <= 24) return true;
    return (round - 25) % 2 === 1;
  }

  function valorantSideLabel(role) {
    return role === 'defense' ? 'GREEN' : role === 'attack' ? 'RED' : '--';
  }

  function renderValorantRoundHistory(live, { growing = false, fallbackRound = 1 } = {}) {
    const container = $('#val-round-history');
    if (!container) return;
    const timeline = live?.observer3?.roundTimeline || {};
    const rounds = Array.isArray(timeline.rounds) ? timeline.rounds : [];
    const currentRound = Number(timeline.currentRound) || 0;
    // Growing mode (experimental, controller toggle): only rounds 1..current are drawn and the
    // bar widens with each round until it is full width at round 24.
    const shown = growing ? Math.max(1, Math.min(24, currentRound || fallbackRound || 1)) : 24;
    container.classList.toggle('is-growing', growing);
    container.style.setProperty('--val-rounds-shown', String(shown));
    container.replaceChildren();
    for (let index = 0; index < shown; index += 1) {
      const round = rounds[index] || { round: index + 1 };
      const marker = document.createElement('span');
      const winnerRole = round.winnerRole || '';
      marker.className = `val-round-dot${round.current || currentRound === index + 1 ? ' current' : ''}${winnerRole ? ` ${winnerRole}` : ''}`;
      marker.dataset.round = String(index + 1);
      marker.title = `${index + 1} ${valorantSideLabel(winnerRole)}`.trim();
      if (index === 12) marker.classList.add('half-start');
      const icon = document.createElement('i');
      const number = document.createElement('b');
      number.textContent = String(index + 1);
      marker.append(icon, number);
      container.append(marker);
    }
  }

  function renderValorantSeriesDots(selector, score = 0, total = 3) {
    const container = $(selector);
    if (!container) return;
    const safeScore = Math.max(0, Math.min(total, Number(score) || 0));
    container.replaceChildren();
    for (let index = 0; index < total; index += 1) {
      const dot = document.createElement('i');
      dot.className = index < safeScore ? 'is-won' : '';
      container.append(dot);
    }
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    return node;
  }

  // Ult points per agent differ (6-9), so progress is current/required from the OCR read,
  // and the ring gets one tick per point. Ready = full ring + a star icon, no text.
  function valorantUltimateProgress(player) {
    const ult = player?.ultimateState || {};
    const current = Number(ult.current);
    const required = Number(ult.required);
    if (ult.status === 'ready') return { ready: true, current: Number.isFinite(required) ? required : null, required: Number.isFinite(required) ? required : null };
    if (Number.isFinite(current) && Number.isFinite(required) && required > 0) return { ready: current >= required, current, required };
    const match = String(ult.display || player?.ultimate || '').match(/(\d+)\s*\/\s*(\d+)/);
    if (match && Number(match[2]) > 0) return { ready: Number(match[1]) >= Number(match[2]), current: Number(match[1]), required: Number(match[2]) };
    return { ready: false, current: null, required: null };
  }

  function valorantUltimateRing(player) {
    const progress = valorantUltimateProgress(player);
    const wrap = document.createElement('div');
    const known = progress.ready || (progress.current !== null && progress.required);
    wrap.className = `val-ult${progress.ready ? ' is-ready' : ''}${known ? '' : ' is-unknown'}`;
    wrap.dataset.ultCurrent = progress.current ?? '';
    wrap.dataset.ultRequired = progress.required ?? '';
    const radius = 22;
    const circumference = 2 * Math.PI * radius;
    const svg = svgEl('svg', { viewBox: '0 0 52 52', 'aria-hidden': 'true' });
    svg.append(svgEl('circle', { class: 'track', cx: 26, cy: 26, r: radius }));
    const fraction = progress.ready ? 1 : known ? Math.max(0, Math.min(1, progress.current / progress.required)) : 0;
    svg.append(svgEl('circle', { class: 'fill', cx: 26, cy: 26, r: radius, 'stroke-dasharray': `${(fraction * circumference).toFixed(2)} ${circumference.toFixed(2)}` }));
    const segments = progress.required && progress.required <= 12 ? progress.required : 0;
    for (let index = 0; index < segments; index += 1) {
      const angle = (index / segments) * Math.PI * 2;
      const inner = radius - 3.4; const outer = radius + 3.4;
      svg.append(svgEl('line', { class: 'tick', x1: 26 + Math.cos(angle) * inner, y1: 26 + Math.sin(angle) * inner, x2: 26 + Math.cos(angle) * outer, y2: 26 + Math.sin(angle) * outer }));
    }
    wrap.append(svg);
    if (progress.ready) {
      const icon = svgEl('svg', { class: 'ready-icon', viewBox: '0 0 24 24', 'aria-label': 'Ultimate ready' });
      icon.append(svgEl('path', { d: 'M12 1.5l2.9 6.6 7.1.7-5.4 4.8 1.6 7-6.2-3.7-6.2 3.7 1.6-7L2 8.8l7.1-.7z' }));
      wrap.append(icon);
    } else {
      const label = document.createElement('b');
      label.textContent = known ? String(progress.current) : '-';
      wrap.append(label);
    }
    return wrap;
  }

  function renderValorantPlayerCards(selector, players = [], side = 'home') {
    const container = $(selector);
    if (!container) return;
    container.replaceChildren();
    const safePlayers = Array.from({ length: 5 }, (_item, index) => players[index] || { index });
    safePlayers.forEach((player, index) => {
      const card = document.createElement('article');
      card.className = `val-player-card val-player-card--${side}`;
      const name = document.createElement('strong');
      name.textContent = player?.name || `PLAYER ${index + 1}`;
      const stats = document.createElement('div');
      stats.className = 'val-player-stats';
      const kda = document.createElement('span');
      kda.className = 'val-player-kda';
      kda.textContent = valorantKda(player);
      const credits = document.createElement('span');
      credits.className = 'val-player-credits';
      credits.textContent = valorantCredits(player?.credits);
      stats.append(kda, credits);
      const weaponWrap = document.createElement('span');
      weaponWrap.className = 'val-weapon-slot';
      const weaponIcon = valorantWeaponIcon(player);
      if (weaponIcon) {
        const image = document.createElement('img');
        image.src = weaponIcon;
        image.alt = '';
        weaponWrap.classList.add('has-weapon');
        weaponWrap.append(image);
      }
      const shield = ['light', 'heavy', 'regen'].includes(player?.shield) ? player.shield : '';
      if (shield) {
        const icon = document.createElement('img');
        icon.className = `val-shield val-shield--${shield}`;
        icon.src = `../assets/valorant/shields/${shield}.png`;
        icon.alt = '';
        weaponWrap.append(icon);
      }
      if (player?.agent) {
        card.classList.add('has-agent');
        card.style.setProperty('--val-agent-art', `url("../assets/valorant/agents/${String(player.agent).replace(/[^a-z0-9-]/gi, '')}.webp")`);
      }
      card.append(valorantUltimateRing(player), name, stats, weaponWrap);
      container.append(card);
    });
  }

  function renderValorantHud(selectedGame, game, teams, activeMap) {
    const hud = $('#valorant-hud');
    if (!hud) return;
    hud.hidden = selectedGame !== 'valorant';
    if (hud.hidden) return;
    const live = valorantOcrLive(game);
    const observer = live.observer3 || {};
    const homeScore = Number.isFinite(Number(teams[0]?.detailScore))
      ? Number(teams[0].detailScore)
      : trustedValorantScore(live, 'home', teams[0]?.score);
    const awayScore = Number.isFinite(Number(teams[1]?.detailScore))
      ? Number(teams[1].detailScore)
      : trustedValorantScore(live, 'away', teams[1]?.score);
    const roundNumber = valorantRoundNumber(live, homeScore, awayScore);
    hud.classList.toggle('spike-planted', Boolean(live?.match?.spikePlanted));
    hud.classList.toggle('sides-swapped', valorantSidesSwapped(roundNumber));
    hud.dataset.homeName = teams[0]?.name || 'HOME';
    hud.dataset.awayName = teams[1]?.name || 'AWAY';
    setText('#val-home-name', teams[0]?.name || 'HOME');
    setText('#val-away-name', teams[1]?.name || 'AWAY');
    setText('#val-home-strip-name', teams[0]?.name || 'HOME');
    setText('#val-away-strip-name', teams[1]?.name || 'AWAY');
    setText('#val-home-short', teams[0]?.shortName || 'HOME');
    setText('#val-away-short', teams[1]?.shortName || 'AWAY');
    setText('#val-home-score', homeScore);
    setText('#val-away-score', awayScore);
    const valorantSeriesDots = Math.max(1, Math.ceil((Number(game.seriesLength) || 3) / 2));
    renderValorantSeriesDots('#val-home-series', teams[0]?.score, valorantSeriesDots);
    renderValorantSeriesDots('#val-away-series', teams[1]?.score, valorantSeriesDots);
    setText('#val-round-label', `ROUND ${roundNumber}`);
    // Round timer from the scoreboard reader's top-HUD read (blank while the spike is planted).
    setText('#val-timer', live?.match?.spikePlanted ? '' : (live?.match?.timerDisplay || ''));
    setText('#val-series-label', `${selectedGame === 'valorant' ? 'MAP' : 'GAME'} ${(game.activeMap || 0) + 1} / ${game.match?.format || 'BEST OF 3'}`);
    setText('#val-map-name', activeMap?.map || 'MAP TBD');
    setText('#val-map-detail', `MAP ${(game.activeMap || 0) + 1} OF ${Math.max(1, Math.min(3, Number(game.seriesLength) || 3))}`);
    setText('#val-event-name', game.match?.event || 'COLLEGIATE VALORANT');
    setText('#val-event-detail', game.match?.round || 'IDAHO STATE ESPORTS');
    renderLogo('#val-home-logo', teams[0]);
    renderLogo('#val-away-logo', teams[1]);
    renderValorantRoundHistory(live, { growing: Boolean(game.valorantGrowingRounds), fallbackRound: roundNumber });
    renderValorantPlayerCards('#val-home-players', valorantBoardPlayers(game, 'home'), 'home');
    renderValorantPlayerCards('#val-away-players', valorantBoardPlayers(game, 'away'), 'away');
  }

  // Smash crew battle: 1v1 games, each crew shares a 12-stock pool (detailScore = stocks left,
  // set from the controller's CURRENT STOCKS buttons). Set score = crew battles won (team score).
  const SMASH_CREW_STOCKS = 12;
  function renderSmashScorecard(selectedGame, game, teams) {
    const card = $('#smash-scorecard');
    if (!card) return;
    card.hidden = selectedGame !== 'smash';
    if (card.hidden) return;
    const seriesLength = Math.max(1, Number(game.seriesLength) || 3);
    const winsNeeded = Math.ceil(seriesLength / 2);
    teams.slice(0, 2).forEach((team, index) => {
      const side = index === 0 ? 'home' : 'away';
      const raw = Number(team?.detailScore);
      const stocks = Math.max(0, Number.isFinite(raw) ? raw : SMASH_CREW_STOCKS);
      setText(`#sm-${side}-name`, team?.name || (index === 0 ? 'HOME' : 'AWAY'));
      setText(`#sm-${side}-tag`, team?.shortName || '');
      setText(`#sm-${side}-stocks`, stocks);
      $(`.sm-stocks--${side}`)?.classList.toggle('is-out', stocks === 0);
      renderLogo(`#sm-${side}-logo`, team);
      const dots = $(`#sm-${side}-series`);
      if (dots) {
        dots.replaceChildren();
        for (let i = 0; i < winsNeeded; i += 1) {
          const dot = document.createElement('i');
          if (i < (Number(team?.score) || 0)) dot.className = 'is-won';
          dots.append(dot);
        }
      }
      const pips = $(`#sm-${side}-pips`);
      if (pips) {
        pips.replaceChildren();
        const total = Math.max(SMASH_CREW_STOCKS, stocks);
        for (let i = 0; i < total; i += 1) {
          const pip = document.createElement('i');
          // Home pips fill from the centre outward (right-aligned), away from the centre too.
          const lit = index === 0 ? i >= total - stocks : i < stocks;
          if (lit) pip.className = 'on';
          pips.append(pip);
        }
      }
    });
    setText('#sm-set-score', `${Number(teams[0]?.score) || 0} - ${Number(teams[1]?.score) || 0}`);
    setText('#sm-core-label', 'CREW BATTLE');
    setText('#sm-game-label', `GAME ${(game.activeMap || 0) + 1} / BEST OF ${seriesLength}`);
  }

  // ---- Overwatch ---------------------------------------------------------------------------
  // Big number = maps won (series). The strip under the map name = progress on THIS map, read
  // the way each mode is scored. Manual today (controller / Companion "current map score" =
  // team.detailScore); an OCR lab can later write game.overwatch.live and wins over manual.
  const OW_MODES = {
    control: { label: 'CONTROL', target: 2, unit: 'pips' },      // best of 3 rounds
    flashpoint: { label: 'FLASHPOINT', target: 3, unit: 'pips' },// first to 3 points
    clash: { label: 'CLASH', target: 5, unit: 'pips' },          // first to 5 captures
    escort: { label: 'ESCORT', unit: 'points' },                 // checkpoints, both teams attack
    hybrid: { label: 'HYBRID', unit: 'points' },
    push: { label: 'PUSH', unit: 'meters' }                      // distance pushed
  };
  const OW_MAP_MODES = {
    control: ['Antarctic Peninsula', 'Busan', 'Ilios', 'Lijiang Tower', 'Nepal', 'Oasis', 'Samoa'],
    flashpoint: ['New Junk City', 'Suravasa', 'Aatlis'],
    clash: ['Hanaoka', 'Throne of Anubis'],
    escort: ['Circuit Royal', 'Dorado', 'Havana', 'Junkertown', 'Rialto', 'Route 66', 'Shambali Monastery', 'Watchpoint: Gibraltar'],
    hybrid: ['Blizzard World', 'Eichenwalde', 'Hollywood', "King's Row", 'Midtown', 'Numbani', 'Paraíso'],
    push: ['Colosseo', 'Esperança', 'New Queen Street', 'Runasapi']
  };
  function overwatchMode(row) {
    const raw = String(row?.mode || '').toLowerCase().trim();
    if (OW_MODES[raw]) return raw;
    for (const [mode, maps] of Object.entries(OW_MAP_MODES)) if (maps.some((m) => m.toLowerCase() === String(row?.map || '').toLowerCase())) return mode;
    return ''; // no map/mode picked yet: show no mode instead of guessing CONTROL
  }

  // ---- Overwatch player stat cards (from the scoreboard OCR lab) -----------------------------
  // Bottom-left (home) and bottom-right (away), like VALORANT's. Data: game.overwatchOcr.live
  // (OCR) + roster (hero art behind the card). Shown only when the controller's
  // "Player stat cards" toggle is on AND the OCR has data, so it never shows an empty grid.
  function owCompact(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '–';
    return n >= 10000 ? `${(n / 1000).toFixed(1)}K` : n.toLocaleString('en-US');
  }

  function owUltRing(ultimate) {
    const ready = ultimate === 'READY';
    const pct = ready ? 100 : Number.isFinite(Number(ultimate)) ? Math.max(0, Math.min(100, Number(ultimate))) : null;
    const wrap = document.createElement('div');
    wrap.className = `ow-ult${ready ? ' is-ready' : ''}${pct === null ? ' is-unknown' : ''}`;
    const radius = 20; const circumference = 2 * Math.PI * radius;
    const svg = svgEl('svg', { viewBox: '0 0 48 48', 'aria-hidden': 'true' });
    svg.append(svgEl('circle', { class: 'track', cx: 24, cy: 24, r: radius }));
    svg.append(svgEl('circle', { class: 'fill', cx: 24, cy: 24, r: radius, 'stroke-dasharray': `${(((pct || 0) / 100) * circumference).toFixed(2)} ${circumference.toFixed(2)}` }));
    wrap.append(svg);
    if (ready) {
      const icon = svgEl('svg', { class: 'ready-icon', viewBox: '0 0 24 24', 'aria-label': 'Ultimate ready' });
      icon.append(svgEl('path', { d: 'M4.5 12.5l4.6 4.6L19.5 6.7', fill: 'none' }));
      wrap.append(icon);
    } else {
      const label = document.createElement('b');
      label.textContent = pct === null ? '-' : `${pct}`;
      wrap.append(label);
    }
    return wrap;
  }

  // Cards are built once per container and updated in place, so the slide in / out animation
  // only runs when the toggle (or data presence) actually changes, never on a stats update.
  // in:  slot 1 of both teams first, then slot 2, ... (100 ms apart), each from its own edge.
  // out: the reverse order, then the containers hide.

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
  const OW_CARD_STEP_MS = 110;
  const OW_CARD_MS = 480;
  function buildOwCard(side, index) {
    const card = document.createElement('article');
    card.className = `ow-player-card ow-player-card--${side}`;
    card.style.setProperty('--ow-in-delay', `${index * OW_CARD_STEP_MS}ms`);
    card.style.setProperty('--ow-out-delay', `${(4 - index) * OW_CARD_STEP_MS}ms`);
    const ult = document.createElement('div');
    const name = document.createElement('strong');
    const ead = document.createElement('span'); ead.className = 'ow-ead';
    const numbers = document.createElement('div'); numbers.className = 'ow-numbers';
    card.append(ult, name, ead, numbers);
    return card;
  }

  function fillOwCard(card, p, rosterEntry, game, index) {
    const heroName = p.hero || rosterEntry?.character || '';
    const heroArt = safeImageUrl(heroName ? game.characterArt?.[heroName]?.url : '', '');
    card.classList.toggle('has-hero', Boolean(heroArt));
    if (heroArt) card.style.setProperty('--ow-hero-art', `url("${heroArt}")`); else card.style.removeProperty('--ow-hero-art');
    const ring = owUltRing(p.ultimate);
    card.children[0].replaceWith(ring);
    card.children[1].textContent = rosterEntry?.handle || p.name || `PLAYER ${index + 1}`;
    const pair = (label, value) => { const el = document.createElement('span'); const i = document.createElement('i'); i.textContent = label; const b = document.createElement('b'); b.textContent = value; el.append(i, b); return el; };
    const ead = card.children[2]; ead.replaceChildren();
    ['elims', 'assists', 'deaths'].forEach((k, i) => { const el = pair(['E', 'A', 'D'][i], Number.isFinite(Number(p[k])) ? String(Number(p[k])) : '–'); ead.append(...el.childNodes); });
    card.children[3].replaceChildren(...[['DMG', p.damage], ['HEAL', p.healing], ['MIT', p.mitigation]].map(([label, v]) => pair(label, owCompact(v))));
  }

  const owCardsState = new WeakMap(); // container -> { shown, hideTimer }
  function renderOverwatchPlayerCards(selectedGame, game) {
    const live = game.overwatchOcr?.live;
    const hasData = ['home', 'away'].some((side) => (live?.teams?.[side]?.players || []).some((p) => p && (p.name || Number.isFinite(Number(p.damage)))));
    const show = selectedGame === 'overwatch' && Boolean(game.overwatchShowStatCards) && hasData;
    for (const side of ['home', 'away']) {
      const container = $(`#ow-${side}-players`);
      if (!container) continue;
      const st = owCardsState.get(container) || { shown: false, hideTimer: null };
      owCardsState.set(container, st);
      if (container.children.length !== 5) container.replaceChildren(...Array.from({ length: 5 }, (_v, i) => buildOwCard(side, i)));
      if (show) {
        const roster = side === 'home' ? (game.rosters?.[game.activeRosterKey || 'varsity'] || game.rosters?.varsity || []) : (game.awayRosters?.[game.activeRosterKey || 'varsity'] || game.awayRosters?.varsity || []);
        const players = live.teams?.[side]?.players || [];
        [...container.children].forEach((card, index) => {
          const p = players[index] || {};
          const rosterEntry = p.name ? owBestByTag(roster, p.name, 'handle') : null;
          fillOwCard(card, p, rosterEntry, game, index);
        });
      }
      if (show && !st.shown) {
        clearTimeout(st.hideTimer); st.hideTimer = null;
        container.hidden = false;
        container.classList.remove('is-out');
        void container.offsetWidth; // restart the "in" animation
        container.classList.add('is-in');
        st.shown = true;
      } else if (!show && st.shown) {
        container.classList.remove('is-in');
        container.classList.add('is-out');
        st.shown = false;
        st.hideTimer = setTimeout(() => { if (!st.shown) { container.hidden = true; container.classList.remove('is-out'); } }, OW_CARD_MS + 4 * OW_CARD_STEP_MS + 60);
      } else if (!show && !st.hideTimer) container.hidden = true;
    }
  }

  function renderOverwatchScorecard(selectedGame, game, teams, activeMap) {
    const card = $('#ow-scorecard');
    if (!card) return;
    card.hidden = selectedGame !== 'overwatch';
    if (card.hidden) return;
    const live = game.overwatch?.live || {};
    const mode = OW_MODES[String(live.mode || '').toLowerCase()] ? String(live.mode).toLowerCase() : overwatchMode(activeMap);
    const spec = OW_MODES[mode] || { label: '', target: 0, unit: 'pips' };
    card.dataset.mode = mode;
    const seriesLength = Math.max(1, Number(game.seriesLength) || 5);
    const mapsToWin = Math.ceil(seriesLength / 2);
    const attacking = live.attacking || game.overwatch?.attacking || '';
    teams.slice(0, 2).forEach((team, index) => {
      const side = index === 0 ? 'home' : 'away';
      setText(`#ow-${side}-name`, team?.name || (index === 0 ? 'HOME' : 'AWAY'));
      setText(`#ow-${side}-score`, Number(team?.score) || 0);
      renderLogo(`#ow-${side}-logo`, team);
      const sideTag = ['control', 'flashpoint', 'clash'].includes(mode) || !attacking ? '' : attacking === side ? 'ATTACK' : 'DEFEND';
      setText(`#ow-${side}-side`, sideTag);
      $(`.ow-name--${side}`)?.classList.toggle('is-attacking', sideTag === 'ATTACK');
      const dots = $(`#ow-${side}-series`);
      if (dots) {
        dots.replaceChildren();
        for (let i = 0; i < mapsToWin; i += 1) {
          const dot = document.createElement('i');
          if (i < (Number(team?.score) || 0)) dot.className = 'is-won';
          dots.append(dot);
        }
      }
      const liveValue = Number(live[`${side}Progress`]);
      const value = Math.max(0, Number.isFinite(liveValue) ? liveValue : Number(team?.detailScore) || 0);
      const progress = $(`#ow-${side}-progress`);
      if (progress) {
        progress.replaceChildren();
        if (spec.unit === 'pips') {
          for (let i = 0; i < spec.target; i += 1) {
            const pip = document.createElement('i');
            // Home fills from the centre outward like the away side.
            const lit = index === 0 ? i >= spec.target - value : i < value;
            if (lit) pip.className = 'on';
            progress.append(pip);
          }
        } else {
          const b = document.createElement('b');
          b.textContent = spec.unit === 'meters' ? `${value}m` : String(value);
          progress.append(b);
        }
      }
    });
    // Hero bans for this map (set in match controls): hero icon on the inside of each strip.
    const bans = activeMap?.heroBans || {};
    for (const side of ['home', 'away']) {
      const el = $(`#ow-${side}-ban`); if (!el) continue;
      const hero = String(bans[side] || '');
      el.hidden = !hero;
      if (!hero) continue;
      const slug = hero.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const img = el.querySelector('img');
      const url = `/assets/overwatch/hero-icons/${slug}.png`;
      if (img.getAttribute('src') !== url) img.src = url;
      img.alt = `${hero} banned`;
      el.title = `${hero} banned`;
    }
    setText('#ow-map-label', `MAP ${(game.activeMap || 0) + 1} · FIRST TO ${mapsToWin}`);
    setText('#ow-map-name', (live.map || activeMap?.map || 'MAP TBD').toUpperCase());
    setText('#ow-mode-label', spec.label);
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
    renderRocketLeagueScorecard(selectedGame, game, teams, activeMap);
    renderRocketLeaguePlayers(game, selectedGame);
    renderRocketLeagueStatCard(game, selectedGame, state.activeRoster);
    renderValorantHud(selectedGame, game, teams, activeMap);
    renderSmashScorecard(selectedGame, game, teams);
    renderOverwatchScorecard(selectedGame, game, teams, activeMap);
    renderOverwatchPlayerCards(selectedGame, game);
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
      const isActive = index === game.activeMap;
      const isRocketLeagueActive = selectedGame === 'rocketleague' && isActive && row.winner === null;
      const card = document.createElement('article');
      card.className = `generic-map-card${isActive ? ' active' : ''}${row.winner !== null ? ' complete' : ''}${isRocketLeagueActive ? ' in-progress' : ''}`;
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
      const scoreLine = document.createElement('span');
      scoreLine.className = 'map-score-line';
      let winnerBadge = null;
      const shownScore = isRocketLeagueActive
        ? [teams[0]?.detailScore ?? 0, teams[1]?.detailScore ?? 0]
        : row.score;
      if (shownScore?.some((value) => value !== '' && value !== null && value !== undefined)) {
        scoreLine.textContent = `${shownScore[0] || '0'} - ${shownScore[1] || '0'}`;
      } else if (row.winner !== null) {
        scoreLine.textContent = '';
      } else {
        scoreLine.textContent = isActive ? 'IN PROGRESS' : 'UPCOMING';
      }
      score.append(scoreLine);
      if (row.winner !== null) {
        const winner = teams[row.winner] || {};
        winnerBadge = document.createElement('span');
        winnerBadge.className = 'map-winner-badge';
        const logoUrl = safeImageUrl(winner.logoImage, '');
        if (logoUrl) {
          const logo = document.createElement('img');
          logo.src = logoUrl;
          logo.alt = `${winner.shortName || 'Winner'} logo`;
          winnerBadge.append(logo);
        } else {
          winnerBadge.textContent = winner.shortName || 'WIN';
        }
      }
      if (isRocketLeagueActive) {
        const status = document.createElement('span');
        status.className = 'map-progress-label';
        status.textContent = 'IN PROGRESS';
        score.append(status);
      }
      if (row.overtime) {
        const overtime = document.createElement('span');
        overtime.className = 'map-overtime';
        const label = document.createElement('b');
        label.textContent = 'OT';
        overtime.append(label, document.createTextNode(` ${formatDuration(row.overtimeSeconds)}`));
        score.append(overtime);
      }
      card.append(image);
      if (winnerBadge) card.append(winnerBadge);
      card.append(number, map, mode, score);
      container.append(card);
    });
  }

  function renderMapGameIcon(selectedGame, meta) {
    const target = $('#map-game-code');
    if (!target) return;
    if (target.dataset.iconGame === selectedGame) return;
    target.dataset.iconGame = selectedGame;
    target.classList.toggle('has-image', selectedGame === 'rocketleague');
    target.replaceChildren();
    if (selectedGame === 'rocketleague') {
      const image = document.createElement('img');
      image.src = '../assets/rocket league/rocket-league-shield.svg';
      image.alt = 'Rocket League';
      target.append(image);
      return;
    }
    target.textContent = meta.code;
  }

  function renderMapPool(state) {
    if (!$('[data-overlay="map-pool"]')) return;
    const { selectedGame, game, meta } = getActive(state);
    applyTheme(selectedGame, meta);
    const teams = game.teams || FALLBACK.games.overwatch.teams;
    renderMapGameIcon(selectedGame, meta);
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
      rosterFirstSide: game.rosterFirstSide,
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
    const firstSide = game.rosterFirstSide === 'away' ? 'away' : 'home';
    const secondSide = firstSide === 'home' ? 'away' : 'home';
    const firstTeamIndex = firstSide === 'away' ? 1 : 0;
    const secondTeamIndex = firstTeamIndex === 0 ? 1 : 0;
    const firstTeamLabel = game.teams?.[firstTeamIndex]?.shortName || firstSide.toUpperCase();
    const secondTeamLabel = game.teams?.[secondTeamIndex]?.shortName || secondSide.toUpperCase();
    stage.classList.remove('team-slide-out', 'team-slide-in');
    setText('#roster-cycle-label', game.showAwayRoster ? `${firstTeamLabel} -> ${secondTeamLabel} - 15 SEC` : selectedGame === 'rocketleague' ? 'PLAYER -> CAR - 7 SEC' : 'PLAYER -> CHARACTER - 7 SEC');
    renderRosterTeam(game, meta, program, firstSide);
    rosterAfter(() => showRosterCharacters(firstSide), 7000);

    if (game.showAwayRoster) {
      rosterAfter(() => {
        stage.classList.remove('character-mode');
        stage.classList.add('team-slide-out');
        setText('#roster-phase-label', 'CHANGING SIDES');
      }, 14500);
      rosterAfter(() => {
        renderRosterTeam(game, meta, program, secondSide);
        stage.classList.remove('team-slide-out');
        stage.classList.add('team-slide-in');
      }, 15350);
      rosterAfter(() => stage.classList.remove('team-slide-in'), 16300);
      rosterAfter(() => showRosterCharacters(secondSide), 22350);
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

  // Preview hook for scripts/ow-hud-preview.cjs (headless frame strips); only with ?preview=1.
  if (OVERLAY_QUERY.get('preview') === '1') window.__owRender = (state) => render(state);

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
    if (window.isuLiveState) window.isuLiveState(render);
    else { const events = new EventSource('/events'); events.onmessage = (event) => { try { render(JSON.parse(event.data)); } catch {} }; }
  }

  document.addEventListener('DOMContentLoaded', start);
})();
