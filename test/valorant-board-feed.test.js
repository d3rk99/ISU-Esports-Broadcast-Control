import test from 'node:test';
import assert from 'node:assert/strict';
import { syncValorantRoster, agentNameFromSlug, VALORANT_AGENT_ROLES } from '../src/valorant-board-panel.js';
import { GAME_CONFIGS } from '../src/game-config.js';

test('VALORANT board -> roster: agents + roles by gamertag (>= 90%), empty slots filled', () => {
  const game = {
    rosters: { varsity: [{ handle: 'Sn0wfal', character: '', role: '' }, { handle: 'BaldReaper', character: '', role: '' }, { handle: '', name: '' }] },
    awayRosters: { varsity: [] },
    valorantBoard: { live: { teams: {
      home: { players: [{ name: 'SnOwfal', agent: 'viper' }, { name: 'baldreaper', agent: 'kay-o' }, { name: 'Ishnarb', agent: 'sova' }] },
      away: { players: [] } } } }
  };
  const changes = syncValorantRoster(game, 'varsity');
  assert.equal(game.rosters.varsity[0].character, 'Viper'); assert.equal(game.rosters.varsity[0].role, 'Controller');
  assert.equal(game.rosters.varsity[1].character, 'KAY/O'); assert.equal(game.rosters.varsity[1].role, 'Initiator');
  assert.equal(game.rosters.varsity[2].handle, 'Ishnarb'); assert.equal(game.rosters.varsity[2].character, 'Sova');
  assert.ok(changes.length >= 5);
});

test('VALORANT: every agent the reader knows maps to a roster agent with a role', () => {
  for (const name of GAME_CONFIGS.valorant.characters) {
    assert.ok(VALORANT_AGENT_ROLES[name], `${name} has a role`);
    assert.equal(agentNameFromSlug(name.toLowerCase().replace(/[^a-z0-9]+/g, '-')), name);
  }
});
