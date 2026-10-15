// Tiny PNG decoder for the tests (8-bit gray / gray+alpha / RGB / RGBA, non-interlaced). Replaces the old
// `python3 -c "from PIL import Image..."` calls so the tests run on any machine with only Node (Codex on Windows
// had 13 failures without python3, 2026-10-15). Returns { width, height, channels: 1|3, data } like PIL's
// convert('L') / convert('RGB') byte dumps (luminance = PIL's ITU-R 601-2 in its fixed-point form: (R*19595 + G*38470 + B*7471 + 0x8000) >> 16).
const fs = require('node:fs');
const zlib = require('node:zlib');

function decode(file) {
  const buf = fs.readFileSync(file); let at = 8; let width = 0; let height = 0; let depth = 8; let type = 2; const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at); const t = buf.toString('ascii', at + 4, at + 8); const d = buf.subarray(at + 8, at + 8 + len);
    if (t === 'IHDR') { width = d.readUInt32BE(0); height = d.readUInt32BE(4); depth = d[8]; type = d[9]; if (d[12]) throw new Error(`${file}: interlaced PNG not supported`); }
    if (t === 'IDAT') idat.push(d);
    at += 12 + len;
  }
  if (depth !== 8) throw new Error(`${file}: only 8-bit PNGs are supported`);
  const ch = { 0: 1, 4: 2, 2: 3, 6: 4 }[type]; if (!ch) throw new Error(`${file}: PNG colour type ${type} not supported`);
  const raw = zlib.inflateSync(Buffer.concat(idat)); const stride = width * ch; const px = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const f = raw[y * (stride + 1)]; const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)); const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= ch ? cur[i - ch] : 0; const b = prev[i]; const c = i >= ch ? prev[i - ch] : 0; let v = row[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    prev = cur;
  }
  return { width, height, ch, px };
}

function readRgb(file) {
  const { width, height, ch, px } = decode(file); const out = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    if (ch <= 2) { const g = px[i * ch]; out[i * 3] = g; out[i * 3 + 1] = g; out[i * 3 + 2] = g; }
    else { out[i * 3] = px[i * ch]; out[i * 3 + 1] = px[i * ch + 1]; out[i * 3 + 2] = px[i * ch + 2]; }
  }
  return { width, height, data: out };
}

function readGray(file) {
  const { width, height, ch, px } = decode(file); const out = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i += 1) {
    if (ch <= 2) out[i] = px[i * ch];
    else { const r = px[i * ch]; const g = px[i * ch + 1]; const b = px[i * ch + 2]; out[i] = (r * 19595 + g * 38470 + b * 7471 + 0x8000) >> 16; }
  }
  return { width, height, data: out };
}

module.exports = { readRgb, readGray };
