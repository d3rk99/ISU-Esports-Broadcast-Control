"""Train the VALORANT gun reader.

Every official icon (public/assets/valorant/weapons/*.png) is rendered the way the scoreboard
shows it: shrunk to the board size (each gun has its own size, measured from real board crops in
public/assets/valorant/weapons/trained/), a little blur, white on the dark row colour, then the
same threshold + crop + 64x16 squash the live reader uses. Many variations per gun (size,
blur, stroke, sub-pixel shift, threshold) plus the real crops = the template set.

Output: electron/valorant-weapon-trained.bin (N x 64*16 masks) + names in
electron/valorant-gear-templates.json ("trained").
Run: python3 tools/valorant-gun-training/make_templates.py
"""
import json, os, glob, random
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
W, H = 64, 16
random.seed(7)

# Board ink height of each gun (px, 1080p) from the real crops; guns without crops get a typical size.
BOARD_H = {'classic': 21, 'shorty': 18, 'frenzy': 22, 'ghost': 22, 'sheriff': 22, 'bandit': 22,
           'stinger': 22, 'spectre': 22, 'bucky': 20, 'judge': 22, 'bulldog': 22, 'guardian': 20,
           'phantom': 22, 'vandal': 23, 'marshal': 18, 'outlaw': 20, 'operator': 20, 'ares': 20,
           'odin': 24, 'warden': 22, 'melee': 14}

def squash(mask):
    ys, xs = np.where(mask)
    if len(xs) < 8 or xs.max() - xs.min() < 12:
        return None
    c = mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    bh, bw = c.shape
    out = np.zeros((H, W), np.uint8)
    for j in range(H):
        for i in range(W):
            out[j, i] = c[min(bh - 1, int((j + .5) * bh / H)), min(bw - 1, int((i + .5) * bw / W))]
    return out

def render(icon, h, blur, stroke, thr, dx, dy):
    a = np.asarray(icon)[..., 3]
    ys, xs = np.where(a > 40)
    icon = icon.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    w = max(8, round(icon.width * h / icon.height))
    alpha = icon.split()[3].resize((w * 4, h * 4), Image.LANCZOS)
    if stroke:
        alpha = alpha.filter(ImageFilter.MaxFilter(3 if stroke == 1 else 5))
    canvas = Image.new('L', (w * 4 + 40, h * 4 + 40), 0)
    canvas.paste(alpha, (20 + dx, 20 + dy))
    small = canvas.resize(((w * 4 + 40) // 4, (h * 4 + 40) // 4), Image.BILINEAR)
    if blur:
        small = small.filter(ImageFilter.GaussianBlur(blur))
    bg = random.choice([80, 95, 110, 125])
    lum = bg + (np.asarray(small).astype(float) / 255) * (235 - bg)
    return squash(lum >= thr)

def main():
    man = json.load(open(f'{ROOT}/public/assets/valorant/weapons/manifest.json'))
    masks, names = [], []
    for w in man:
        name = w['weapon'].lower()
        icon = Image.open(f"{ROOT}/public/assets/valorant/weapons/{w['file']}").convert('RGBA')
        base = BOARD_H.get(name, 21)
        for h in (base - 2, base, base + 2):
            for blur in (0, 0.5, 0.8):
                for stroke in (0, 1):
                    for thr in (150, 175):
                        m = render(icon, h, blur, stroke, thr, random.randint(0, 3), random.randint(0, 3))
                        if m is not None:
                            masks.append(m); names.append(name)
    # real board crops, as they are (skip with --renders-only to test generalisation)
    for f in ([] if "--renders-only" in __import__("sys").argv else sorted(glob.glob(f"{ROOT}/public/assets/valorant/weapons/trained/*/*.png"))):
        a = np.asarray(Image.open(f).convert('L')).astype(int)
        # Bad old crops (taken over a bright background) are mostly light: skip them.
        if np.median(a) >= 110:
            print('skip bright crop', f.split('weapons/')[-1]); continue
        for thr in (150, 175):
            m = squash(a >= thr)
            if m is not None:
                masks.append(m); names.append(f.split('/')[-2])
    # dedupe identical masks (keeps the set small)
    seen, keep_m, keep_n = set(), [], []
    for m, n in zip(masks, names):
        k = (n, m.tobytes())
        if k not in seen:
            seen.add(k); keep_m.append(m); keep_n.append(n)
    open(f'{ROOT}/electron/valorant-weapon-trained.bin', 'wb').write(b''.join(m.tobytes() for m in keep_m))
    meta_p = f'{ROOT}/electron/valorant-gear-templates.json'
    meta = json.load(open(meta_p)); meta['trained'] = keep_n
    meta['trainedNote'] = 'tools/valorant-gun-training/make_templates.py: board-size renders of the official icons + real crops'
    json.dump(meta, open(meta_p, 'w'), indent=1)
    from collections import Counter
    print(len(keep_m), 'templates', dict(Counter(keep_n)))

if __name__ == '__main__':
    main()
