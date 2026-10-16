# bench/ui-check.py <png>...: layout sanity numbers for a controller screenshot.
# - right_overflow: content pixels drawn in the last 6 px column of the window (something cut off)
# - panel_lefts / panel_rights: x of panel borders (#2d2d31) -> must line up across the page
import sys
from PIL import Image
def near(p, q, t=3): return all(abs(a-b) <= t for a, b in zip(p, q))
for f in sys.argv[1:]:
    im = Image.open(f).convert('RGB'); W, H = im.size
    bg = im.getpixel((W - 3, H // 2))
    over = sum(1 for y in range(0, H, 2) if not near(im.getpixel((W - 3, y)), bg, 12))
    lefts, rights = {}, {}
    for y in range(0, H, 2):
        row = [im.getpixel((x, y)) for x in range(257, W)]
        xs = [i + 257 for i, p in enumerate(row) if near(p, (0x2d, 0x2d, 0x31))]
        if len(xs) >= 2:
            lefts[xs[0]] = lefts.get(xs[0], 0) + 1
            rights[xs[-1]] = rights.get(xs[-1], 0) + 1
    top = lambda d: sorted(d.items(), key=lambda kv: -kv[1])[:4]
    print(f, 'size', (W, H), 'right_overflow_rows', over, 'panel_left', top(lefts), 'panel_right', top(rights))
