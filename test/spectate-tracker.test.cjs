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
