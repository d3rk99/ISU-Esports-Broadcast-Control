// Parity cases for isu-ocr icons + consensus + identity: runs the REAL JS on Derk's real board
// frames and on scripted read sequences, writes rust/crates/isu-ocr/tests/parity-board.json.
//   node rust/scripts/parity-board.cjs
const path = require('node:path'); const fs = require('node:fs');
const repo = path.join(__dirname, '..', '..');
const P = require(path.join(repo, 'electron/valorant-board-parse.cjs'));
const { BoardIdentity } = require(path.join(repo, 'electron/valorant-board-identity.cjs'));
const { board } = require(path.join(repo, 'test/valorant-board-fixtures.cjs'));
const out = { frames: {}, consensus: [], identity: [] };
const agents = new P.AgentMatcher(); const gear = new P.GearMatcher();
for (const f of ['val-board-1.png', 'val-board-2.png']) {
  const b = board(f); const a = P.alignBoard(b.lum);
  const rows = [];
  for (const side of P.SIDES) for (let row = 0; row < 5; row += 1) {
    const cy = a.rows[`${side}:${row}`].cy;
    const L = P.PROFILE.columns.loadout; const S = P.PROFILE.columns.shield;
    rows.push({ side, row, cy,
      agent: agents.match(b.rgb, P.PROFILE.columns.agent.x + 16 + a.dx, cy),
      weapon: gear.weapon(b.lum, { x: L.x + a.dx, y: cy - 12, w: L.w, h: 24 }),
      shield: gear.shield(b.lum, S.x + a.dx, S.x + S.w + a.dx, cy),
      color: null });
  }
  out.frames[f] = { align: a, rows, colors: { home: P.blockColor(b.rgb, P.PROFILE, a, 'home'), away: P.blockColor(b.rgb, P.PROFILE, a, 'away') },
    box: agents.matchBox(b.rgb, { x: 560, y: 330, s: 40 }), boxOnly: agents.matchBox(b.rgb, { x: 560, y: 330, s: 40 }, { only: ['viper', 'jett', 'sova'] }) };
}
// Consensus: scripted sweeps (value null = not sure)
const seq = [
  [['home', 0, 'kills', 3]], [['home', 0, 'kills', 3]], [['home', 0, 'kills', 2]], [['home', 0, 'kills', 2]], [['home', 0, 'kills', 2]], [['home', 0, 'kills', 2]],
  [['home', 0, 'kills', 9]], [['home', 0, 'kills', 9]], [['home', 0, 'kills', 4]], [['home', 0, 'kills', 4]], [['home', 0, 'kills', null]],
  [['home', 1, 'name', 'Sn0wfal']], [['home', 1, 'name', 'Sn0wfal']], [['home', 1, 'name', 'Sn0wfal']], [['home', 1, 'name', 'Snowfal']],
  [['away', 4, 'credits', 3300], ['away', 4, 'ping', 64]], [['away', 4, 'credits', 3300], ['away', 4, 'ping', 64]], [['away', 4, 'ultimate', 'READY']],
];
{ const bd = P.emptyBoard(); bd.teams.home.players[2].nameManual = true; bd.teams.home.players[2].name = 'Manual';
  const c = new P.BoardConsensus(); let t = 1000;
  seq.push([['home', 2, 'name', 'Other']], [['home', 2, 'name', 'Other']], [['home', 2, 'name', 'Other']]);
  for (const s of seq) { t += 500; const changed = P.applySweep(bd, c, s.map(([side, row, field, value]) => ({ side, row, field, value })), t); out.consensus.push({ sweep: s, now: t, changed, board: JSON.parse(JSON.stringify(bd)) }); } }
// Identity: rows re-sorting, misreads, known roster names
const id = new BoardIdentity(); id.setKnownNames({ home: ['Sn0wfal', 'BaldReaper', 'newx'], away: [] });
const names = (home, away = []) => [...home.map((n, row) => ({ side: 'home', row, field: 'name', value: n })), ...away.map((n, row) => ({ side: 'away', row, field: 'name', value: n })), { side: 'home', row: 0, field: 'kills', value: 1 }, { side: 'home', row: 4, field: 'deaths', value: 2 }];
const script = [
  names(['Sn0wfal', 'BaldReaper', 'newx', 'Eagl3', 'Ishnarb'], ['santi', 'CWTJ']),
  names(['Sn0wfal', 'BaldReaper', 'newx', 'Eagl3', 'Ishnarb'], ['santi', 'CWTJ']),
  names(['Eagl3', 'Sn0wfal', 'BaldReaper', 'newx', 'Ishnarb'], ['CWTJ', 'santi']),
  names(['BaldReapr', 'Eagl3', null, 'Sn0wfa1', 'Ishnarb']),
  names([null, null, null, null, null]),
  names(['xx', 'Ishnarb', 'Eagl3', 'BaldReaper', 'newx']),
];
const confirms = [[['home', 0, 'Sn0wfal'], ['home', 1, 'BaldReaper'], ['home', 3, 'Eagl3'], ['home', 4, 'Ishnarb'], ['away', 0, 'santi'], ['away', 1, 'CWTJ']], [], [], [['home', 2, 'newx']], [], []];
script.forEach((reads, i) => { const r = JSON.parse(JSON.stringify(reads)); id.remap(r); out.identity.push({ reads, remapped: r, moves: id.lastMoves, rowOf: [0, 1].map((s) => [0, 1, 2, 3, 4].map((sl) => id.rowOf(['home', 'away'][s], sl))) }); for (const [s, sl, n] of confirms[i]) id.confirm(s, sl, n); out.identity[out.identity.length - 1].confirmAfter = confirms[i]; });
const dst = path.join(__dirname, '..', 'crates', 'isu-ocr', 'tests', 'parity-board.json');
fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, JSON.stringify(out));
console.log('wrote', dst, fs.statSync(dst).size, 'bytes');
