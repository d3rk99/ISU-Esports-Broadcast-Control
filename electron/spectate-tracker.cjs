'use strict';
// Spectated-player tracker: on a spectator PC that follows player POVs, read the small on-screen
// name of the player being watched and say WHICH of our known players it is.
//
// The background behind that name changes every frame (gameplay), so this does NOT trust raw
// OCR text. Instead:
//   1. The controller sends the candidate gamertags (rosters + scoreboard names). The answer must
//      be one of them, so OCR only has to get "close enough".
//   2. Each sweep cleans the name box several ways (white-text mask that drops coloured pixels,
//      edge mask that keeps bright pixels next to a dark outline, plain thresholds) and OCRs each.
//      Every OCR text is fuzzy-matched to every candidate; the best (score, margin over the
//      runner-up) wins the sweep.
//   3. Temporal consensus: a new player is only reported after it wins `confirm` sweeps out of the
//      last `window` (default 3 of 4). One bad frame (explosion, flash) can never flip the cam.
//      Nothing readable for `holdMs` = report nobody (the cam stays where it was on the switcher).
// Game-agnostic: the box + candidates are per game, so Overwatch / Rocket League can reuse it.

const DEFAULT_ROIS = {
  // VALORANT player POV, 1920x1080: the spectated name sits bottom-left next to the agent
  // portrait. Measured by Derk on a live POV feed (2026-10-07). Adjustable in the Bridge.
  valorant: { x: 113, y: 816, w: 213, h: 41 },
  overwatch: { x: 660, y: 930, w: 600, h: 60 },
  rocketleague: { x: 660, y: 930, w: 600, h: 60 }
};

function norm(s) { return String(s || '').toLowerCase().replace(/[o]/g, '0').replace(/[il|!]/g, '1').replace(/[s]/g, '5').replace(/[^a-z0-9]/g, ''); }

// Similarity 0..1 (Levenshtein on normalised text; look-alike letters folded).
function similarity(a, b) {
  const x = norm(a); const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const d = Array.from({ length: x.length + 1 }, (_v, i) => [i]);
  for (let j = 1; j <= y.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= x.length; i += 1) for (let j = 1; j <= y.length; j += 1) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
  }
  return 1 - d[x.length][y.length] / Math.max(x.length, y.length);
}

// Best candidate for one OCR text. The text may contain extra junk around the name (HUD bits),
// so we also try every substring window of the candidate's length.
function matchCandidates(text, candidates) {
  const t = norm(text);
  const scored = candidates.map((c) => {
    const n = norm(c.name);
    let best = similarity(text, c.name);
    if (n && t.length > n.length) {
      for (let w = Math.max(1, n.length - 1); w <= n.length + 1; w += 1) {
        for (let i = 0; i + w <= t.length; i += 1) {
          const s = similarity(t.slice(i, i + w), n);
          if (s > best) best = s;
        }
      }
    }
    return { ...c, score: best };
  }).sort((a, b) => b.score - a.score);
  return { best: scored[0] || null, runnerUp: scored[1] || null };
}

// Binary PGM (black text on white) from an RGB sampler. mode:
//   'white' : bright AND not coloured (max-min channel < sat) -> gameplay colours drop out
//   'edge'  : bright pixel with a much darker pixel within 2 px (the name's dark outline/shadow)
//   'thr'   : plain brightness threshold
function cleanCrop(rgb, roi, { mode = 'white', thr = 190, sat = 45, scale = 3, pad = 16 } = {}) {
  const W = roi.w * scale; const H = roi.h * scale;
  const lumAt = (x, y) => { const [r, g, b] = rgb(x, y); return 0.299 * r + 0.587 * g + 0.114 * b; };
  const ink = new Uint8Array(roi.w * roi.h);
  for (let y = 0; y < roi.h; y += 1) for (let x = 0; x < roi.w; x += 1) {
    const px = roi.x + x; const py = roi.y + y;
    const [r, g, b] = rgb(px, py); const l = 0.299 * r + 0.587 * g + 0.114 * b;
    let on = false;
    if (mode === 'white') on = l >= thr && Math.max(r, g, b) - Math.min(r, g, b) < sat;
    else if (mode === 'edge') {
      if (l >= thr) { let dark = 255; for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) dark = Math.min(dark, lumAt(px + dx, py + dy)); on = l - dark >= 90; }
    } else on = l >= thr;
    ink[y * roi.w + x] = on ? 1 : 0;
  }
  const w = W + pad * 2; const h = H + pad * 2;
  const out = Buffer.alloc(w * h, 255);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if (ink[Math.floor(y / scale) * roi.w + Math.floor(x / scale)]) out[(y + pad) * w + x + pad] = 0;
  let count = 0; for (const v of ink) count += v;
  return { image: Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), out]), inkShare: count / ink.length };
}

const VARIANTS = [
  { mode: 'white', thr: 190 }, { mode: 'white', thr: 160 },
  { mode: 'edge', thr: 170 }, { mode: 'thr', thr: 215 }
];

class SpectateTracker {
  constructor({ ocr, now = () => Date.now(), minScore = 0.62, minMargin = 0.12, confirm = 3, window = 4, holdMs = 4000, lang = 'eng' } = {}) {
    Object.assign(this, { ocr, now, minScore, minMargin, confirm, window, holdMs, lang });
    this.candidates = [];
    this.history = [];
    this.current = null; // { name, station, side, score, since }
    this.lastSeenAt = 0;
    this.last = null; // last sweep detail (debug)
  }

  // [{ name, station?, side? }] from the controller. Blank names dropped, duplicates merged.
  setCandidates(list = []) {
    const seen = new Map();
    for (const c of list) {
      const name = String(c?.name || '').trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.set(name.toLowerCase(), { name, station: Number(c.station) || null, side: c.side || '', team: c.team || '' });
    }
    this.candidates = [...seen.values()];
    return this.candidates.length;
  }

  // One read of the box. rgb(x,y) -> [r,g,b] on the 1920x1080 grid.
  async sweep(rgb, roi) {
    if (!this.candidates.length) return this.report(null, { reason: 'no candidate names from the controller' });
    const reads = [];
    for (const v of VARIANTS) {
      const crop = cleanCrop(rgb, roi, v);
      if (crop.inkShare < 0.004 || crop.inkShare > 0.45) { reads.push({ variant: `${v.mode}${v.thr}`, text: '', skipped: crop.inkShare }); continue; }
      const r = await this.ocr.recognize(crop.image, { kind: 'text', fieldId: `spectate-${v.mode}`, allowedChars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 _.#-', lang: this.lang });
      const text = String(r?.text || '').trim();
      const m = text ? matchCandidates(text, this.candidates) : { best: null, runnerUp: null };
      reads.push({ variant: `${v.mode}${v.thr}`, text, conf: r?.confidence || 0, best: m.best?.name || '', score: m.best?.score || 0, margin: (m.best?.score || 0) - (m.runnerUp?.score || 0) });
    }
    // Votes: a variant counts if it clears the score + margin bar. The sweep winner is the name
    // with the most votes (ties: higher total score).
    const votes = new Map();
    for (const r of reads) if (r.best && r.score >= this.minScore && r.margin >= this.minMargin) {
      const v = votes.get(r.best) || { n: 0, score: 0 }; v.n += 1; v.score = Math.max(v.score, r.score); votes.set(r.best, v);
    }
    const ranked = [...votes.entries()].sort((a, b) => b[1].n - a[1].n || b[1].score - a[1].score);
    const winner = ranked[0] ? { name: ranked[0][0], ...ranked[0][1] } : null;
    return this.report(winner, { reads });
  }

  report(winner, detail = {}) {
    const t = this.now();
    this.history.push(winner?.name || null);
    if (this.history.length > this.window) this.history.shift();
    if (winner) this.lastSeenAt = t;
    const counts = new Map(); for (const n of this.history) if (n) counts.set(n, (counts.get(n) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    let changed = false;
    if (top && top[1] >= Math.min(this.confirm, this.window) && top[0] !== this.current?.name) {
      const c = this.candidates.find((x) => x.name === top[0]) || { name: top[0] };
      this.current = { ...c, score: winner?.name === top[0] ? winner.score : (this.current?.score || 0), since: t };
      changed = true;
    } else if (this.current && winner?.name === this.current.name) this.current.score = winner.score;
    if (this.current && t - this.lastSeenAt > this.holdMs) { this.current = null; changed = true; }
    this.last = { at: t, winner: winner?.name || null, ...detail };
    return { changed, spectated: this.snapshot() };
  }

  snapshot() {
    return { name: this.current?.name || '', station: this.current?.station || null, side: this.current?.side || '', team: this.current?.team || '', score: Math.round((this.current?.score || 0) * 100) / 100, since: this.current?.since || 0, updatedAt: this.now(), candidates: this.candidates.length };
  }

  clear() { this.history = []; this.current = null; this.lastSeenAt = 0; }
}

// Rocket League: the Stats API names the spectated player (Game.Target) -> roster station.
function rocketLeagueSpectated(state = {}) {
  const game = state.games?.rocketleague || {};
  const live = game.rocketLeague?.live || {};
  const name = String(live.spectatedPlayer || '').trim();
  const fresh = ['connected', 'simulating'].includes(live.status) && (live.dataAgeMs ?? 0) < 10000;
  if (!name || !fresh || live.replay) return { name: '', station: null, side: '', team: '', receivedAt: Date.now(), game: 'rocketleague' };
  const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  let hit = null;
  for (const [side, rosters, team] of [['home', game.rosters, game.teams?.[0]], ['away', game.awayRosters, game.teams?.[1]]]) {
    for (const key of ['varsity', 'jv']) for (const p of rosters?.[key] || []) {
      if (!hit && [p?.handle, p?.name].some((n) => norm(n) && norm(n) === norm(name))) hit = { station: Math.round(Number(p.stageStation) || 0) || null, side, team: team?.name || '' };
    }
  }
  // Not in a roster: still give the side from the RL team number (blue/orange mapped to home/away).
  if (!hit) {
    const player = (live.players || []).find((p) => p.name === name);
    const blue = Number(game.rocketLeague?.blueTeam) || 0;
    const teamIndex = player ? (Number(player.teamNum) === 0 ? blue : 1 - blue) : -1;
    hit = { station: null, side: teamIndex === 0 ? 'home' : teamIndex === 1 ? 'away' : '', team: game.teams?.[teamIndex]?.name || '' };
  }
  return { name, ...hit, receivedAt: Date.now(), game: 'rocketleague' };
}
module.exports = { rocketLeagueSpectated, SpectateTracker, matchCandidates, similarity, cleanCrop, DEFAULT_ROIS, VARIANTS };
