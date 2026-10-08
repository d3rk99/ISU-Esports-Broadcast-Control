const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { SpectateTracker, matchCandidates } = require('../electron/spectate-tracker.cjs');
const { TesseractOcrEngine } = require('../electron/valorant-ocr-engine.cjs');

const DIR = path.join(__dirname, 'fixtures', 'spectate');
const ROI = { x: 660, y: 930, w: 600, h: 60 };
const NAMES = ['Sn0wfal', 'BaldReaper', 'newx', 'Eagl3', 'Ishnarb', 'santi', 'glowstick', 'nyv', 'CWTJ', 'Mexican Sova'];
function load(file) {
  const raw = execFileSync('python3', ['-c', `from PIL import Image;import sys;im=Image.open(sys.argv[1]).convert('RGB');sys.stdout.buffer.write(im.tobytes())`, file], { maxBuffer: 1e8 });
  return (x, y) => { x -= ROI.x; y -= ROI.y; if (x < 0 || y < 0 || x >= ROI.w || y >= ROI.h) return [0, 0, 0]; const o = (y * ROI.w + x) * 3; return [raw[o], raw[o + 1], raw[o + 2]]; };
}
const rows = (tsv) => fs.readFileSync(path.join(DIR, tsv), 'utf8').trim().split('\n').map((l) => l.split('\t'));

test('spectate: fuzzy match picks the right roster name from messy OCR text', () => {
  const c = NAMES.map((name) => ({ name }));
  assert.equal(matchCandidates('SnOwfa1', c).best.name, 'Sn0wfal');
  assert.equal(matchCandidates('h  Ba1dReaper ||', c).best.name, 'BaldReaper', 'junk around the name');
  assert.ok(matchCandidates('Zephyr99', c).best.score < 0.62, 'a stranger does not clear the bar');
});

test('spectate: names on busy gameplay backgrounds (noise, bright, stripes, sky, blobs) - right or nobody, never wrong', { timeout: 300000 }, async () => {
  const ocr = new TesseractOcrEngine(); ocr.observerConcurrency = 4;
  try {
    let right = 0; const wrong = [];
    for (const [f, name, kind] of rows('truth.tsv')) {
      const t = new SpectateTracker({ ocr }); t.setCandidates(NAMES.map((n) => ({ name: n })));
      await t.sweep(load(path.join(DIR, `${f}.png`)), ROI);
      if (t.last.winner === name) right += 1; else if (t.last.winner) wrong.push(`${name}/${kind}->${t.last.winner}`);
    }
    console.log(`spectate: ${right}/50 frames right`);
    assert.deepEqual(wrong, []);
    assert.ok(right >= 45, `most frames read (${right}/50)`);
    for (const [f, , kind] of rows('negatives.tsv')) {
      const t = new SpectateTracker({ ocr }); t.setCandidates(NAMES.map((n) => ({ name: n })));
      await t.sweep(load(path.join(DIR, `${f}.png`)), ROI);
      assert.equal(t.last.winner, null, `${f} (${kind}) must be nobody`);
    }
  } finally { await ocr.close(); }
});

test('spectate: a new player needs 3 of 4 sweeps; one bad frame never flips it; nothing for 4 s = nobody', async () => {
  let now = 0; const t = new SpectateTracker({ ocr: null, now: () => now });
  t.setCandidates([{ name: 'Sn0wfal', station: 1, side: 'home' }, { name: 'nyv', station: 8, side: 'away' }]);
  const step = (name) => { now += 300; return t.report(name ? { name, score: 0.9 } : null); };
  step('Sn0wfal'); step('Sn0wfal'); assert.equal(t.snapshot().name, '', 'not after 2');
  assert.equal(step('Sn0wfal').changed, true); assert.equal(t.snapshot().name, 'Sn0wfal'); assert.equal(t.snapshot().station, 1);
  step('nyv'); assert.equal(t.snapshot().name, 'Sn0wfal', 'one stray frame does not switch');
  step('Sn0wfal'); step('nyv'); step('nyv'); step('nyv'); assert.equal(t.snapshot().name, 'nyv');
  for (let i = 0; i < 15; i += 1) step(null);
  assert.equal(t.snapshot().name, '', 'nothing readable for a while = nobody');
});

test('spectate: Rocket League uses the Stats API target (no OCR) -> roster station, side, team', () => {
  const { rocketLeagueSpectated } = require('../electron/spectate-tracker.cjs');
  const state = (live) => ({ selectedGame: 'rocketleague', games: { rocketleague: {
    teams: [{ name: 'IDAHO STATE' }, { name: 'BOISE STATE' }],
    rosters: { varsity: [{ handle: 'D3RK99', stageStation: 2 }], jv: [{ handle: 'JVGuy', stageStation: 6 }] },
    awayRosters: { varsity: [{ handle: 'Bronco', stageStation: 9 }] },
    rocketLeague: { blueTeam: 0, live: { status: 'connected', dataAgeMs: 100, ...live } } } } });
  assert.deepEqual((({ name, station, side, team }) => ({ name, station, side, team }))(rocketLeagueSpectated(state({ spectatedPlayer: 'D3RK99' }))), { name: 'D3RK99', station: 2, side: 'home', team: 'IDAHO STATE' });
  assert.equal(rocketLeagueSpectated(state({ spectatedPlayer: 'JVGuy' })).station, 6, 'JV roster too');
  assert.equal(rocketLeagueSpectated(state({ spectatedPlayer: 'Bronco' })).side, 'away');
  const stranger = rocketLeagueSpectated(state({ spectatedPlayer: 'Rando', players: [{ name: 'Rando', teamNum: 1 }] }));
  assert.equal(stranger.station, null); assert.equal(stranger.side, 'away', 'side from the RL team number');
  assert.equal(rocketLeagueSpectated(state({ spectatedPlayer: 'D3RK99', replay: true })).name, '', 'replay = nobody');
  assert.equal(rocketLeagueSpectated(state({ spectatedPlayer: 'D3RK99', status: 'disconnected' })).name, '', 'no feed = nobody');
});

// Derk's live POV crops (2026-10-07): the portrait (agent icon on the red/teal team box) gives
// the agent in ~1-10 ms; agent + the team's CURRENT colour -> one player, no OCR needed.
function loadRgb(file) {
  const raw = execFileSync('python3', ['-c', `from PIL import Image;import sys;im=Image.open(sys.argv[1]).convert('RGB');print(im.size[0]);sys.stdout.flush();sys.stdout.buffer.write(im.tobytes())`, file], { maxBuffer: 1e8 });
  const nl = raw.indexOf(10); const w = Number(raw.subarray(0, nl)); const px = raw.subarray(nl + 1);
  return (x, y) => { const o = (y * w + x) * 3; return [px[o] || 0, px[o + 1] || 0, px[o + 2] || 0]; };
}
test('spectate: POV portraits -> agent (Breach, Neon, Waylay, Sova, Yoru, Sova), team badge corner ignored', () => {
  const { AgentMatcher } = require('../electron/valorant-board-parse.cjs');
  const am = new AgentMatcher();
  const want = { 1: 'neon', 2: 'waylay', 3: 'sova', 4: 'yoru', 5: 'sova' };
  const boxes = { 1: { x: 6, y: 4, s: 76 }, 2: { x: 2, y: 2, s: 79 }, 3: { x: 6, y: 4, s: 79 }, 4: { x: 6, y: 4, s: 78 }, 5: { x: 2, y: 2, s: 78 } };
  for (const i of [1, 2, 3, 4, 5]) assert.equal(am.matchBox(loadRgb(path.join(DIR, '..', `val-pov-tag${i}.png`)), boxes[i]).agent, want[i], `tag${i}`);
  const pov = loadRgb(path.join(DIR, '..', 'val-pov-portrait-breach-red.png'));
  assert.equal(am.matchBox((x, y) => pov(x, y - 780), { x: 20, y: 800, s: 80 }).agent, 'breach');
});

test('spectate: agent + current red/teal side -> the right player with no OCR; sides swap at the half', async () => {
  const { AgentMatcher } = require('../electron/valorant-board-parse.cjs');
  const { DEFAULT_PORTRAITS } = require('../electron/spectate-tracker.cjs');
  const pov = loadRgb(path.join(DIR, '..', 'val-pov-portrait-breach-red.png'));
  const rgb = (x, y) => pov(x, y - 780);
  let calls = 0; const ocr = { recognize: async () => { calls += 1; return { text: '', confidence: 0 }; } };
  const cands = [{ name: 'Sn0wfal', station: 2, side: 'home', agent: 'breach' }, { name: 'nyv', station: 7, side: 'away', agent: 'breach' }, { name: 'santi', station: 6, side: 'away', agent: 'neon' }];
  const run = async (sides) => { const t = new SpectateTracker({ ocr, agents: new AgentMatcher() }); t.setCandidates(cands); t.setSides(sides); await t.sweep(rgb, ROI, DEFAULT_PORTRAITS.valorant); return t.last.winner; };
  assert.equal(await run({ red: 'home', teal: 'away' }), 'Sn0wfal', 'second half: home wears red');
  assert.equal(await run({ red: 'away', teal: 'home' }), 'nyv', 'first half: away wears red');
  assert.equal(calls, 0, 'portrait path needs no OCR');
  assert.equal(await run(null), null, 'without side info it does not guess (name OCR takes over)');
});

test('spectate: 2 portrait reads in a row switch the camera (name OCR still needs 3 of 4)', () => {
  let now = 0; const t = new SpectateTracker({ ocr: null, now: () => now });
  t.setCandidates([{ name: 'Sn0wfal', station: 2, side: 'home' }, { name: 'nyv', station: 7, side: 'away' }]);
  const step = (name, via) => { now += 250; return t.report(name ? { name, score: 1, via } : null); };
  step('Sn0wfal', 'portrait'); assert.equal(t.snapshot().name, '', 'one read is not enough');
  step('Sn0wfal', 'portrait'); assert.equal(t.snapshot().name, 'Sn0wfal'); assert.equal(t.snapshot().via, 'portrait');
  step('nyv', 'name'); step('nyv', 'name'); assert.equal(t.snapshot().name, 'Sn0wfal', 'name OCR still needs 3');
  step('nyv', 'name'); assert.equal(t.snapshot().name, 'nyv');
});

test('spectate speed: name cleanups read in parallel; a 4/4 name read counts as "sure" (2 in a row switch)', async () => {
  let inFlight = 0; let peak = 0;
  const ocr = { recognize: async () => { inFlight += 1; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 20)); inFlight -= 1; return { text: 'Sn0wfal', confidence: 0.95 }; } };
  let now = 0; const t = new SpectateTracker({ ocr, now: () => now });
  t.setCandidates([{ name: 'Sn0wfal', station: 2, side: 'home' }, { name: 'nyv', station: 7, side: 'away' }]);
  const rgb = (x, y) => ((x % 3) && y % 2 ? [245, 245, 245] : [40, 45, 50]);
  const roi = { x: 113, y: 816, w: 213, h: 41 };
  const t0 = Date.now(); const r1 = await t.readName(rgb, roi);
  assert.ok(Date.now() - t0 < 75, 'the 4 cleanups ran at the same time (4 x 20 ms = 80 ms if serial)');
  assert.equal(peak, 4);
  now += 30; t.report(r1.winner, { reads: r1.reads }); assert.equal(t.snapshot().name, '', 'one read is not enough');
  const r2 = await t.readName(rgb, roi); now += 30; t.report(r2.winner, { reads: r2.reads });
  assert.equal(t.snapshot().name, 'Sn0wfal', '2 sure reads switch');
});
