'use strict';
// Hero recognition for the Overwatch spectator scoreboard. Each player row shows the hero's
// in-game portrait zoomed on the face. The templates are the same art from the Overwatch Wiki
// ("<Hero> Hero.png"), packed at 64x64 by scripts/build-ow-hero-templates.py.
//
// Match: take the board window (W x H on the 1080p grid), slide it over each 64x64 template
// across a small offset range, score with mean-removed normalised correlation (RGB), keep the
// best offset per hero, pick the best hero. Checked offline on two real boards: 20/20 correct,
// best 0.76-0.95, runner-up <= 0.65. A read is accepted only above MIN_SCORE and with a clear
// gap to the runner-up; otherwise it is "unknown" (null) rather than a guess.
const fs = require('node:fs');
const path = require('node:path');

const MIN_SCORE = 0.65;
const MIN_GAP = 0.12;

function loadTemplates(dir = __dirname) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'overwatch-hero-templates.json'), 'utf8'));
  const blob = fs.readFileSync(path.join(dir, 'overwatch-hero-templates.bin'));
  const S = meta.size; const stride = S * S * 3;
  return { size: S, heroes: meta.heroes.map((hero, i) => ({ hero, rgb: blob.subarray(i * stride, (i + 1) * stride) })) };
}

// Mean-removed, unit-length vector of an RGB patch. `get(x, y)` returns [r, g, b].
function normalise(values) {
  const n = values.length / 3; const mean = [0, 0, 0];
  for (let i = 0; i < values.length; i += 3) { mean[0] += values[i]; mean[1] += values[i + 1]; mean[2] += values[i + 2]; }
  mean[0] /= n; mean[1] /= n; mean[2] /= n;
  let norm = 0; const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) { const v = values[i] - mean[i % 3]; out[i] = v; norm += v * v; }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i += 1) out[i] /= norm;
  return out;
}

class HeroMatcher {
  // window = { x, w, halfH } on the 1080p grid; offsets = template slide range.
  constructor({ templates = loadTemplates(), window = { x: 590, w: 50, halfH: 24 }, offsets = { x: [8, 14], y: [4, 16], step: 2 } } = {}) {
    Object.assign(this, { templates, window, offsets });
    // Pre-cut every template window at every offset, already normalised.
    const S = templates.size; const W = window.w; const H = window.halfH * 2;
    this.cuts = templates.heroes.map(({ hero, rgb }) => {
      const variants = [];
      for (let oy = offsets.y[0]; oy <= Math.min(offsets.y[1], S - H); oy += offsets.step) {
        for (let ox = offsets.x[0]; ox <= Math.min(offsets.x[1], S - W); ox += offsets.step) {
          const v = new Float32Array(W * H * 3); let k = 0;
          for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) { const o = ((oy + y) * S + ox + x) * 3; v[k++] = rgb[o]; v[k++] = rgb[o + 1]; v[k++] = rgb[o + 2]; }
          variants.push(normalise(v));
        }
      }
      return { hero, variants };
    });
  }

  // rgbAt(x, y) -> [r, g, b] on the 1080p grid. Returns { hero|null, score, runnerUp, gap }.
  match(rgbAt, rowCenter) {
    const { x: x0, w: W, halfH } = this.window; const H = halfH * 2;
    const raw = new Float32Array(W * H * 3); let k = 0;
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) { const p = rgbAt(x0 + x, rowCenter - halfH + y); raw[k++] = p[0]; raw[k++] = p[1]; raw[k++] = p[2]; }
    const board = normalise(raw);
    let best = { hero: null, score: -1 }; let second = -1;
    for (const { hero, variants } of this.cuts) {
      let top = -1;
      for (const v of variants) { let dot = 0; for (let i = 0; i < v.length; i += 1) dot += v[i] * board[i]; if (dot > top) top = dot; }
      if (top > best.score) { second = best.score; best = { hero, score: top }; } else if (top > second) second = top;
    }
    const gap = best.score - second;
    const accepted = best.score >= MIN_SCORE && gap >= MIN_GAP;
    return { hero: accepted ? best.hero : null, candidate: best.hero, score: Math.round(best.score * 100) / 100, runnerUp: Math.round(second * 100) / 100, gap: Math.round(gap * 100) / 100 };
  }
}

module.exports = { HeroMatcher, loadTemplates, MIN_SCORE, MIN_GAP };
