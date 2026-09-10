const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const {
  CompanionApiService,
  buildCompanionCapabilities,
  buildCompanionVariables,
  normalizeCompanionSettings
} = require('../electron/companion-api-service.cjs');

function exampleState() {
  return {
    selectedGame: 'valorant',
    updatedAt: '2026-09-10T00:00:00.000Z',
    games: {
      valorant: {
        teams: [
          { name: 'IDAHO STATE', shortName: 'ISU', score: 1, detailScore: 8 },
          { name: 'OPPONENT', shortName: 'OPP', score: 0, detailScore: 6 }
        ],
        match: { event: 'COLLEGIATE ESPORTS', round: 'REGULAR SEASON', format: 'Best of 3', live: true },
        activeMap: 1,
        mapRows: [
          { mode: 'Map 1', map: 'Haven', status: 'complete', winner: 0, score: ['13', '9'] },
          { mode: 'Map 2', map: 'Ascent', status: 'ready', winner: null, score: ['', ''] }
        ]
      }
    }
  };
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

test('normalizes settings with a secure key and safe port', () => {
  const settings = normalizeCompanionSettings({ enabled: true, port: 80, token: 'short' });
  assert.equal(settings.enabled, true);
  assert.equal(settings.port, 3176);
  assert.ok(settings.token.length >= 32);
});

test('builds flat Companion variables and game-aware capabilities', () => {
  const state = exampleState();
  const variables = buildCompanionVariables(state);
  assert.equal(variables.selected_game, 'valorant');
  assert.equal(variables.home_score, 1);
  assert.equal(variables.active_match_number, 2);
  assert.equal(variables.active_map, 'Ascent');
  assert.equal(variables.match_1_winner, 'home');
  const capabilities = buildCompanionCapabilities(state);
  assert.equal(capabilities.matchCount, 2);
  assert.ok(capabilities.actions.some((action) => action.id === 'veto.reset'));
});

test('serves authenticated variables and dispatches POST actions', async (t) => {
  const port = await reservePort();
  const token = 'test-key-that-is-long-enough';
  const state = exampleState();
  const received = [];
  const service = new CompanionApiService({
    getState: () => state,
    dispatchAction: async (action) => {
      received.push(action);
      state.games.valorant.teams[0].score += 1;
      return { message: 'Score changed' };
    }
  });
  t.after(() => service.stop());
  const status = await service.configure({ enabled: true, port, token });
  assert.equal(status.listening, true);

  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/companion/variables`);
  assert.equal(unauthorized.status, 401);

  const variablesResponse = await fetch(`http://127.0.0.1:${port}/api/companion/variables`, {
    headers: { 'X-ISU-API-Key': token }
  });
  assert.equal(variablesResponse.status, 200);
  assert.equal((await variablesResponse.json()).home_score, 1);

  const actionResponse = await fetch(`http://127.0.0.1:${port}/api/companion/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: 'score.increment', team: 'home' })
  });
  assert.equal(actionResponse.status, 200);
  const result = await actionResponse.json();
  assert.equal(result.ok, true);
  assert.equal(result.variables.home_score, 2);
  assert.deepEqual(received, [{ action: 'score.increment', team: 'home' }]);
});
