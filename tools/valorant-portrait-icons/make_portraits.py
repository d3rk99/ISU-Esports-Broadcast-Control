# Builds electron/valorant-agent-portraits.{bin,json}: every agent icon from the VALORANT wiki
# (Category:Agent_Icons, "<Agent> icon.png") on the real POV box colours, teal and red, 32x32.
# New agent? Add it to AGENTS (file name on the wiki) and run:  python3 make_portraits.py
import json, os, io, urllib.request, urllib.parse
from PIL import Image
import numpy as np
AGENTS = {a: a.capitalize() + ' icon.png' for a in ['astra','breach','brimstone','chamber','clove','cypher','deadlock','fade','gekko','harbor','iso','jett','killjoy','miks','neon','omen','phoenix','raze','reyna','sage','skye','sova','tejo','veto','viper','vyse','waylay','yoru']}
AGENTS['kay-o'] = 'KAYO icon.png'
BG = {'teal': (99, 181, 159), 'red': (216, 109, 104)}  # measured on Derk's live POV crops 2026-10-08
S = 32
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'electron')
def get(url): return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'}), timeout=30).read()
def file_url(title):
    q = urllib.parse.urlencode({'action': 'query', 'titles': 'File:' + title, 'prop': 'imageinfo', 'iiprop': 'url', 'format': 'json'})
    page = next(iter(json.loads(get('https://valorant.fandom.com/api.php?' + q))['query']['pages'].values()))
    return page['imageinfo'][0]['url']
blob = bytearray(); items = []
for agent in sorted(AGENTS):
    icon = Image.open(io.BytesIO(get(file_url(AGENTS[agent])))).convert('RGBA')
    for colour, rgb in BG.items():
        bg = Image.new('RGBA', icon.size, rgb + (255,)); bg.alpha_composite(icon)
        blob += np.array(bg.convert('RGB').resize((S, S), Image.LANCZOS), dtype=np.uint8).tobytes()
        items.append({'agent': agent, 'color': colour})
open(os.path.join(OUT, 'valorant-agent-portraits.bin'), 'wb').write(blob)
json.dump({'size': S, 'source': 'valorant.fandom.com Category:Agent_Icons, composited on the live POV box colours', 'colors': BG, 'items': items}, open(os.path.join(OUT, 'valorant-agent-portraits.json'), 'w'), indent=1)
print(len(items), 'portraits')
