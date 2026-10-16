// Spectate parity: the REAL JS spectate-tracker.cjs + valorant-portrait-match.cjs on Derk's real
// name-bar crops (test/fixtures/spectate, 64 frames), POV portraits, broadcast frames
// (spectate-video), fuzzy matching, and scripted report() sequences (the camera vote).
// Writes rust/crates/isu-ocr/tests/parity-spectate.json.   node rust/scripts/parity-spectate.cjs
const path = require('node:path'); const fs = require('node:fs'); const crypto = require('node:crypto');
const repo = path.join(__dirname, '..', '..');
const S = require(path.join(repo, 'electron/spectate-tracker.cjs'));
const { PortraitMatcher } = require(path.join(repo, 'electron/valorant-portrait-match.cjs'));
const { AgentMatcher } = require(path.join(repo, 'electron/valorant-board-parse.cjs'));
const { readRgb } = require(path.join(repo, 'test/png.cjs'));
const rgbOf = (rel, ox, oy) => { const im = readRgb(path.join(repo, rel)); return (x, y) => { x -= ox; y -= oy; if (x < 0 || y < 0 || x >= im.width || y >= im.height) return [0, 0, 0]; const o = (y * im.width + x) * 3; return [im.data[o], im.data[o + 1], im.data[o + 2]]; }; };
const out = { crops: [], portraits: [], matches: [], reports: [], rl: [] };
const ROI = { x: 660, y: 930, w: 600, h: 60 };
for (const f of fs.readdirSync(path.join(repo, 'test/fixtures/spectate')).filter((x) => x.endsWith('.png')).sort()) {
  const rel = `test/fixtures/spectate/${f}`; const rgb = rgbOf(rel, ROI.x, ROI.y);
  out.crops.push({ file: rel, ox: ROI.x, oy: ROI.y, roi: ROI, variants: S.VARIANTS.map((v) => { const c = S.cleanCrop(rgb, ROI, v); return { share: c.inkShare, img: crypto.createHash('sha256').update(c.image.subarray(c.image.indexOf(10, c.image.indexOf(10, 3) + 1) + 1)).digest('hex') }; }) });
}
const pm = new PortraitMatcher(); const am = new AgentMatcher();
const pjson = (m) => ({ agent: m.agent, color: m.color, candidate: m.candidate, candidateColor: m.candidateColor, score: m.score, runnerUp: m.runnerUp, runnerUpScore: m.runnerUpScore, otherColorScore: m.otherColorScore });
for (const [rel, ox, oy, box] of [['test/fixtures/val-pov-live-sova-teal.png', 0, 0, { x: 0, y: 0, s: 74 }], ['test/fixtures/val-pov-live-red-2.png', 0, 0, { x: 0, y: 0, s: 74 }], ['test/fixtures/val-pov-portrait-breach-red.png', 0, 0, { x: 20, y: 20, s: 80 }], ['test/fixtures/val-pov-live-waylay-red.png', 0, 0, { x: 0, y: 0, s: 74 }],
  ...fs.readdirSync(path.join(repo, 'test/fixtures/spectate-video')).sort().map((f) => [`test/fixtures/spectate-video/${f}`, 0, 760, S.DEFAULT_PORTRAITS.valorant])]) {
  const rgb = rgbOf(rel, ox, oy);
  out.portraits.push({ file: rel, ox, oy, box, all: pjson(pm.match(rgb, box)), only: pjson(pm.match(rgb, box, { only: ['sova', 'gekko', 'breach', 'jett'] })), color: S.boxColorOf(rgb, box), agentBox: am.matchBox(rgb, box) });
}
const cands = [{ name: 'Sn0wfal' }, { name: 'BaldReaper' }, { name: 'newx' }, { name: 'Eagl3' }, { name: 'Ishnarb' }, { name: 'santi' }, { name: 'LCU glowstick' }, { name: 'nyv' }, { name: 'CWTJ' }, { name: 'Mexican Sova' }];
for (const t of ['SnOwfal', 'xx Sn0wfal yy', 'BALDREAPR', 'glowstik', 'LCU nyv', 'Mexlcan 5ova', '', 'zzzzzz', 'newx|', 'IshnarbSn0wfal', '5anti']) {
  const m = S.matchCandidates(t, cands); out.matches.push({ text: t, best: m.best && { name: m.best.name, score: m.best.score }, runnerUp: m.runnerUp && { name: m.runnerUp.name, score: m.runnerUp.score } });
}
out.sims = [['Sn0wfal', 'snowfal'], ['D3RK_99', 'D3RK99'], ['', 'x'], ['Lúcio', 'lucio'], ['BIG!', 'b1g']].map(([a, b]) => [a, b, S.similarity(a, b)]);
// report(): the camera vote, with a fake clock
{
  let clock = 1000; const tr = new S.SpectateTracker({ ocr: null, now: () => clock });
  tr.setCandidates([{ name: 'A', station: 1, side: 'home', team: 'ISU', agent: 'jett' }, { name: 'B', station: '2', side: 'away', team: 'LCU' }, { name: 'a' }, { name: '  ' }, { name: 'C' }]);
  const seq = [['A', 1, 'name'], ['A', 2, 'name'], ['B', 4, 'name'], ['A', 1, 'name'], ['A', 1, 'name'], [null], ['B', 1, 'portrait'], ['B', 1, 'portrait'], ['C', 3, 'name'], ['C', 3, 'name'], [null], [null], [null], [null], [null], [null], [null], [null], [null], [null]];
  for (const [name, n, via] of seq) { clock += 500; const r = tr.report(name ? { name, n, score: 0.8, via } : null); out.reports.push({ step: [name, n, via], clock, changed: r.changed, spectated: r.spectated }); }
  clock += 500; tr.setCandidates([{ name: 'C', station: 9, side: 'home' }]); const r = tr.report(null); out.reports.push({ step: ['setCandidates C station 9', 0, ''], clock, changed: r.changed, spectated: r.spectated });
  out.candidatesAfter = tr.candidates;
}
// Rocket League: Stats API target
const RS = (live, extra = {}) => ({ games: { rocketleague: { teams: [{ name: 'ISU' }, { name: 'OPP' }], rocketLeague: { blueTeam: 1, live }, rosters: { varsity: [{ handle: 'D3RK_99', stageStation: '3' }, { handle: '', name: 'Flip F17', stageStation: 0 }], jv: [] }, awayRosters: { varsity: [{ handle: 'enemy' }], jv: [] }, ...extra } } });
Date.now = () => 1234;
for (const live of [{ status: 'connected', spectatedPlayer: 'D3RK99', dataAgeMs: 10 }, { status: 'connected', spectatedPlayer: 'flipf17' }, { status: 'simulating', spectatedPlayer: 'Stranger', players: [{ name: 'Stranger', teamNum: 0 }] }, { status: 'connected', spectatedPlayer: 'Stranger', players: [{ name: 'Stranger', teamNum: 1 }] }, { status: 'connected', spectatedPlayer: 'D3RK99', replay: true }, { status: 'offline', spectatedPlayer: 'D3RK99' }, { status: 'connected', spectatedPlayer: 'X', dataAgeMs: 20000 }, { status: 'connected', spectatedPlayer: 'Ghost' }])
  out.rl.push({ live, result: S.rocketLeagueSpectated(RS(live)) });
fs.writeFileSync(path.join(__dirname, '..', 'crates', 'isu-ocr', 'tests', 'parity-spectate.json'), JSON.stringify(out));
console.log('crops', out.crops.length, 'portraits', out.portraits.length, 'reports', out.reports.length, 'rl', out.rl.length);
