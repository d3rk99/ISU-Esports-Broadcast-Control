const { EventEmitter } = require('node:events');

const VALORANT_GAME_ID = 21640;
const VALORANT_FEATURES = Object.freeze(['gep_internal', 'me', 'game_info', 'match_info', 'kill', 'death']);

const DEFAULTS = Object.freeze({
  enabled: false,
  team0Home: true,
  syncScore: true,
  syncMap: true,
  syncRound: true,
  syncPhase: true,
  syncPlayers: true,
  debug: false,
  staleMs: 5000
});

const AGENT_NAMES = Object.freeze({
  Clay: 'Raze',
  Pandemic: 'Viper',
  Wraith: 'Omen',
  Hunter: 'Sova',
  Thorne: 'Sage',
  Phoenix: 'Phoenix',
  Wushu: 'Jett',
  Gumshoe: 'Cypher',
  Sarge: 'Brimstone',
  Breach: 'Breach',
  Vampire: 'Reyna',
  Killjoy: 'Killjoy',
  Guide: 'Skye',
  Stealth: 'Yoru',
  Rift: 'Astra',
  Grenadier: 'KAY/O',
  Deadeye: 'Chamber',
  Sprinter: 'Neon',
  BountyHunter: 'Fade',
  Mage: 'Harbor',
  AggroBot: 'Gekko',
  Cable: 'Deadlock',
  Sequoia: 'Iso',
  Smonk: 'Clove',
  Nox: 'Vyse',
  Cashew: 'Tejo',
  Terra: 'Waylay'
});

const MAP_NAMES = Object.freeze({
  Infinity: 'Abyss',
  Triad: 'Haven',
  Duality: 'Bind',
  Bonsai: 'Split',
  Ascent: 'Ascent',
  Port: 'Icebox',
  Foxtrot: 'Breeze',
  Canyon: 'Fracture',
  Pitt: 'Pearl',
  Jam: 'Lotus',
  Juliett: 'Sunset',
  Rook: 'Corrode',
  Range: 'Practice Range',
  HURM_Alley: 'District',
  HURM_Yard: 'Piazza',
  HURM_Bowl: 'Kasbah',
  HURM_Helix: 'Drift',
  HURM_HighTide: 'Glitch'
});

function createLiveState() {
  return {
    connected: false,
    gepAvailable: false,
    gameDetected: false,
    status: 'disabled',
    message: 'Live data is off',
    lastUpdateAt: null,
    dataAgeMs: null,
    eventCount: 0,
    registeredFeatures: [],
    detectedGameId: null,
    match: { active: false, map: null, mode: null, matchId: null, pseudoMatchId: null, round: null, phase: null, outcome: null },
    teams: { home: { score: 0, side: null }, away: { score: 0, side: null } },
    players: [],
    spike: { carrier: null, state: null, site: null },
    observedPlayer: null,
    lastEvent: null,
    lastInfoUpdate: null,
    lastNormalizedEvent: null,
    errors: []
  };
}

function normalizeSettings(settings = {}) {
  return {
    ...DEFAULTS,
    ...settings,
    enabled: Boolean(settings.enabled),
    team0Home: settings.team0Home !== false,
    syncScore: settings.syncScore !== false,
    syncMap: settings.syncMap !== false,
    syncRound: settings.syncRound !== false,
    syncPhase: settings.syncPhase !== false,
    syncPlayers: settings.syncPlayers !== false,
    debug: Boolean(settings.debug),
    staleMs: Number.isFinite(Number(settings.staleMs)) ? Math.max(1000, Number(settings.staleMs)) : DEFAULTS.staleMs
  };
}

function parseMaybeJson(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return '';
  try { return JSON.parse(trimmed); } catch {}
  return value;
}

function agentName(value) {
  const raw = String(value || '').replace(/_PC_C$/i, '');
  return AGENT_NAMES[raw] || raw || null;
}

function mapName(value) {
  return MAP_NAMES[value] || value || null;
}

function toNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function payloadEntries(payload = {}) {
  const entries = [];
  if (payload.info && typeof payload.info === 'object') {
    for (const [category, values] of Object.entries(payload.info)) {
      if (!values || typeof values !== 'object') continue;
      for (const [key, value] of Object.entries(values)) entries.push({ feature: payload.feature, category, key, value: parseMaybeJson(value) });
    }
  }
  if (payload.category && payload.key) {
    entries.push({
      feature: payload.feature,
      category: payload.category,
      key: payload.key,
      value: parseMaybeJson(payload.value ?? payload.data)
    });
  }
  return entries;
}

function upsertPlayer(players, next) {
  const id = next.id || next.name || `player-${players.length}`;
  const existing = players.find((player) => player.id === id || player.name === next.name);
  if (existing) Object.assign(existing, next, { id: existing.id || id });
  else players.push({ id, ...next });
  players.sort((a, b) => Number(a.team ?? 99) - Number(b.team ?? 99) || String(a.name || '').localeCompare(String(b.name || '')));
}

function mappedTeamKey(teamNumber, settings = DEFAULTS) {
  const isTeam0 = Number(teamNumber) === 0;
  return isTeam0 === Boolean(settings.team0Home) ? 'home' : 'away';
}

function applyScore(live, value, settings) {
  const score = parseMaybeJson(value);
  if (!score || typeof score !== 'object') return;
  if (Object.hasOwn(score, 'team_0') || Object.hasOwn(score, 'team_1')) {
    for (const [key, val] of Object.entries(score)) {
      const match = key.match(/team_(\d+)/);
      if (!match) continue;
      live.teams[mappedTeamKey(Number(match[1]), settings)].score = toNumber(val, 0);
    }
    return;
  }
  if (Object.hasOwn(score, 'won') || Object.hasOwn(score, 'lost')) {
    live.teams.home.score = toNumber(score.won, live.teams.home.score);
    live.teams.away.score = toNumber(score.lost, live.teams.away.score);
  }
}

function normalizeInfoUpdate(payload, live = createLiveState(), settings = DEFAULTS) {
  const next = structuredClone(live);
  next.lastInfoUpdate = payload;
  next.lastUpdateAt = new Date().toISOString();
  next.lastNormalizedEvent = null;

  for (const entry of payloadEntries(payload)) {
    const { category, key, value } = entry;
    if (category === 'gep_internal' && key === 'version_info') next.gepVersion = value;
    if (category === 'game_info') {
      if (key === 'scene' && value !== 'MainMenu' && settings.syncMap) next.match.map = mapName(value);
      if (key === 'state') next.match.active = value === 'InProgress' || next.match.active;
    }
    if (category === 'me') {
      const local = { id: next.me?.id || 'local', name: next.me?.name || 'Me', local: true };
      if (key === 'player_name') local.name = value;
      if (key === 'player_id') local.id = value;
      if (key === 'agent') local.agent = agentName(value);
      if (key === 'health') local.health = toNumber(value);
      next.me = { ...(next.me || {}), ...local };
      upsertPlayer(next.players, next.me);
    }
    if (category !== 'match_info') continue;
    if ((key === 'pseudo_match_id' || key === 'match_id') && value) {
      next.match[key === 'match_id' ? 'matchId' : 'pseudoMatchId'] = String(value);
      next.match.active = true;
    }
    if (key === 'round_number' && settings.syncRound) next.match.round = toNumber(value, next.match.round);
    if ((key === 'score' || key === 'match_score') && settings.syncScore) applyScore(next, value, settings);
    if (key === 'round_phase' && settings.syncPhase) {
      next.match.phase = String(value || '');
      if (value === 'game_end') next.match.active = false;
      else if (value) next.match.active = true;
    }
    if (key === 'team') {
      const side = String(value || '').toLowerCase();
      next.teams.home.side = settings.team0Home ? side : side === 'attack' ? 'defense' : side === 'defense' ? 'attack' : side;
      next.teams.away.side = next.teams.home.side === 'attack' ? 'defense' : next.teams.home.side === 'defense' ? 'attack' : null;
    }
    if (key === 'match_outcome') next.match.outcome = String(value || '');
    if (key === 'game_mode') {
      const mode = parseMaybeJson(value);
      next.match.mode = typeof mode === 'object' ? mode.mode || null : String(mode || '');
      next.match.custom = typeof mode === 'object' ? Boolean(mode.custom) : null;
      next.match.ranked = typeof mode === 'object' ? mode.ranked ?? null : null;
    }
    if (key === 'map' && settings.syncMap) next.match.map = mapName(value);
    if (key === 'observing') next.observedPlayer = value || null;
    if (key.startsWith('roster_') && settings.syncPlayers) {
      const player = parseMaybeJson(value);
      if (player && typeof player === 'object') upsertPlayer(next.players, {
        id: player.player_id,
        name: player.name,
        agent: agentName(player.character),
        rank: player.rank,
        locked: Boolean(player.locked),
        local: Boolean(player.local),
        teammate: Boolean(player.teammate)
      });
    }
    if (key.startsWith('scoreboard_') && settings.syncPlayers) {
      const player = parseMaybeJson(value);
      if (player && typeof player === 'object') {
        upsertPlayer(next.players, {
          id: player.player_id,
          name: player.name,
          agent: agentName(player.character),
          team: toNumber(player.team),
          kills: toNumber(player.kills, 0),
          deaths: toNumber(player.deaths, 0),
          assists: toNumber(player.assists, 0),
          alive: Boolean(player.alive),
          weapon: player.weapon || null,
          armor: toNumber(player.shield),
          money: toNumber(player.money),
          ultimatePoints: toNumber(player.ult_points),
          ultimateRequired: toNumber(player.ult_max),
          spike: Boolean(player.spike),
          local: Boolean(player.is_local ?? player.local),
          teammate: Boolean(player.teammate)
        });
        if (player.spike) next.spike.carrier = player.name || player.player_id || null;
      }
    }
    if (key === 'kill_feed') next.lastEvent = { name: 'kill_feed', data: parseMaybeJson(value), at: next.lastUpdateAt };
  }
  return next;
}

function normalizeGameEvent(payload, live = createLiveState()) {
  const next = structuredClone(live);
  next.lastEvent = payload;
  next.lastUpdateAt = new Date().toISOString();
  next.eventCount = (next.eventCount || 0) + 1;
  const events = Array.isArray(payload?.events) ? payload.events : Array.isArray(payload) ? payload : [payload].filter(Boolean);
  for (const event of events) {
    const name = event?.name || event?.event || '';
    const data = parseMaybeJson(event?.data ?? event?.value ?? '');
    next.lastNormalizedEvent = { name, data, at: next.lastUpdateAt };
    if (name === 'match_start') {
      next.match.active = true;
      next.match.phase = next.match.phase || 'starting';
      next.spike.state = null;
    }
    if (name === 'match_end') {
      next.match.active = false;
      next.match.phase = 'game_end';
    }
    if (name === 'spike_defused') next.spike.state = 'defused';
    if (name === 'spike_detonated') next.spike.state = 'detonated';
    if (name === 'planted_location') {
      next.spike.state = 'planted';
      next.spike.site = data || null;
    }
    if (name === 'kill_feed') next.lastEvent = { name, data, at: next.lastUpdateAt };
  }
  return next;
}

class ValorantService extends EventEmitter {
  constructor({ app, onEvent = () => {}, onStatus = () => {} } = {}) {
    super();
    this.app = app;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.settings = { ...DEFAULTS };
    this.live = createLiveState();
    this.listeners = [];
    this.watchdogTimer = null;
    this.simulatorTimer = null;
  }

  get gep() {
    return this.app?.overwolf?.packages?.gep || null;
  }

  configure(settings = {}) {
    this.settings = normalizeSettings(settings);
    this.stop();
    this.live = { ...createLiveState(), registeredFeatures: [...VALORANT_FEATURES] };
    if (!this.settings.enabled) return this.emitStatus('disabled', 'Live data is off');
    if (!this.gep) return this.emitStatus('unavailable', 'Overwolf GEP is unavailable in standard Electron', { gepAvailable: false });
    this.live.gepAvailable = true;
    this.startWatchdog();
    this.registerGep();
    return this.live;
  }

  stop() {
    clearInterval(this.watchdogTimer);
    clearInterval(this.simulatorTimer);
    this.watchdogTimer = null;
    this.simulatorTimer = null;
    for (const off of this.listeners.splice(0)) {
      try { off(); } catch {}
    }
  }

  emitStatus(status, message, extra = {}) {
    this.live = { ...this.live, status, message, ...extra };
    this.onStatus({ ...this.live });
    return this.live;
  }

  log(message, details) {
    if (!this.settings.debug && details) return;
    console.log(`[VAL-GEP] ${message}`, details || '');
  }

  addGepListener(event, listener) {
    const gep = this.gep;
    if (!gep?.on) return;
    gep.on(event, listener);
    this.listeners.push(() => {
      if (gep.off) gep.off(event, listener);
      else if (gep.removeListener) gep.removeListener(event, listener);
    });
  }

  async registerGep() {
    this.emitStatus('registering', 'Registering VALORANT GEP features', { gepAvailable: true });
    this.addGepListener('game-detected', (event, gameId, ...args) => this.handleGameDetected(event, gameId, ...args));
    this.addGepListener('game-exit', (_event, gameId) => this.handleGameExit(gameId));
    this.addGepListener('new-info-update', (_event, gameId, ...args) => this.handleInfoUpdate(gameId, ...args));
    this.addGepListener('new-game-event', (_event, gameId, ...args) => this.handleGameEvent(gameId, ...args));
    this.addGepListener('elevated-privileges-required', () => this.emitStatus('error', 'Run Broadcast Control as administrator to capture VALORANT'));
    this.addGepListener('error', (_event, error) => this.reportError(error));
    try {
      await this.gep.setRequiredFeatures?.(VALORANT_FEATURES);
      this.log(`Requested features: ${VALORANT_FEATURES.join(', ')}`);
      this.emitStatus('waiting', 'Waiting for VALORANT', { registeredFeatures: [...VALORANT_FEATURES] });
    } catch (error) {
      this.reportError(error);
    }
  }

  handleGameDetected(event, gameId) {
    this.live.detectedGameId = gameId;
    if (Number(gameId) !== VALORANT_GAME_ID) return;
    try { event?.enable?.(); } catch (error) { this.reportError(error); }
    this.log('VALORANT detected');
    this.emitStatus('detected', 'VALORANT detected', { gameDetected: true, connected: true, detectedGameId: gameId });
    try { this.gep?.getInfo?.(gameId); } catch {}
  }

  handleGameExit(gameId) {
    if (Number(gameId) !== VALORANT_GAME_ID) return;
    this.emitStatus('waiting', 'VALORANT closed; waiting for VALORANT', { gameDetected: false, connected: false });
  }

  handleInfoUpdate(gameId, payload = {}) {
    if (Number(gameId) !== VALORANT_GAME_ID) return;
    this.live = normalizeInfoUpdate(payload, this.live, this.settings);
    this.live.connected = true;
    this.live.gameDetected = true;
    const simulating = Boolean(this.simulatorTimer) || this.live.status === 'simulating';
    this.emitStatus(simulating ? 'simulating' : 'receiving', simulating ? 'VALORANT test feed running' : 'Receiving VALORANT match data', { dataAgeMs: 0 });
    this.onEvent({ type: 'info', live: { ...this.live } });
  }

  handleGameEvent(gameId, payload = {}) {
    if (Number(gameId) !== VALORANT_GAME_ID) return;
    this.live = normalizeGameEvent(payload, this.live);
    this.live.connected = true;
    this.live.gameDetected = true;
    const simulating = Boolean(this.simulatorTimer) || this.live.status === 'simulating';
    this.emitStatus(simulating ? 'simulating' : 'receiving', simulating ? 'VALORANT test feed running' : 'Receiving VALORANT match data', { dataAgeMs: 0 });
    this.onEvent({ type: 'event', live: { ...this.live } });
  }

  reportError(error) {
    const message = error?.message || String(error || 'Unknown GEP error');
    this.live.errors = [{ at: new Date().toISOString(), message }, ...(this.live.errors || [])].slice(0, 8);
    this.emitStatus('error', `GEP error: ${message}`);
  }

  startWatchdog() {
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => {
      const dataAgeMs = this.live.lastUpdateAt ? Date.now() - Date.parse(this.live.lastUpdateAt) : null;
      if (dataAgeMs !== null && dataAgeMs > this.settings.staleMs) {
        this.emitStatus('stale', 'VALORANT telemetry is stale', { dataAgeMs });
      } else {
        this.live = { ...this.live, dataAgeMs };
        this.onStatus({ ...this.live });
      }
    }, 1000);
  }

  startSimulator() {
    this.stop();
    this.settings = { ...this.settings, enabled: true };
    this.live = { ...createLiveState(), gepAvailable: false, gameDetected: true, connected: true, registeredFeatures: [...VALORANT_FEATURES] };
    this.emitStatus('simulating', 'VALORANT test feed running');
    this.handleGameEvent(VALORANT_GAME_ID, { events: [{ name: 'match_start', data: '' }] });
    this.handleInfoUpdate(VALORANT_GAME_ID, { info: { match_info: { map: 'Ascent', game_mode: '{"mode":"bomb","custom":true,"ranked":"0"}', round_number: '1', round_phase: 'shopping', match_score: '{"team_0":0,"team_1":0}', match_id: `SIM-${Date.now()}` } }, feature: 'match_info' });
    const names = ['BengalOne', 'BengalTwo', 'BengalThree', 'BengalFour', 'BengalFive', 'Opponent1', 'Opponent2', 'Opponent3', 'Opponent4', 'Opponent5'];
    let tick = 0;
    this.simulatorTimer = setInterval(() => {
      tick += 1;
      const round = Math.floor(tick / 4) + 1;
      const home = Math.floor(round / 2);
      const away = Math.max(0, round - 1 - home);
      this.handleInfoUpdate(VALORANT_GAME_ID, { info: { match_info: { round_number: String(round), round_phase: tick % 4 < 2 ? 'combat' : 'shopping', match_score: JSON.stringify({ team_0: home, team_1: away }) } }, feature: 'match_info' });
      names.forEach((name, index) => {
        this.handleInfoUpdate(VALORANT_GAME_ID, {
          feature: 'match_info',
          category: 'match_info',
          key: `scoreboard_${index}`,
          data: JSON.stringify({
            name,
            player_id: `sim-${index}`,
            character: ['Phoenix', 'Hunter', 'Sarge', 'Wushu', 'Thorne', 'Vampire', 'Gumshoe', 'Guide', 'Sequoia', 'Clay'][index],
            team: index < 5 ? 0 : 1,
            teammate: index < 5,
            alive: (tick + index) % 5 !== 0,
            weapon: tick % 2 ? 'TX_Hud_Volcano' : 'TX_Hud_Pistol_Classic',
            shield: tick % 3,
            spike: index === 2 && tick % 4 === 1,
            ult_points: (tick + index) % 8,
            ult_max: 8,
            kills: Math.max(0, round - index % 3),
            deaths: Math.max(0, round - 1 - index % 2),
            assists: index % 4,
            money: 800 + (tick * 300) % 6000,
            is_local: index === 0
          })
        });
      });
      if (tick % 4 === 2) this.handleGameEvent(VALORANT_GAME_ID, { events: [{ name: 'kill_feed', data: JSON.stringify({ attacker: names[tick % 5], victim: names[5 + tick % 5], headshot: tick % 2 === 0, weapon: 'TX_Hud_Volcano', is_attacker_teammate: true, is_victim_teammate: false }) }] });
      if (tick === 18) {
        this.handleGameEvent(VALORANT_GAME_ID, { events: [{ name: 'match_end', data: '' }] });
        clearInterval(this.simulatorTimer);
        this.simulatorTimer = null;
      }
    }, 900);
  }

  stopSimulator() {
    clearInterval(this.simulatorTimer);
    this.simulatorTimer = null;
    this.configure(this.settings);
  }
}

module.exports = {
  VALORANT_FEATURES,
  VALORANT_GAME_ID,
  DEFAULTS,
  MAP_NAMES,
  AGENT_NAMES,
  ValorantService,
  createLiveState,
  normalizeGameEvent,
  normalizeInfoUpdate,
  normalizeSettings,
  mappedTeamKey,
  mapName,
  agentName
};
