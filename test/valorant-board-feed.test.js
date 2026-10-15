import test from 'node:test';
import assert from 'node:assert/strict';
import { syncValorantRoster, agentNameFromSlug, VALORANT_AGENT_ROLES } from '../src/valorant-board-panel.js';
import { GAME_CONFIGS } from '../src/game-config.js';

test('VALORANT board -> roster: agents + roles by gamertag (>= 90%); a PRE-SET roster never gets board names added (Derk 2026-10-15)', () => {
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
  assert.equal(game.rosters.varsity[2].handle, '', 'the roster was pre-set: Ishnarb is NOT auto-added');
  assert.equal(changes.length, 4);
});

test('VALORANT board -> roster: an EMPTY roster still fills from the board, but never with a near-copy of a roster name', () => {
  const game = {
    rosters: { varsity: [{ handle: '' }, { handle: '' }, { handle: '' }] },
    awayRosters: { varsity: [] },
    valorantBoard: { live: { teams: { home: { players: [{ name: 'Ishnarb', agent: 'sova' }, { name: 'newx', agent: 'jett' }] }, away: { players: [] } } } }
  };
  syncValorantRoster(game, 'varsity');
  assert.equal(game.rosters.varsity[0].handle, 'Ishnarb'); assert.equal(game.rosters.varsity[0].character, 'Sova');
  assert.equal(game.rosters.varsity[1].handle, 'newx');
  // auto-added slots don't count as "pre-set": a half-read of an added name is not added again
  game.valorantBoard.live.teams.home.players.push({ name: 'Ishnarbb', agent: 'sova' });
  syncValorantRoster(game, 'varsity');
  assert.equal(game.rosters.varsity[2].handle, '', 'near-copy (>= 60%) of a name already there is skipped');
});

test('VALORANT: every agent the reader knows maps to a roster agent with a role', () => {
  for (const name of GAME_CONFIGS.valorant.characters) {
    assert.ok(VALORANT_AGENT_ROLES[name], `${name} has a role`);
    assert.equal(agentNameFromSlug(name.toLowerCase().replace(/[^a-z0-9]+/g, '-')), name);
  }
});
