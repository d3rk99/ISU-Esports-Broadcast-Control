// Shared helpers + answer key for the VALORANT board tests (real ISU screenshots).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { PROFILE } = require('../electron/valorant-board-parse.cjs');
function readRgbPng(file) {
  const buf = fs.readFileSync(file); let at = 8; let width = 0; let height = 0; let ch = 3; const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at); const type = buf.toString('ascii', at + 4, at + 8); const data = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); ch = data[9] === 6 ? 4 : 3; }
    if (type === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)); const stride = width * ch; const out = Buffer.alloc(width * height * 3); const prev = Buffer.alloc(stride); let cur = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const f = raw[y * (stride + 1)]; const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i += 1) {
      const a = i >= ch ? cur[i - ch] : 0; const b = prev[i]; const c = i >= ch ? prev[i - ch] : 0; let v = row[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < width; x += 1) for (let k = 0; k < 3; k += 1) out[(y * width + x) * 3 + k] = cur[x * ch + k];
    cur.copy(prev); cur = Buffer.alloc(stride);
  }
  return { width, height, data: out };
}
function board(name) {
  const img = readRgbPng(path.join(__dirname, 'fixtures', name));
  const rgb = (x, y) => { const lx = x - 500; const ly = y - 280; if (lx < 0 || ly < 0 || lx >= img.width || ly >= img.height) return [0, 0, 0]; const o = (ly * img.width + lx) * 3; return [img.data[o], img.data[o + 1], img.data[o + 2]]; };
  const lum = (x, y) => { const p = rgb(x, y); return Math.round(p[0] * 0.299 + p[1] * 0.587 + p[2] * 0.114); };
  return { rgb, lum };
}
// Same preprocessing idea as the live capture: white text -> black ink on white, 4x bilinear.
function cellImage(lum, roi, scale = 4, threshold = PROFILE.textThreshold, pad = 16) {
  const w = roi.w * scale + pad * 2; const h = roi.h * scale + pad * 2; const px = Buffer.alloc(w * h, 255);
  for (let y = 0; y < roi.h * scale; y += 1) for (let x = 0; x < roi.w * scale; x += 1) {
    const fx = roi.x + (x + 0.5) / scale - 0.5; const fy = roi.y + (y + 0.5) / scale - 0.5; const x0 = Math.floor(fx); const y0 = Math.floor(fy); const tx = fx - x0; const ty = fy - y0;
    const l = lum(x0, y0) * (1 - tx) * (1 - ty) + lum(x0 + 1, y0) * tx * (1 - ty) + lum(x0, y0 + 1) * (1 - tx) * ty + lum(x0 + 1, y0 + 1) * tx * ty;
    px[(y + pad) * w + x + pad] = l >= threshold ? 0 : 255;
  }
  return Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), px]);
}

// What the board shows (read by eye from the screenshot).
const AGENTS = ['viper', 'astra', 'yoru', 'jett', 'sova', 'neon', 'viper', 'astra', 'tejo', 'sova'];
const B1 = {
  home: [['Sn0wfal', '3/9', 3, 0, 0, 2600, 44], ['BaldReaper', '1/7', 1, 0, 1, 2350, 43], ['newx', '1/8', 1, 0, 1, 1250, 44], ['Eagl3', '1/8', 0, 1, 0, 1900, 48], ['Ishnarb', '1/8', 0, 1, 0, 1900, 48]],
  away: [['santi', '2/8', 1, 1, 1, 3700, 57], ['LCU glowstick', '2/9', 1, 1, 0, 3500, 64], ['LCU nyv', '1/7', 0, 1, 0, 3300, 55], ['CWTJ', '1/9', 0, 1, 0, 3350, 60], ['LCU Mexican Sova', '2/8', 0, 1, 1, 3300, 64]]
};
// Board 2 is ~10 s later in the buy phase: K/D/A and names are the same, credits/ping moved,
// so only the fields that can't change are checked there.
const B2 = Object.fromEntries(Object.entries(B1).map(([side, rows]) => [side, rows.map((r) => [r[0], undefined, r[2], r[3], r[4], undefined, undefined])]));
const FIELDS = ['name', 'ultimate', 'kills', 'deaths', 'assists', 'credits', 'ping'];

module.exports = { board, cellImage, AGENTS, B1, B2, FIELDS };
