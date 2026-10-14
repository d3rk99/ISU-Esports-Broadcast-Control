# Downloads every agent icon from the VALORANT wiki (Category:Agent_Icons, the same files make_portraits.py uses) as
# 128x128 PNGs for the overlay: public/assets/valorant/agent-icons/<agent>.png (spectated-player name bar, 2026-10-14).
# New agent? Add it to AGENTS in make_portraits.py and run:  python3 fetch_overlay_icons.py
import os, io, json, importlib.util
from PIL import Image
here = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(here, 'make_portraits.py')).read()
ns = {}
ns['__file__'] = os.path.join(here, 'make_portraits.py')
exec(src.split('blob = bytearray()')[0], ns)  # AGENTS, get(), file_url() only
out = os.path.join(here, '..', '..', 'public', 'assets', 'valorant', 'agent-icons')
os.makedirs(out, exist_ok=True)
done = []
for agent in sorted(ns['AGENTS']):
    icon = Image.open(io.BytesIO(ns['get'](ns['file_url'](ns['AGENTS'][agent])))).convert('RGBA')
    icon.thumbnail((128, 128), Image.LANCZOS)
    canvas = Image.new('RGBA', (128, 128), (0, 0, 0, 0)); canvas.paste(icon, ((128 - icon.width) // 2, (128 - icon.height) // 2), icon)
    canvas.save(os.path.join(out, agent + '.png'), optimize=True)
    done.append(agent)
json.dump({'source': 'valorant.fandom.com Category:Agent_Icons ("<Agent> icon.png")', 'size': 128, 'agents': done}, open(os.path.join(out, 'manifest.json'), 'w'), indent=1)
print(len(done), 'icons ->', out)
