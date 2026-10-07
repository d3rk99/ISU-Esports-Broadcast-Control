# Digit templates for the VALORANT top HUD (round score + timer), from the real crops the old
# OCR lab saved: public/assets/valorant/timer-dataset/<label>/*.png (+ .json with expectedTimer)
# and public/assets/valorant/scoreboard/trained/scores/<n>/*.png.
# Each crop -> ink mask -> glyphs (column runs, small ':' / '.' dropped) -> left-to-right glyphs
# paired with the label's digits -> 10x16 binary template. Writes electron/valorant-hud-digits.json.
import glob, json, os, sys
from PIL import Image
import numpy as np
ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
TW, TH = 16, 24

INK = 122  # same fixed threshold as electron/valorant-hud-reader.cjs (white HUD text)
def ink_mask(g, dark_text):
    # score crops from the old lab are saved inverted (dark text); timer crops are raw
    return (g < 255 - INK) if dark_text else (g >= INK)

def glyphs(mask):
    cols = mask.sum(0) > 0
    out = []; s = None
    for x, on in enumerate(list(cols) + [False]):
        if on and s is None: s = x
        if not on and s is not None:
            sub = mask[:, s:x]; ys = np.where(sub.any(1))[0]
            out.append((s, x, ys[0], ys[-1] + 1)); s = None
    if not out: return []
    H = max(b[3] - b[2] for b in out)
    return [b for b in out if b[3] - b[2] >= H * 0.8 and b[1] - b[0] >= 4]  # drop ":" "." and specks (short or thin)

def tpl(mask, b):
    # Keep the glyph's shape: scale by HEIGHT only and centre it in a TW x TH cell, so a thin
    # '1' stays thin instead of being stretched into a '0'.
    x0, x1, y0, y1 = b
    sub = mask[y0:y1, x0:x1].astype('uint8') * 255
    h, w = sub.shape
    nw = max(1, min(TW, round(w * TH / h)))
    # nearest-neighbour sampling at pixel centres: identical to the JS reader's cell()
    cell = np.zeros((TH, TW), dtype=np.uint8); off = (TW - nw) // 2
    for j in range(TH):
        sy = min(h - 1, int((j + 0.5) * h / TH))
        for i in range(nw):
            sx = min(w - 1, int((i + 0.5) * w / nw))
            cell[j, off + i] = 1 if sub[sy, sx] else 0
    return cell.flatten().tolist()

def collect(kind):
    items = []
    if kind == 'timer':
        for f in sorted(glob.glob(f'{ROOT}/public/assets/valorant/timer-dataset/*/*.png')):
            meta = json.load(open(f[:-4] + '.json'))
            items.append((f, meta['expectedTimer'].replace(':', '').replace('.', ''), False, meta.get('hudMode', '')))
    else:
        for f in sorted(glob.glob(f'{ROOT}/public/assets/valorant/scoreboard/trained/scores/*/*.png')):
            items.append((f, os.path.basename(os.path.dirname(f)), True, ''))
    return items

def secs(text, low):
    # NORMAL 'mss' -> m:ss ; LOW_TIME 'sscc' -> ss.cc
    if not text or not text.isdigit(): return None
    if low: return int(text[:-2] or 0) + int(text[-2:]) / 100 if len(text) >= 3 else None
    return int(text[:-2] or 0) * 60 + int(text[-2:]) if len(text) >= 2 else None

def clean(T, rounds=1):
    # The old lab labelled crops from a clock, so near a tick a label can be one second off
    # (a '1' saved as '0'). Drop templates that look more like ANOTHER digit's group than their
    # own (median IoU to each group, leave-self-out), a few rounds until it settles.
    def iou(a, b):
        inter = sum(x & y for x, y in zip(a, b)); uni = sum(x | y for x, y in zip(a, b))
        return inter / uni if uni else 0
    for _ in range(rounds):
        groups = {}
        for i, (ch, t) in enumerate(T): groups.setdefault(ch, []).append(i)
        keep = []
        for i, (ch, t) in enumerate(T):
            med = {}
            for d, idx in groups.items():
                vals = sorted(iou(t, T[j][1]) for j in idx if j != i)
                if vals: med[d] = vals[len(vals) // 2]
            # drop only clear mislabels: another digit's group is a lot closer than its own
            other = max((v for d, v in med.items() if d != ch), default=0)
            if med.get(ch, 0) + 0.05 >= other: keep.append((ch, t))
        if len(keep) == len(T): break
        T = keep
    return T

def build(kind, skip=None, cleaned=True):
    T = []
    for f, label, dark, mode in collect(kind):
        if f == skip: continue
        g = np.array(Image.open(f).convert('L')).astype(float)
        bs = glyphs(ink_mask(g, dark))
        if len(bs) != len(label): continue
        m = ink_mask(g, dark)
        for b, ch in zip(bs, label): T.append((ch, tpl(m, b)))
    return clean(T) if cleaned else T

def classify(T, v):
    best = {}
    for ch, t in T:
        inter = sum(a & b for a, b in zip(v, t)); uni = sum(a | b for a, b in zip(v, t))
        s = inter / uni if uni else 0
        if s > best.get(ch, 0): best[ch] = s
    r = sorted(best.items(), key=lambda kv: -kv[1])
    return r[0][0], r[0][1], r[0][1] - (r[1][1] if len(r) > 1 else 0)

if __name__ == '__main__':
    if '--eval' in sys.argv:
        for kind in ['timer', 'score']:
            right = wrong = skipped = 0; bad = []
            for f, label, dark, mode in collect(kind):
                T = build(kind, skip=f)
                g = np.array(Image.open(f).convert('L')).astype(float); m = ink_mask(g, dark); bs = glyphs(m)
                if len(bs) != len(label): skipped += 1; continue
                got = ''.join(classify(T, tpl(m, b))[0] for b in bs)
                if kind == 'timer':
                    # judge against the recorded clock (within 1 s), not the rounded label
                    meta = json.load(open(f[:-4] + '.json')); low = mode == 'LOW_TIME'
                    v = secs(got, low); ok = v is not None and abs(v - meta['expectedSeconds']) <= 1.0
                else: ok = got == label
                if ok: right += 1
                else: wrong += 1; bad.append(f'{label}->{got}')
            print(kind, f'leave-one-out: {right} right, {wrong} wrong, {skipped} unsegmented', bad[:12])
    out = {'w': TW, 'h': TH}
    for kind in ['timer', 'score']:
        T = build(kind); out[kind] = [{'d': ch, 'm': ''.join(map(str, t))} for ch, t in T]
        print(kind, len(T), 'glyph templates', sorted(set(ch for ch, _ in T)))
    json.dump(out, open(f'{ROOT}/electron/valorant-hud-digits.json', 'w'))
