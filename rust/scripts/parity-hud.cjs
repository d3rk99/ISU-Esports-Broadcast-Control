// HUD reader parity: the real JS HudReader on all 152 timer crops + the 2 top-HUD frames.
// Writes rust/crates/isu-ocr/tests/parity-hud.json: { file, ox, oy, result } per image (image
// paths are repo-relative; the Rust test reads the same PNGs).   node rust/scripts/parity-hud.cjs
const path = require('node:path'); const fs = require('node:fs');
const repo = path.join(__dirname, '..', '..');
const { HudReader } = require(path.join(repo, 'electron/valorant-hud-reader.cjs'));
const { readGray } = require(path.join(repo, 'test/png.cjs'));
const h = new HudReader(); const out = [];
const run = (rel, ox, oy) => {
  const img = readGray(path.join(repo, rel));
  const lum = (x, y) => { x -= ox; y -= oy; return x < 0 || y < 0 || x >= img.width || y >= img.height ? 0 : img.data[y * img.width + x]; };
  out.push({ file: rel, ox, oy, result: h.read(lum) });
};
run('test/fixtures/val-hud-top-11-1-spike.png', 780, 20);
run('test/fixtures/val-hud-top-0-3-0011.png', 780, 20);
const dir = 'public/assets/valorant/timer-dataset';
for (const d of fs.readdirSync(path.join(repo, dir)).sort()) for (const f of fs.readdirSync(path.join(repo, dir, d)).filter((x) => x.endsWith('.png')).sort()) {
  const meta = JSON.parse(fs.readFileSync(path.join(repo, dir, d, f.replace('.png', '.json')), 'utf8'));
  run(`${dir}/${d}/${f}`, meta.roi.x, meta.roi.y);
}
fs.writeFileSync(path.join(__dirname, '..', 'crates', 'isu-ocr', 'tests', 'parity-hud.json'), JSON.stringify(out));
console.log(out.length, 'images');
