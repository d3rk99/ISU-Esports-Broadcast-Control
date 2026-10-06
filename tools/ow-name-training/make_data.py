# Synthetic Overwatch scoreboard name lines for fine-tuning tesseract (LSTM).
# Each sample = the name drawn in BigNoodleTooOblique like the live board (white on a team
# colour, small blur/noise), then the SAME preprocessing the live OCR does: 4x upscale,
# threshold (text = brighter than 185), shear 0.21 to straighten the italics, white margin.
# Output: out/<n>.png (black text on white) + out/<n>.gt.txt (the truth).
import os, random, string
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np

random.seed(7)
OUT = 'out'; os.makedirs(OUT, exist_ok=True)
FONT = 'fonts/BigNoodleTooOblique.ttf'
CH = string.ascii_uppercase + string.digits
REAL = ['SOFTSHELLCRAB', 'BINGUS457', 'FATPUPPYT1', 'D3RK99', 'SASYPETRU', 'STRELITZIA', 'PUNKY', 'OOLAKACHO26', 'TRIPTANGO', 'BAYNOC', 'FAZEBOBROSS', 'ESPEON', 'MSTRLUCARIO', 'NICHE', 'FROSTYDOG', 'SOLARCHER', 'BEETLEBLUDTV', 'BRUZER', 'JAVIXSHEM', 'REAVER', 'PICKUPLLAMA', 'UNDERSEABOOT', 'GXLDENGHOST', 'LUISIVERDE', 'LUISI2498', 'VISHXRE', 'BAO', 'GREEKLORE']
WORDS = ['SOFT', 'SHELL', 'CRAB', 'DIRK', 'BINGUS', 'PUPPY', 'FAT', 'NICHE', 'FROSTY', 'DOG', 'SOLAR', 'ARCHER', 'BEETLE', 'BRUZER', 'TANGO',
         'BOB', 'ROSS', 'ESPEON', 'LUCARIO', 'STRELITZIA', 'PUNKY', 'JAVIX', 'OOLA', 'KACHO', 'SASY', 'PETRU', 'BENGAL', 'ROAR', 'ORANGE',
         'TANK', 'DAMAGE', 'SUPPORT', 'KING', 'QUEEN', 'GHOST', 'SNIPE', 'NOVA', 'BLAZE', 'ZERO', 'ONE', 'XX', 'PRO', 'GG', 'TTV', 'YT']
TEAMS = [(20, 85, 96), (95, 22, 35), (30, 60, 140), (120, 40, 140), (40, 110, 60), (25, 25, 30), (150, 70, 20)]

def gamertag():
    r = random.random()
    if r < 0.04: return random.choice(REAL)
    if r < 0.35:  # word + digits: DIRK39, BINGUS457
        t = random.choice(WORDS) + ''.join(random.choices(string.digits, k=random.randint(1, 4)))
    elif r < 0.55:  # two words + digits / letters
        t = random.choice(WORDS) + random.choice(WORDS) + (''.join(random.choices(string.digits, k=random.randint(0, 3))))
    elif r < 0.75:  # digits mixed inside: D3IRK, FATPUPPYT1, B00M
        t = ''.join(random.choices(CH, weights=[3] * 26 + [2] * 10, k=random.randint(4, 12)))
    elif r < 0.85:  # number-heavy
        t = ''.join(random.choices(string.digits, k=random.randint(2, 4))) + random.choice(WORDS)
    elif r < 0.93:  # look-alikes on purpose (O/0, I/1, S/5, B/8, Z/2)
        t = ''.join(random.choice(p) for p in random.choices(['O0', 'I1', 'S5', 'B8', 'Z2', 'G6', 'A4', 'T7'], k=random.randint(4, 9)))
    else:  # names with a space ('DAMAGE 1', 'SOLARCHER 4')
        t = random.choice(WORDS) + ' ' + ''.join(random.choices(string.digits, k=random.randint(1, 2)))
    return t[:14]

def render(text):
    pt = random.choice([28, 28, 29, 29, 30])  # matches real board ink (measured on DIRK39)
    font = ImageFont.truetype(FONT, pt)
    bb = font.getbbox(text)
    w, h = bb[2] - bb[0] + random.randint(8, 30), 24  # live name box is 24 px tall
    bg = random.choice(TEAMS)
    jitter = [max(0, min(255, c + random.randint(-15, 15))) for c in bg]
    im = Image.new('RGB', (w, h), tuple(jitter))
    d = ImageDraw.Draw(im)
    y = (h - (bb[3] - bb[1])) // 2 - bb[1] + random.randint(-2, 2)
    # Real board text is bolder than the font file: draw with a stroke (0-1 px) like the live text.
    d.text((random.randint(2, 6) - bb[0], y), text, font=font, fill=(255, 255, 255), stroke_width=0)
    if random.random() < 0.5: im = im.filter(ImageFilter.GaussianBlur(random.uniform(0.2, 0.6)))
    a = np.array(im).astype(float) + np.random.normal(0, random.uniform(0, 6), (h, w, 3))
    im = Image.fromarray(np.clip(a, 0, 255).astype('uint8'))
    return im

def preprocess(im, scale=4, threshold=185, shear=0.21, pad=20):
    g = np.array(im.convert('RGB')).astype(float)
    lum = g[..., 2] * 0.114 + g[..., 1] * 0.587 + g[..., 0] * 0.299
    big = Image.fromarray(lum.astype('uint8')).resize((im.width * scale, im.height * scale), Image.BILINEAR)
    b = np.array(big)
    ink = b > threshold
    H, W = ink.shape
    out = np.full((H + pad * 2, W + pad * 2), 255, np.uint8)
    for y in range(H):
        sh = round(shear * (y - H / 2))
        for_row = np.zeros(W, bool)
        src = np.arange(W) - sh
        ok = (src >= 0) & (src < W)
        for_row[ok] = ink[y, src[ok]]
        out[y + pad, pad:pad + W][for_row] = 0
    return Image.fromarray(out)

if __name__ == '__main__':
    import sys
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
    seen = set()
    for i in range(n):
        t = gamertag()
        img = preprocess(render(t))
        img.save(f'{OUT}/{i:05d}.png')
        with open(f'{OUT}/{i:05d}.gt.txt', 'w') as fh: fh.write(t + '\n')
    print('wrote', n)
