# ISU Esports Broadcast Control

A local-first broadcast production suite for Idaho State Esports. It runs the on-air graphics, reads live game data, drives the stage screens in the arena, and lets a Bitfocus Companion / Stream Deck operator run the show from buttons. Everything runs on your own PCs on the local network; there is no cloud service.

Supported titles: **Overwatch 2, VALORANT, Rocket League, Smash Bros. Ultimate, Call of Duty.**

Version: **v0.6.2** (Broadcast Control) · Companion module **0.1.3** · ISU Stream Server **0.3.0**

## What it does

### Match control and scorekeeping
- One control screen per game, with that game's formats, modes, maps, score limits, roles and roster sizes.
- Series score, in-game score and per-map winners; map results add up to the series score automatically.
- Live/off-air toggle, team swap, score reset and one-step undo.
- **Next Match** moves to the next map/game and clears the in-game score, round history and player stats while keeping the series score.
- Destructive buttons need a second click within 3 s (no pop-up ever freezes the controller on air).
- Map planning: VALORANT veto with duplicate-safe picks and one-click reset, Overwatch hero bans per map, and map pools for Overwatch, Rocket League, Smash and Call of Duty.

### Teams and rosters
- Home and Away teams, each with separate **Varsity and JV** rosters (both can be on stage at the same time).
- Team colors (primary + optional secondary) carried through every graphic.
- Per-player headshot, handle, name, role and **station number** (which stage PC they sit at).
- Game-specific character pickers (heroes, agents, fighters, cars, operators) with a shared character art library: upload a character image once and every player who uses that character gets it.
- HD transparent hero art for Overwatch and face-aligned agent art for VALORANT.

### On-air graphics (OBS)
Transparent 1920 × 1080 browser-source pages served by the app, updated live over WebSocket (no OBS reloads):
- **Scoreboard**: changes layout with the selected game. Shows the spectated player's live stats where the game provides them.
- **Map pool / veto**
- **Roster**: player portrait, then the character art after seven seconds
- **Player cards** (inside the scoreboard HUD and on the stage screens): name, character art and stats per player; between matches they show the last finished game
- **Program output**: switches between scoreboard, roster, map pool and a clean feed, with **fill / key / pair** outputs for hardware keying
- The Outputs page copies every URL and opens preview windows.

### Live game data
- **Rocket League**: the official Stats API (TCP or WebSocket) gives goals, clock, overtime, arena, player stats, boost and the spectated player. Series scoring and next-game advance are automatic and duplicate-safe. A built-in test feed lets you check the graphics without a match.
- **VALORANT**: an OCR scoreboard reader (Observer 3) reads player names, agents, ultimates, K/D/A, credits, guns, shields, round score and timer, and feeds the HUD player cards, station cards and roster. A round history bar follows the side swap after round 12 and in overtime.
- **Overwatch 2**: an OCR scoreboard reader reads names, heroes and stat columns with auto-alignment to the board, a trained name model, the perk layout and per-map hero bans. Names can be fixed by hand and OCR will never overwrite them.
- **Spectated player tracking**: the app knows whose camera the observer is on (Rocket League from the Stats API; VALORANT from the agent portrait and side colour, or the on-screen name; Overwatch from the name). Companion gets the player, station, side and team, so a camera switch can follow the observer.

### ISU Esports Game Bridge (Game PC)
A separate portable app for the game/observer PC. It connects to Broadcast Control over an authenticated link with live / idle / disconnected status and packet rate.
- Rocket League mode: forwards the Stats API to the graphics PC.
- VALORANT / Overwatch modes: native Windows Graphics Capture (keeps working when the game window is behind another window), with debug capture tools to line up the read boxes.

### Stage displays (arena screens)
- **ISU Display Client** runs on every station PC, full screen on the audience-facing monitor, from the tray, starting with Windows. It bundles the NDI runtime.
- The controller's **Stage** page switches each station (or stations 1-5 / 6-10, or all) between **Game mirror** (that PC's own player monitor) and **NDI** (a graphic from OBS).
- NDI presets: idle, team intro, player cards (the roster player at that station), team banners spanning five screens, series score, black.
- **Set up OBS** builds the ten NDI scenes for you (OBS 31.1+ with DistroAV).
- Cursor lock keeps the mouse on the player monitor, and the controller can play pink noise on the player headsets.

### Bitfocus Companion / Stream Deck
- A native **Companion 5 module** (`companion-module/`, v0.1.3) with actions, feedbacks, presets and live variables over a live event connection.
- A token-authenticated **LAN API** (port 3176) for Generic HTTP if you'd rather use that.
- Actions: score up/down/set, detail score, live toggle, Next Match, team swap, game select, map activate/winner/reset, veto reset, Overwatch bans, output select, stage display mode/preset and pink noise.
- Variables: scores, maps, live state, Rocket League player names and spectated slot (`rl_spectated_slot`, ...), spectated player/station/side/team, and `display_N_*` per station.

### Rocket League Car Render Lab (experimental)
- Reads each player's loadout from the Stats API and renders their car (body, decal, wheels, paint) in WebGL from a locally extracted asset pack, then saves a transparent PNG for the player cards.
- Garage colors per player can be saved, because the Stats API doesn't send them.
- See `docs/rocket-league-car-renderer.md` for what works and its limits.

### ISU Stream Server (Director PC, separate app)
A standalone streaming app in `stream-server/`:
- Capture: video capture devices the way OBS does it (webcams, capture cards, Blackmagic Web Presenter, OBS Virtual Camera, DeckLink through DirectShow), a file, or a test pattern.
- **One** H.264/AAC encode (NVENC or x264), then a **broadcast delay** (default 300 s, up to 24 h), then the same stream to any number of RTMP/RTMPS destinations.
- Fails closed: nothing is ever sent before the delay is full, and an encoder or disk error stops every output.
- Each destination reconnects on its own and can't slow the others down.
- Live recording, a program preview, audio meters, A/V sync offset, stream keys encrypted with Windows DPAPI, and its own Companion API (port 3180).
- Details: `stream-server/ARCHITECTURE.md`.

## Network ports

| Port | What |
| --- | --- |
| 3174 | Overlay and state server (OBS pages, stage preset pages) |
| 3176 | Companion LAN API (off until enabled) |
| 3178 | Stage Display Manager (display clients) |
| 3180 | Stream Server API (off until enabled) |
| 49123 / 49124 | Rocket League Stats API (TCP / WebSocket) |

## Quick start

### OBS browser sources
Keep Broadcast Control running. In OBS add a 1920 × 1080 Browser Source:

```text
http://127.0.0.1:3174/overlays/scoreboard.html
http://127.0.0.1:3174/overlays/map-pool.html
http://127.0.0.1:3174/overlays/roster.html?program=varsity
http://127.0.0.1:3174/overlays/roster.html?program=jv
http://127.0.0.1:3174/overlays/program.html?output=fill   (or key / pair)
```

### Rocket League live data
Before launching Rocket League, edit `<Rocket League Install>\TAGame\Config\TAStatsAPI.ini` (or `DefaultStatsAPI.ini` if the first does not exist):

```ini
[TAGame.MatchStatsExporter_TA]
PacketSendRate=30
Port=49123
WebPort=49124
```

Restart Rocket League. In Broadcast Control: **Rocket League → Match Control → Live Data**, then pick:
- **This PC / direct**: the game and Broadcast Control are on the same PC.
- **Game PC bridge**: generate a bridge key, run the Game Bridge on the game PC, choose Rocket League and enter the graphics PC's IPv4 address and the key.

Boost is only sent while the game client is spectating.

### VALORANT OCR
1. Run VALORANT at 1920 × 1080, borderless windowed, Observer 3 scoreboard view.
2. In Broadcast Control: **VALORANT → Match Control**, Data Source **Universal Game Bridge**, generate a key, enable OCR.
3. On the game PC: Game Bridge → **VALORANT**, enter the address, port and key.
4. Use **Find Window** and **Capture Debug Frame** to check the read boxes, then start.

Leave **Recorded Video Test Mode** off for live matches.

### Companion
- **Native module:** build it with `npm run package:companion`, then in Companion 5 use **Modules → Import module package** with the `.tgz` it makes, add an **ISU Esports Broadcast Control** connection, enter the controller address, port and API key, then use the presets.
- **Generic HTTP:** **Settings → Bitfocus Companion API → Enable LAN API**, copy the base URL and key. Send the header `{"X-ISU-API-Key":"<key>"}` and `POST /action` with a body such as:

```json
{"action":"score.increment","team":"home"}
{"action":"match.next"}
{"action":"map.winner.set","number":1,"team":"home"}
{"action":"game.select","game":"rocketleague"}
```

`GET /capabilities` lists the actions for the selected game, `GET /variables` the variables, `GET /state` the full state and `GET /events` live updates.

### Stage displays
See `docs/display-client-install.md` (install, firewall, OBS setup, NDI).

## Development

Requirements: Windows, Node.js 20 or newer.

```powershell
npm install
npm run dev
```

Checks before handing off changes:

```powershell
npm run check
npm test
npm run test:ui
npm run test:rl-cars   # needs a graphical Windows session
npm run build
```

Packages (output in `release/`):

```powershell
npm run package                 # Broadcast Control installer + portable, and the Game Bridge
npm run package:bridge          # Game Bridge only
npm run ndi:install             # once, before the display client
npm run package:display-client  # ISU Display Client
npm run package:companion       # Companion module .tgz
npm --prefix stream-server run build   # ISU Stream Server
```

## Large asset pack

The Rocket League extracted loadout pack is about 7.56 GB and is **not** in git:

```text
assests/rl-loadout-assets.zip
SHA256: 31BB61D57C5F9EA3385A8F4672E80159215CB957958508040835738D685813C9
```

Keep it at that path or extract it to `assests/rl-loadout-assets/` (the folder name is spelled `assests`). The small `assests/rocket-league-items.csv` is committed. See `docs/rocket-league-loadout-assets.md`.

## Project layout

```text
electron/            Main process: overlay server, telemetry, Game Bridge, OCR readers, Companion API
electron/displays/   Stage Display Manager, Display Client, OBS setup, NDI
src/                 Controller UI (app.js), game rules (game-config.js), Car Render Lab, panels
public/overlays/     OBS pages: scoreboard (with player cards), map pool, roster, program output
public/displays/     Stage preset pages rendered by OBS for NDI
companion-module/    Native Bitfocus Companion 5 module
stream-server/       ISU Stream Server (separate app)
bridge/              Game Bridge UI
tools/, scripts/     Training/asset tools, build and verify scripts
test/                Automated tests
docs/                Developer docs
```

## Data storage

Control data is saved locally by the app. Overlays and stage pages read state from the controller on `127.0.0.1:3174` and get changes live. Companion and display settings are kept in the app's data folder; the Companion API listens on the LAN only when you turn it on.

## More documentation

- `docs/developer-handoff.md`: project map, ports, build commands, subsystem notes
- `docs/display-client-install.md`: station PC install, firewall, OBS and NDI
- `docs/rocket-league-car-renderer.md`, `docs/rocket-league-loadout-assets.md`, `docs/rocket-league-player-cameras.md`
- `docs/valorant-observer3-ocr-plan.md`
- `stream-server/ARCHITECTURE.md`
