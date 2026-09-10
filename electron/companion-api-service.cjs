const crypto = require('node:crypto');
const http = require('node:http');

const DEFAULT_COMPANION_PORT = 3176;
const MAX_BODY_BYTES = 64 * 1024;

function createCompanionToken() {
  return crypto.randomBytes(24).toString('hex');
}

function normalizeCompanionSettings(value = {}) {
  const parsedPort = Number(value.port);
  return {
    enabled: Boolean(value.enabled),
    port: Number.isInteger(parsedPort) && parsedPort >= 1024 && parsedPort <= 65535
      ? parsedPort
      : DEFAULT_COMPANION_PORT,
    token: typeof value.token === 'string' && value.token.trim().length >= 16
      ? value.token.trim()
      : createCompanionToken()
  };
}

function scalar(value, fallback = '') {
  return ['string', 'number', 'boolean'].includes(typeof value) ? value : fallback;
}

function buildCompanionVariables(state = {}) {
  const gameKey = state.selectedGame || '';
  const game = state.games?.[gameKey] || {};
  const teams = Array.isArray(game.teams) ? game.teams : [];
  const home = teams[0] || {};
  const away = teams[1] || {};
  const rows = Array.isArray(game.mapRows) ? game.mapRows : [];
  const activeIndex = Number.isInteger(game.activeMap) ? game.activeMap : 0;
  const active = rows[activeIndex] || {};
  const variables = {
    selected_game: gameKey,
    event: scalar(game.match?.event),
    round: scalar(game.match?.round),
    format: scalar(game.match?.format),
    live: Boolean(game.match?.live),
    home_name: scalar(home.name),
    home_short_name: scalar(home.shortName),
    home_color: scalar(home.color),
    home_secondary_color: scalar(home.secondaryColor),
    home_score: Number(home.score) || 0,
    home_detail_score: Number(home.detailScore) || 0,
    away_name: scalar(away.name),
    away_short_name: scalar(away.shortName),
    away_color: scalar(away.color),
    away_secondary_color: scalar(away.secondaryColor),
    away_score: Number(away.score) || 0,
    away_detail_score: Number(away.detailScore) || 0,
    active_match_number: activeIndex + 1,
    active_match_index: activeIndex,
    active_mode: scalar(active.mode),
    active_map: scalar(active.map),
    active_status: scalar(active.status),
    active_winner: active.winner === 0 ? 'home' : active.winner === 1 ? 'away' : '',
    show_away_roster: Boolean(game.showAwayRoster),
    updated_at: scalar(state.updatedAt)
  };

  rows.forEach((row, index) => {
    const number = index + 1;
    variables[`match_${number}_mode`] = scalar(row.mode);
    variables[`match_${number}_map`] = scalar(row.map);
    variables[`match_${number}_status`] = scalar(row.status);
    variables[`match_${number}_winner`] = row.winner === 0 ? 'home' : row.winner === 1 ? 'away' : '';
    variables[`match_${number}_home_score`] = scalar(row.score?.[0]);
    variables[`match_${number}_away_score`] = scalar(row.score?.[1]);
  });

  if (gameKey === 'rocketleague' && game.rocketLeague?.live) {
    const live = game.rocketLeague.live;
    variables.rl_connection_status = scalar(live.status);
    variables.rl_clock_seconds = Number(live.timeSeconds) || 0;
    variables.rl_overtime = Boolean(live.overtime);
    variables.rl_arena = scalar(live.arena);
    variables.rl_spectated_player = scalar(live.spectatedPlayer);
    variables.rl_packet_rate = Number(live.packetRate) || 0;
    variables.rl_packets = Number(live.packets) || 0;
    (Array.isArray(live.players) ? live.players : []).forEach((player, index) => {
      const number = index + 1;
      variables[`rl_player_${number}_name`] = scalar(player.name);
      variables[`rl_player_${number}_team`] = Number(player.teamNum) === 0 ? 'blue' : 'orange';
      variables[`rl_player_${number}_boost`] = player.boost === null || player.boost === undefined ? '' : Number(player.boost) || 0;
      variables[`rl_player_${number}_goals`] = Number(player.goals) || 0;
      variables[`rl_player_${number}_assists`] = Number(player.assists) || 0;
      variables[`rl_player_${number}_saves`] = Number(player.saves) || 0;
      variables[`rl_player_${number}_shots`] = Number(player.shots) || 0;
    });
  }

  if (gameKey === 'valorant' && game.veto) {
    (Array.isArray(game.veto.bans) ? game.veto.bans : []).forEach((map, index) => {
      variables[`veto_ban_${index + 1}`] = scalar(map);
    });
    (Array.isArray(game.veto.picks) ? game.veto.picks : []).forEach((pick, index) => {
      const number = index + 1;
      variables[`veto_pick_${number}_map`] = scalar(pick.map);
      variables[`veto_pick_${number}_attackers`] = Number(pick.attackers) === 0 ? 'home' : 'away';
      variables[`veto_pick_${number}_home_score`] = scalar(pick.score?.[0]);
      variables[`veto_pick_${number}_away_score`] = scalar(pick.score?.[1]);
      variables[`veto_pick_${number}_winner`] = pick.winner === 0 ? 'home' : pick.winner === 1 ? 'away' : '';
    });
  }

  return variables;
}

function buildCompanionCapabilities(state = {}) {
  const gameKey = state.selectedGame || '';
  const rows = state.games?.[gameKey]?.mapRows || [];
  const actions = [
    { id: 'score.increment', label: 'Increase team series score', parameters: ['team', 'amount?', 'game?'] },
    { id: 'score.decrement', label: 'Decrease team series score', parameters: ['team', 'amount?', 'game?'] },
    { id: 'score.set', label: 'Set team series score', parameters: ['team', 'value', 'game?'] },
    { id: 'detail_score.increment', label: 'Increase current map/game score', parameters: ['team', 'amount?', 'game?'] },
    { id: 'detail_score.decrement', label: 'Decrease current map/game score', parameters: ['team', 'amount?', 'game?'] },
    { id: 'detail_score.set', label: 'Set current map/game score', parameters: ['team', 'value', 'game?'] },
    { id: 'match.next', label: 'Advance to the next map/game', parameters: ['game?'] },
    { id: 'scores.reset', label: 'Reset series and current scores', parameters: ['game?'] },
    { id: 'match.live.toggle', label: 'Toggle live/off-air', parameters: ['game?'] },
    { id: 'match.live.set', label: 'Set live/off-air', parameters: ['value', 'game?'] },
    { id: 'teams.swap', label: 'Swap home and away sides', parameters: ['game?'] },
    { id: 'game.select', label: 'Select the active game', parameters: ['game'] },
    { id: 'map.activate', label: 'Activate a map/game number', parameters: ['number', 'game?'] },
    { id: 'map.winner.set', label: 'Set or clear a map/game winner', parameters: ['number', 'team', 'game?'] },
    { id: 'maps.reset', label: 'Clear all map/game results', parameters: ['game?'] }
  ];
  if (gameKey === 'valorant') actions.push({ id: 'veto.reset', label: 'Reset VALORANT veto selections', parameters: ['game?'] });
  return {
    apiVersion: 1,
    selectedGame: gameKey,
    games: Object.keys(state.games || {}),
    matchCount: rows.length,
    teams: ['home', 'away'],
    actions,
    transports: { actions: 'HTTP POST', variables: 'HTTP GET', liveUpdates: 'SSE' }
  };
}

function sendJson(response, statusCode, value, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders
  });
  response.end(JSON.stringify(value));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        const error = new Error('Request body is too large');
        error.statusCode = 413;
        reject(error);
        request.destroy();
      }
    });
    request.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        const error = new Error('Request body must be valid JSON');
        error.statusCode = 400;
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function authorized(request, requestUrl, token) {
  const auth = String(request.headers.authorization || '');
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const supplied = request.headers['x-isu-api-key'] || bearer || requestUrl.searchParams.get('token') || '';
  const expected = Buffer.from(String(token));
  const actual = Buffer.from(String(supplied));
  return expected.length === actual.length && expected.length > 0 && crypto.timingSafeEqual(expected, actual);
}

class CompanionApiService {
  constructor({ getState, dispatchAction, onDiagnostic = () => {} }) {
    this.getState = getState;
    this.dispatchAction = dispatchAction;
    this.onDiagnostic = onDiagnostic;
    this.server = null;
    this.clients = new Set();
    this.pendingState = null;
    this.publishTimer = null;
    this.settings = normalizeCompanionSettings();
    this.status = { enabled: false, listening: false, port: this.settings.port, clients: 0, error: '' };
  }

  async configure(value = {}) {
    const next = normalizeCompanionSettings(value);
    const mustRestart = this.server && (next.port !== this.settings.port || !next.enabled);
    this.settings = next;
    if (mustRestart) await this.stop();
    if (next.enabled && !this.server) await this.start();
    if (!next.enabled) this.status = { enabled: false, listening: false, port: next.port, clients: 0, error: '' };
    return this.getStatus();
  }

  async start() {
    if (this.server) return this.getStatus();
    this.server = http.createServer((request, response) => this.handleRequest(request, response));
    this.server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
    try {
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(this.settings.port, '0.0.0.0', resolve);
      });
      this.status = { enabled: true, listening: true, port: this.settings.port, clients: 0, error: '' };
    } catch (error) {
      this.server = null;
      this.status = { enabled: true, listening: false, port: this.settings.port, clients: 0, error: error.message };
      this.onDiagnostic('companion-api-error', error.message);
    }
    return this.getStatus();
  }

  async stop() {
    const server = this.server;
    this.server = null;
    clearTimeout(this.publishTimer);
    this.publishTimer = null;
    this.pendingState = null;
    for (const client of this.clients) client.end();
    this.clients.clear();
    if (server) await new Promise((resolve) => server.close(resolve));
    this.status = { enabled: this.settings.enabled, listening: false, port: this.settings.port, clients: 0, error: '' };
    return this.getStatus();
  }

  getStatus() {
    return { ...this.status, clients: this.clients.size };
  }

  publish(state) {
    if (!this.clients.size) return;
    this.pendingState = state;
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      const payload = `event: variables\ndata: ${JSON.stringify(buildCompanionVariables(this.pendingState || {}))}\n\n`;
      this.pendingState = null;
      for (const client of this.clients) {
        if (!client.writableEnded && !client.writableNeedDrain) client.write(payload);
      }
    }, 33);
  }

  async handleRequest(request, response) {
    const requestUrl = new URL(request.url, `http://127.0.0.1:${this.settings.port}`);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-ISU-API-Key',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      });
      response.end();
      return;
    }
    if (requestUrl.pathname === '/api/companion/health' && request.method === 'GET') {
      sendJson(response, 200, { ok: true, ...this.getStatus(), apiVersion: 1 });
      return;
    }
    if (!requestUrl.pathname.startsWith('/api/companion/') || !authorized(request, requestUrl, this.settings.token)) {
      sendJson(response, requestUrl.pathname.startsWith('/api/companion/') ? 401 : 404, {
        error: requestUrl.pathname.startsWith('/api/companion/') ? 'Unauthorized' : 'Not found'
      });
      return;
    }

    const state = this.getState() || {};
    if (request.method === 'GET' && requestUrl.pathname === '/api/companion/variables') {
      sendJson(response, 200, buildCompanionVariables(state));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/companion/capabilities') {
      sendJson(response, 200, buildCompanionCapabilities(state));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/companion/state') {
      sendJson(response, 200, state);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/companion/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      response.write(`event: variables\ndata: ${JSON.stringify(buildCompanionVariables(state))}\n\n`);
      this.clients.add(response);
      this.status.clients = this.clients.size;
      request.on('close', () => {
        this.clients.delete(response);
        this.status.clients = this.clients.size;
      });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/companion/action') {
      try {
        const body = await readJsonBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.action !== 'string') {
          sendJson(response, 400, { error: 'Provide a JSON object with an action field' });
          return;
        }
        const result = await this.dispatchAction(body);
        sendJson(response, 200, { ok: true, ...result, variables: buildCompanionVariables(this.getState() || state) });
      } catch (error) {
        sendJson(response, Number(error.statusCode) || 400, { error: error.message || 'Action failed' });
      }
      return;
    }
    sendJson(response, 405, { error: 'Method not allowed or endpoint not found' });
  }
}

module.exports = {
  CompanionApiService,
  DEFAULT_COMPANION_PORT,
  buildCompanionCapabilities,
  buildCompanionVariables,
  createCompanionToken,
  normalizeCompanionSettings
};
