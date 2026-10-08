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
  const fuzzy = rocketLeagueSpectated(state({ spectatedPlayer: 'D3RK_99' }));
  assert.equal(fuzzy.station, 2, 'gamertag slips (>= 90%) still link to the roster');
  assert.equal(fuzzy.name, 'D3RK99', 'reported as the roster name');
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

test('spectate: free cam (portrait box gone) clears the camera after 2 reads, not 4 s', async () => {
  const { AgentMatcher } = require('../electron/valorant-board-parse.cjs');
  const { DEFAULT_PORTRAITS } = require('../electron/spectate-tracker.cjs');
  const pov = loadRgb(path.join(DIR, '..', 'val-pov-portrait-breach-red.png'));
  let freecam = false;
  const rgb = (x, y) => (freecam ? [40, 45, 50] : pov(x, y - 780)); // free cam: plain gameplay, no red/teal box
  let now = 0; const ocr = { recognize: async () => ({ text: '', confidence: 0 }) };
  const t = new SpectateTracker({ ocr, agents: new AgentMatcher(), now: () => now });
  t.setCandidates([{ name: 'Sn0wfal', station: 2, side: 'home', agent: 'breach' }]); t.setSides({ red: 'home', teal: 'away' });
  for (let i = 0; i < 2; i += 1) { now += 250; await t.sweep(rgb, ROI, DEFAULT_PORTRAITS.valorant); }
  assert.equal(t.snapshot().name, 'Sn0wfal');
  freecam = true;
  now += 250; await t.sweep(rgb, ROI, DEFAULT_PORTRAITS.valorant); assert.equal(t.snapshot().name, 'Sn0wfal', 'one empty frame is not enough');
  now += 250; await t.sweep(rgb, ROI, DEFAULT_PORTRAITS.valorant); assert.equal(t.snapshot().name, '', 'cleared after 2 empty reads (0.5 s)');
});

// Regression (Derk 2026-10-08, live): after the free-cam change players were almost never found.
// Cause: when the portrait box colour was not seen (shifted capture, shading, no agents/sides from
// the controller) the tracker called it "free cam" and skipped the name read entirely. Now a name
// in the name box is ALWAYS read; "nobody" needs no box AND an empty name box.
test('spectate: portrait box not recognised but a name is on screen -> still read by name (never "free cam")', async () => {
  const { AgentMatcher } = require('../electron/valorant-board-parse.cjs');
  let now = 0; let calls = 0;
  const ocr = { recognize: async () => { calls += 1; return { text: 'Ishnarb', confidence: 0.95 }; } };
  const t = new SpectateTracker({ ocr, agents: new AgentMatcher(), now: () => now });
  t.setCandidates([{ name: 'Ishnarb', station: 5, side: 'home', agent: 'sova' }, { name: 'nyv', station: 7, side: 'away', agent: 'breach' }]);
  // Dark gameplay everywhere (no red/teal box), white name text in the name box.
  const rgb = (x, y) => (x >= ROI.x + 10 && x < ROI.x + 60 && y >= ROI.y + 10 && y < ROI.y + 25 && (x % 3) ? [245, 245, 245] : [40, 45, 50]);
  for (let i = 0; i < 4; i += 1) { now += 250; await t.sweep(rgb, ROI, { x: 20, y: 800, s: 80 }); }
  assert.ok(calls > 0, 'the name was read');
  assert.equal(t.snapshot().name, 'Ishnarb');
});
