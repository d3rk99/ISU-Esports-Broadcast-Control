const test = require('node:test');
const assert = require('node:assert/strict');
const { BoardIdentity, tagSimilarity } = require('../electron/valorant-board-identity.cjs');
const { BoardConsensus, emptyBoard, applySweep } = require('../electron/valorant-board-parse.cjs');

// One sweep of a fake board: rows = [{ name, kills, deaths }] per side, top to bottom as VALORANT shows them now.
function reads(rows) {
  const out = [];
  for (const side of ['home', 'away']) (rows[side] || []).forEach((p, row) => {
    out.push({ side, row, field: 'name', value: p.name });
    out.push({ side, row, field: 'kills', value: p.kills });
    out.push({ side, row, field: 'deaths', value: p.deaths });
  });
  return out;
}
function sweep(id, board, cons, rows) {
  const r = id.remap(reads(rows));
  applySweep(board, cons, r);
  for (const side of ['home', 'away']) board.teams[side].players.forEach((p, slot) => { if (p.name) id.confirm(side, slot, p.name); p.row = id.rowOf(side, slot); });
}
const byName = (board, side) => Object.fromEntries(board.teams[side].players.filter((p) => p.name).map((p) => [p.name, p]));

test('VALORANT board identity: players keep THEIR stats when the scoreboard re-sorts (Derk 2026-10-15)', () => {
  const id = new BoardIdentity(); const board = emptyBoard(); const cons = new BoardConsensus();
  const start = { home: [{ name: 'Sn0wfal', kills: 3, deaths: 0 }, { name: 'BaldReaper', kills: 1, deaths: 0 }, { name: 'newx', kills: 1, deaths: 0 }, { name: 'Eagl3', kills: 0, deaths: 1 }, { name: 'Ishnarb', kills: 0, deaths: 1 }] };
  for (let i = 0; i < 4; i += 1) sweep(id, board, cons, start);
  assert.equal(byName(board, 'home').Eagl3.kills, 0);
  // Eagl3 gets 4 kills and jumps to the top; Sn0wfal drops to row 2. One sweep later the stats must already follow.
  const resorted = { home: [{ name: 'Eagl3', kills: 4, deaths: 1 }, { name: 'Sn0wfal', kills: 3, deaths: 0 }, { name: 'BaldReaper', kills: 1, deaths: 0 }, { name: 'newx', kills: 1, deaths: 0 }, { name: 'Ishnarb', kills: 0, deaths: 1 }] };
  for (let i = 0; i < 2; i += 1) sweep(id, board, cons, resorted);
  const b = byName(board, 'home');
  assert.equal(b.Eagl3.kills, 4, 'Eagl3 kills followed him');
  assert.equal(b.Sn0wfal.kills, 3, 'Sn0wfal kept his kills');
  assert.equal(b.Eagl3.row, 0, 'Eagl3 is on row 0 now');
  assert.equal(b.Sn0wfal.row, 1, 'Sn0wfal is on row 1 now');
  // no row ever showed a mixed player: every name still has exactly one slot
  assert.equal(new Set(board.teams.home.players.map((p) => p.name)).size, 5);
});

test('VALORANT board identity: a half-read name (OCR drops a letter) still follows the right player', () => {
  const id = new BoardIdentity(); const board = emptyBoard(); const cons = new BoardConsensus();
  const rows = (a, b) => ({ home: [{ name: a, kills: 5, deaths: 1 }, { name: b, kills: 2, deaths: 2 }, { name: 'newx', kills: 1, deaths: 0 }, { name: 'Eagl3', kills: 0, deaths: 1 }, { name: 'Ishnarb', kills: 0, deaths: 1 }] });
  for (let i = 0; i < 4; i += 1) sweep(id, board, cons, rows('Sn0wfal', 'BaldReaper'));
  // swap + bad OCR on one name ("BaldReapr")
  for (let i = 0; i < 2; i += 1) sweep(id, board, cons, { home: [{ name: 'BaldReapr', kills: 2, deaths: 2 }, { name: 'Sn0wfal', kills: 5, deaths: 1 }, { name: 'newx', kills: 1, deaths: 0 }, { name: 'Eagl3', kills: 0, deaths: 1 }, { name: 'Ishnarb', kills: 0, deaths: 1 }] });
  const b = byName(board, 'home');
  assert.equal(b.BaldReaper.row, 0); assert.equal(b.BaldReaper.kills, 2);
  assert.equal(b.Sn0wfal.row, 1); assert.equal(b.Sn0wfal.kills, 5);
});

test('VALORANT board identity: pre-set roster gamertags are matched from the first read', () => {
  const id = new BoardIdentity(); id.setKnownNames({ home: ['Sn0wfal', 'BaldReaper'] });
  const r = id.remap([{ side: 'home', row: 3, field: 'name', value: 'Sn0wfa1' }]);
  assert.equal(r[0].boardRow, 3);
  assert.ok(tagSimilarity('Sn0wfa1', 'Sn0wfal') >= 0.75);
});
