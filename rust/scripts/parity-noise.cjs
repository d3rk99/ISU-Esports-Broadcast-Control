// Pink noise parity: runs the REAL electron/displays/client/noise.js makeBuffer (through a fake
// AudioContext) with a fixed Math.random sequence, at a small sample rate, and writes a few
// samples + the peak. tests/parity_noise.rs feeds the same randoms to make_channel.
//   node rust/scripts/parity-noise.cjs
const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
const repo = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(repo, 'electron/displays/client/noise.js'), 'utf8');
let seed = 1; const rnd = []; const nextRand = () => { seed = (seed * 16807) % 2147483647; const r = (seed - 1) / 2147483646; rnd.push(r); return r; };
const buffers = [];
class FakeCtx { constructor() { this.sampleRate = 400; this.state = 'running'; this.currentTime = 0; this.destination = {}; }
  createGain() { return { gain: { value: 0, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} }; }
  createBuffer(n, len) { const chs = Array.from({ length: n }, () => new Float32Array(len)); const b = { getChannelData: (c) => chs[c], chs }; buffers.push(b); return b; }
  createBufferSource() { return { connect() {}, start() {}, stop() {}, disconnect() {} }; }
  resume() {} }
const window = {}; const sandbox = { window, AudioContext: FakeCtx, Math: Object.create(Math, { random: { value: nextRand } }), Float32Array, setTimeout };
vm.runInNewContext(src, sandbox);
(async () => {
  await window.pinkNoise.set({ on: true, volume: 30 });
  const b = buffers[0]; const pick = (ch) => [0, 1, 2, 3, 199, 200, 399, 400, 401, 5000, 11999].map((i) => ch[i]);
  const out = { rate: 400, randoms: rnd, left: pick(b.chs[0]), right: pick(b.chs[1]), len: b.chs[0].length, peakL: b.chs[0].reduce((p, v) => Math.max(p, Math.abs(v)), 0), level: window.pinkNoise.level() };
  fs.writeFileSync(path.join(repo, 'rust/crates/isu-display/tests/parity-noise.json'), JSON.stringify(out));
  console.log('len', out.len, 'randoms', rnd.length, 'level', out.level);
})();
