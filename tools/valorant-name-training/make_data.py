# Synthetic VALORANT scoreboard name lines for fine-tuning tesseract (LSTM).
# Each sample = a gamertag drawn in Barlow SemiBold/Medium (the closest free match to the board's
# DIN-style font, picked by comparing with real crops) at board size, white on a row colour,
# then the SAME preprocessing the live reader uses (4x bilinear, text = brighter than 175/150).
# Output: out/<n>.png (black text on white) + out/<n>.gt.txt.
import os, random, string, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np

random.seed(11)
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out'); os.makedirs(OUT, exist_ok=True)
FONTS = [os.path.join(HERE, 'fonts', f) for f in ('Barlow-SemiBold.ttf', 'Barlow-SemiBold.ttf', 'Barlow-Medium.ttf')]
# Real names seen on ISU boards (add more after each event).
REAL = ['Sn0wfal', 'BaldReaper', 'newx', 'Eagl3', 'Ishnarb', 'santi', 'LCU glowstick', 'LCU nyv', 'CWTJ', 'LCU Mexican Sova']
TAGS = ['LCU', 'ISU', 'BSU', 'UI', 'BYU', 'USU', 'CSI', 'NNU', 'EWU', 'UW', 'OSU', 'TTV', 'GG']
WORDS = ['snow', 'fall', 'bald', 'reaper', 'eagle', 'santi', 'glow', 'stick', 'nyv', 'mexican', 'sova', 'jett', 'raze', 'viper',
         'shadow', 'ghost', 'bengal', 'roar', 'orange', 'king', 'queen', 'nova', 'blaze', 'zero', 'one', 'pro', 'ace', 'clutch',
         'frost', 'dog', 'wolf', 'panda', 'tiger', 'mango', 'boba', 'tea', 'night', 'owl', 'lucky', 'sir', 'mr', 'the']
LOOK = ['O0', 'Il1', 'S5', 'B8', 'Z2', 'G6', 'A4', 'T7', 'rn', 'vw', 'cl', 'Ii']

def word():
    w = random.choice(WORDS)
    r = random.random()
    return w.capitalize() if r < 0.30 else w.upper() if r < 0.42 else w

def gamertag():
    r = random.random()
    if r < 0.06: t = random.choice(REAL)
    elif r < 0.30: t = word() + ''.join(random.choices(string.digits, k=random.randint(1, 4)))
    elif r < 0.50: t = word() + word() + ''.join(random.choices(string.digits, k=random.randint(0, 2)))
    elif r < 0.65: t = ''.join(random.choices(string.ascii_letters + string.digits, k=random.randint(4, 12)))
    elif r < 0.85: t = random.choice(TAGS) + ' ' + word() + (word() if random.random() < 0.3 else '') + (''.join(random.choices(string.digits, k=random.randint(1, 2))) if random.random() < 0.3 else '')
    elif r < 0.92: t = ''.join(random.choice(p) for p in random.choices(LOOK, k=random.randint(4, 9)))
    else: t = word() + random.choice(['_', '.', '']) + word()
    return t[:16]

ROWS = [(78, 116, 124), (105, 108, 107), (93, 98, 101), (125, 108, 110), (133, 130, 128), (60, 66, 70), (88, 120, 130)]

def render(text):
    font = ImageFont.truetype(random.choice(FONTS), random.choice([15, 15, 16, 16, 17]))
    bb = font.getbbox(text)
    w, h = bb[2] - bb[0] + random.randint(6, 24), 22  # live name box is 22 px tall
    bg = [max(0, min(255, c + random.randint(-12, 12))) for c in random.choice(ROWS)]
    im = Image.new('RGB', (w, h), tuple(bg))
    d = ImageDraw.Draw(im)
    y = (h - (bb[3] - bb[1])) // 2 - bb[1] + random.randint(-1, 1)
    x0 = random.randint(2, 6) - bb[0]
    # Team tag + name: the board draws a thin divider bar between them (taller than the text),
    # not a space. Truth keeps a plain space ("LCU nyv").
    if ' ' in text and text.split(' ')[0] in TAGS:
        tag, rest = text.split(' ', 1)
        tw = font.getlength(tag); gap = random.randint(5, 8)
        d.text((x0, y), tag, font=font, fill=(245, 245, 245))
        bx = int(x0 + bb[0] + tw + gap)
        d.line([(bx, 2), (bx, h - 3)], fill=tuple(min(255, c + random.randint(90, 140)) for c in bg), width=1)
        d.text((bx + gap - bb[0] + bb[0], y), rest, font=font, fill=(245, 245, 245))
    else:
        d.text((x0, y), text, font=font, fill=(245, 245, 245))
    if random.random() < 0.5: im = im.filter(ImageFilter.GaussianBlur(random.uniform(0.2, 0.5)))
    a = np.array(im).astype(float) + np.random.normal(0, random.uniform(0, 5), (h, w, 3))
    return Image.fromarray(np.clip(a, 0, 255).astype('uint8'))

def preprocess(im, scale=4, threshold=175, pad=16):
    g = np.array(im.convert('RGB')).astype(float)
    lum = g[..., 2] * 0.114 + g[..., 1] * 0.587 + g[..., 0] * 0.299
    big = np.array(Image.fromarray(lum.astype('uint8')).resize((im.width * scale, im.height * scale), Image.BILINEAR))
    H, W = big.shape
    out = np.full((H + pad * 2, W + pad * 2), 255, np.uint8)
    out[pad:pad + H, pad:pad + W][big >= threshold] = 0
    return Image.fromarray(out)

if __name__ == '__main__':
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
    for i in range(n):
        t = gamertag()
        preprocess(render(t), threshold=random.choice([175, 175, 150])).save(f'{OUT}/{i:05d}.png')
        with open(f'{OUT}/{i:05d}.gt.txt', 'w') as fh: fh.write(t + '\n')
    print('wrote', n)
