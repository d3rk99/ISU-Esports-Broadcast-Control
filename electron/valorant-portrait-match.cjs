'use strict';
// VALORANT POV portrait -> agent AND team colour in ONE match (Derk 2026-10-08): every agent
// icon (valorant.fandom.com Category:Agent_Icons) is composited on the real teal and red box
// colours from live POV crops, so there are two references per agent. The portrait square is
// sampled down to 32x32 and compared (full RGB, incl. the box background) against them; the
// best reference names the agent and the colour together. No separate colour check.
const fs = require('node:fs');
const path = require('node:path');

class PortraitMatcher {
  constructor({ dir = __dirname } = {}) {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'valorant-agent-portraits.json'), 'utf8'));
    const bin = fs.readFileSync(path.join(dir, 'valorant-agent-portraits.bin'));
    this.size = meta.size; const n = this.size * this.size * 3;
    this.refs = meta.items.map((it, i) => ({ ...it, px: bin.subarray(i * n, (i + 1) * n) }));
  }

  // rgbAt(x,y) -> [r,g,b]; box = { x, y, s } (top-left + side of the portrait square).
  // only: agents to consider (the ones in this match). Returns the best agent+colour, and only
  // fills `agent`/`color` when it clearly beats every other AGENT (same agent, other colour,
  // doesn't count as a rival) and the colour clearly beats the same agent in the other colour.
  match(rgbAt, box, { only = null, maxScore = 55, agentGap = 8, colorGap = 6 } = {}) {
    const S = this.size;
    const refs = only && only.length >= 2 ? this.refs.filter((r) => only.includes(r.agent)) : this.refs;
    // Sample the box a few ways (small shifts / zooms: capture and box position drift a little).
    const samples = [];
    for (const inset of [0, 3, 6]) for (const dx of [-3, 0, 3]) for (const dy of [-3, 0, 3]) {
      const s = box.s - inset * 2; const k = s / S; const px = new Uint8Array(S * S * 3);
      for (let y = 0; y < S; y += 1) for (let x = 0; x < S; x += 1) {
        const p = rgbAt(Math.round(box.x + inset + dx + (x + 0.5) * k), Math.round(box.y + inset + dy + (y + 0.5) * k));
        const o = (y * S + x) * 3; px[o] = p[0]; px[o + 1] = p[1]; px[o + 2] = p[2];
      }
      samples.push(px);
    }
    const scored = refs.map((r) => {
      let best = Infinity;
      for (const px of samples) {
        let sum = 0; let n = 0;
        for (let y = 0; y < S; y += 2) for (let x = 0; x < S; x += 2) {
          if (x < S * 0.4 && y > S * 0.6) continue; // team badge corner
          const o = (y * S + x) * 3;
          for (let c = 0; c < 3; c += 1) { const d = px[o + c] - r.px[o + c]; sum += d * d; } n += 3;
        }
        const sc = Math.sqrt(sum / n); if (sc < best) best = sc;
      }
      return { agent: r.agent, color: r.color, score: best };
    }).sort((a, b) => a.score - b.score);
    const top = scored[0];
    const otherAgent = scored.find((s) => s.agent !== top.agent);
    const otherColor = scored.find((s) => s.agent === top.agent && s.color !== top.color);
    const agentOk = top.score <= maxScore && (!otherAgent || otherAgent.score - top.score >= agentGap);
    const colorOk = agentOk && (!otherColor || otherColor.score - top.score >= colorGap);
    const r1 = (v) => (v === undefined ? null : Math.round(v * 10) / 10);
    return { agent: agentOk ? top.agent : null, color: colorOk ? top.color : '', candidate: top.agent, candidateColor: top.color, score: r1(top.score),
      runnerUp: otherAgent?.agent || null, runnerUpScore: r1(otherAgent?.score), otherColorScore: r1(otherColor?.score) };
  }
}

module.exports = { PortraitMatcher };
