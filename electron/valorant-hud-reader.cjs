'use strict';
// VALORANT top HUD: round score (home / away) and the round timer, read by digit templates
// (electron/valorant-hud-digits.json, built by tools/valorant-hud-training/make_digits.py from
// the real crops the old OCR lab saved). Digits are cut out by ink columns; ':' and '.' are short
// and drop out. Every glyph must match one digit clearly better than any other or the whole value
// is null (never a guess). Timer: 3 digits = m:ss, 4 digits = ss.cc (last 10 s). A planted spike
// replaces the timer with an icon -> null.
const fs = require('node:fs');
const path = require('node:path');

const HUD_ROIS = {
  homeScore: { x: 800, y: 32, w: 100, h: 30 },
  timer: { x: 912, y: 26, w: 100, h: 40 },
  awayScore: { x: 1020, y: 32, w: 100, h: 30 }
};

class HudReader {
  constructor({ file = path.join(__dirname, 'valorant-hud-digits.json') } = {}) {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    this.w = d.w; this.h = d.h;
    const load = (list) => list.map((t) => ({ d: t.d, m: Uint8Array.from(t.m, (c) => (c === '1' ? 1 : 0)) }));
    this.sets = { score: load(d.score), timer: load(d.timer) };
  }

  // Glyph boxes (x0, x1 exclusive, y0, y1 exclusive) of bright ink inside roi.
  glyphs(lum, roi, thr = 122) {
    const ink = (x, y) => lum(x, y) >= thr;
    const runs = []; let s = -1;
    for (let x = roi.x; x <= roi.x + roi.w; x += 1) {
      let on = false;
      if (x < roi.x + roi.w) { let n = 0; for (let y = roi.y; y < roi.y + roi.h; y += 1) if (ink(x, y)) n += 1; on = n >= 1; }
      if (on && s < 0) s = x;
      if (!on && s >= 0) {
        let y0 = Infinity; let y1 = -1;
        for (let y = roi.y; y < roi.y + roi.h; y += 1) for (let xx = s; xx < x; xx += 1) if (ink(xx, y)) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        runs.push({ x0: s, x1: x, y0, y1: y1 + 1 }); s = -1;
      }
    }
    if (!runs.length) return [];
    const H = Math.max(...runs.map((r) => r.y1 - r.y0));
    if (H < 10) return [];
    return runs.filter((r) => r.y1 - r.y0 >= H * 0.8 && r.x1 - r.x0 >= 4 && r.x1 - r.x0 <= H * 0.9);
  }

  // Same normalisation as make_digits.py tpl(): scale by height, centre in a w x h cell.
  cell(lum, b, thr = 122) {
    const bh = b.y1 - b.y0; const bw = b.x1 - b.x0;
    const nw = Math.max(1, Math.min(this.w, Math.round(bw * this.h / bh)));
    const off = Math.floor((this.w - nw) / 2);
    const out = new Uint8Array(this.w * this.h);
    for (let j = 0; j < this.h; j += 1) for (let i = 0; i < nw; i += 1) {
      const sx = b.x0 + Math.min(bw - 1, Math.floor((i + 0.5) * bw / nw)); const sy = b.y0 + Math.min(bh - 1, Math.floor((j + 0.5) * bh / this.h));
      out[j * this.w + off + i] = lum(sx, sy) >= thr ? 1 : 0;
    }
    return out;
  }

  digit(cell, kind, { minScore = 0.55, minGap = 0.06 } = {}) {
    const best = new Map();
    for (const t of this.sets[kind]) {
      let inter = 0; let uni = 0;
      for (let k = 0; k < cell.length; k += 1) { inter += cell[k] & t.m[k]; uni += cell[k] | t.m[k]; }
      const s = uni ? inter / uni : 0;
      if (s > (best.get(t.d) || 0)) best.set(t.d, s);
    }
    const r = [...best.entries()].sort((a, b) => b[1] - a[1]);
    const ok = r[0][1] >= minScore && r[0][1] - (r[1]?.[1] || 0) >= minGap;
    return ok ? r[0][0] : null;
  }

  readDigits(lum, roi, kind, thr = 122) {
    const gs = this.glyphs(lum, roi, thr);
    if (!gs.length) return null;
    let text = '';
    for (const g of gs) { const d = this.digit(this.cell(lum, g, thr), kind); if (d === null) return null; text += d; }
    return text;
  }

  // -> { homeScore, awayScore, timer: { seconds, display, lowTime } | null }
  read(lum, { dx = 0, dy = 0 } = {}) {
    const at = (r) => ({ ...r, x: r.x + dx, y: r.y + dy });
    const score = (r) => { const t = this.readDigits(lum, at(r), 'score', 150); const v = t === null ? null : Number(t); return t !== null && t.length <= 2 && v <= 30 ? v : null; };
    const t = this.readDigits(lum, at(HUD_ROIS.timer), 'timer');
    let timer = null;
    if (t && t.length === 3) { const m = Number(t[0]); const s = Number(t.slice(1)); if (m <= 2 && s <= 59 && m * 60 + s <= 140) timer = { seconds: m * 60 + s, display: `${m}:${t.slice(1)}`, lowTime: false }; }
    else if (t && t.length === 4) { const s = Number(t.slice(0, 2)); if (s <= 10) timer = { seconds: s + Number(t.slice(2)) / 100, display: `${t.slice(0, 2)}.${t.slice(2)}`, lowTime: true }; }
    return { homeScore: score(HUD_ROIS.homeScore), awayScore: score(HUD_ROIS.awayScore), timer };
  }
}

module.exports = { HudReader, HUD_ROIS };
