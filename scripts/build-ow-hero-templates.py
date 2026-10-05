#!/usr/bin/env python3
"""Pack the Overwatch hero portraits (public/assets/overwatch/hero-portraits, the in-game
scoreboard art from the Overwatch Wiki) into the matcher templates the scoreboard OCR loads:

  electron/overwatch-hero-templates.bin   N x 64 x 64 x RGB (uint8), composited over the
                                          board's dark blue (25,35,50) and resized bilinear
  electron/overwatch-hero-templates.json  { size: 64, heroes: [names in .bin order] }

Run after adding/updating a portrait:  python3 scripts/build-ow-hero-templates.py
"""
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'public/assets/overwatch/hero-portraits'
SIZE = 64
BG = (25, 35, 50, 255)

manifest = json.load(open(SRC / 'manifest.json'))
heroes, blob = [], bytearray()
for entry in manifest['portraits']:
    im = Image.open(SRC / entry['file']).convert('RGBA')
    bg = Image.new('RGBA', im.size, BG)
    bg.alpha_composite(im)
    blob += bg.convert('RGB').resize((SIZE, SIZE), Image.BILINEAR).tobytes()
    heroes.append(entry['hero'])
(ROOT / 'electron/overwatch-hero-templates.bin').write_bytes(bytes(blob))
json.dump({'size': SIZE, 'background': BG[:3], 'heroes': heroes}, open(ROOT / 'electron/overwatch-hero-templates.json', 'w'), ensure_ascii=False, indent=1)
print(f'{len(heroes)} hero templates, {len(blob)} bytes')
