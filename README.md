# ISU Esports Broadcast Control

A local-first desktop control center for Idaho State Esports broadcasts. This foundation release provides game-aware scorekeeping, match/map planning, and Varsity/JV roster management for:

- Overwatch 2
- VALORANT
- Rocket League
- Smash Bros. Ultimate
- Call of Duty

## Current milestone — v0.6.0

- Secure Electron desktop shell
- Official ISU Roarange/Bengal Black-inspired control interface
- Persistent per-game match state
- Per-game formats, modes, maps, score limits, roles, and roster sizes
- Live/off-air state, team swapping, score reset, and one-step undo
- Map results that automatically calculate series score
- Separate Varsity and JV rosters for both Home and Away teams
- Optional Away-roster mode with a timed camera-slide transition from Home to Away
- Game-specific Hero, Agent, Fighter, Car, and Operator dropdowns
- Shared per-game character artwork library: upload a PNG once and reuse it for every player using that character
- Optional team secondary colors carried through the scoreboard, map, and roster graphics
- Higher-contrast game selector with a dark native dropdown menu
- Duplicate-safe Valorant veto dropdowns with one-click map-selection reset
- Green Next Match control that advances the active map/game and resets in-game scores while preserving the series score
- Local overlay server with real-time state updates
- Game-aware scoreboard overlay that changes with the selected title
- Valorant map veto overlay adapted from the Hero Bans visual system
- Game-aware map pool layout for Overwatch, Rocket League, Smash, and Call of Duty
- Roster overlay with player portrait → character artwork transition after seven seconds
- Per-player portrait selection and shared character artwork metadata
- Copyable OBS URLs and built-in overlay preview windows
- Official Rocket League Stats API integration over WebSocket or TCP
- Live Rocket League goals, clock, overtime, arena, player stats, spectated player, and boost
- Duplicate-safe automatic Rocket League series scoring and next-game advancement
- Built-in Rocket League test feed for broadcast setup without a running match
- Authenticated two-PC Rocket League bridge with a separate portable Game PC companion
- Accurate Live/Idle/Disconnected bridge status, current packet rate, and stale-feed detection
- Unthrottled background telemetry publishing so OBS stays current while the Controller is minimized or behind another app
- Rate-limited live publishing that cannot be starved by Rocket League's high-frequency packet stream
- Stable Controller scrolling and form editing while live telemetry continues updating
- Operator-selectable Rocket League boost update interval from 1–50 ms, with source-rate-aware game configuration
- Rocket League connection details backed up outside browser storage for rebuild and forced-restart recovery
- Opt-in, token-authenticated Bitfocus Companion LAN API on port 3176
- Companion-ready score, next-match, live, map, game-selection, and team-side actions
- Flat live variables plus game-aware capabilities and server-sent event endpoints

## Bitfocus Companion remote control

Open **Settings → Bitfocus Companion API**, turn on **Enable LAN API**, then copy the displayed base URL and private API key. The service listens on the Graphics PC only while Broadcast Control is open and the API toggle is enabled.

In Companion, add a **Generic HTTP** connection:

- Base URL: the URL shown in Broadcast Control, such as `http://192.168.1.50:3176/api/companion`
- Header on each action: `{"X-ISU-API-Key":"paste-your-private-key"}`
- Score button: `POST /action`, content type `application/json`, body `{"action":"score.increment","team":"home"}`
- Next Match button: `POST /action`, body `{"action":"match.next"}`
- Read variables: `GET /variables`; disable JSON stringification in Companion to access nested response values

Common action bodies:

```json
{"action":"score.decrement","team":"away"}
{"action":"score.set","team":"home","value":2}
{"action":"detail_score.increment","team":"home"}
{"action":"match.live.toggle"}
{"action":"teams.swap"}
{"action":"game.select","game":"rocketleague"}
{"action":"map.activate","number":2}
{"action":"map.winner.set","number":1,"team":"home"}
{"action":"maps.reset"}
{"action":"veto.reset","game":"valorant"}
```

Use `GET /capabilities` to discover actions for the selected game, `GET /state` for the authenticated full broadcast state, and `GET /events` for server-sent live variable updates. The query-string form `?token=...` is supported for clients that cannot set headers, but the header is preferred because URLs may appear in logs.

### Native Companion module

Companion 5 users can import the packaged `idahostate-esports-broadcast-control-0.1.0.tgz` from **Modules → Import module package**. After importing it:

1. Add an **ISU Esports Broadcast Control** connection.
2. Enter the Controller PC address, API port, and private API key shown in Broadcast Control.
3. Add the included presets or choose the module's named actions directly.

The native module maintains a live event connection, so its variables and feedbacks update automatically without Generic HTTP polling. Source is in `companion-module/`; rebuild it with `npm run package:companion`.

## Rocket League live data

Before launching Rocket League, edit `<Rocket League Install>\TAGame\Config\TAStatsAPI.ini` (or `DefaultStatsAPI.ini` when the first file does not exist):

```ini
[TAGame.MatchStatsExporter_TA]
PacketSendRate=30
Port=49123
WebPort=49124
```

Restart Rocket League after changing the file. In Broadcast Control, select **Rocket League → Match Control**, enable **Live Data**, and choose one of these modes:

- **This PC / direct:** Broadcast Control and Rocket League are on the same computer.
- **Game PC bridge:** Broadcast Control is on the Graphics PC. Generate a private bridge key, then run the ISU Esports Game Bridge on the Game PC, choose Rocket League, and enter the Graphics PC's displayed IPv4 address and matching key.

Player boost is supplied by Rocket League while the game client is spectating. The test-feed button verifies scoring, clocks, players, boost meters, and OBS updates without a live match.

## Universal Game Bridge and VALORANT OCR

The same **ISU Esports Game Bridge** executable supports both Rocket League and VALORANT. Select the active game adapter before starting the bridge.

For VALORANT on a separate Game PC:

1. Run VALORANT at 1920 × 1080 in borderless windowed mode.
2. In Broadcast Control on the Graphics PC, select **VALORANT → Match Control**, set **Data Source** to **Universal Game Bridge**, generate a bridge key, and enable OCR capture.
3. On the Game PC, select **VALORANT OCR** in the bridge, enter the Graphics PC address, port, and matching key.
4. Use **Find Window** and **Capture Debug Frame** to verify the three OCR regions, then start the bridge.

Capture, OCR, temporal validation, ROI calibration, and the test feed run on the VALORANT PC. Only compact normalized state is sent to Broadcast Control. Rocket League continues to use its Stats API adapter in the same executable.

The OCR adapter now prefers native Windows Graphics Capture, which keeps acquiring the selected window when it is behind another window. **Automatic** is the recommended capture engine; it falls back to Electron capture if native capture cannot start. Capture and OCR run on separate schedules, and home score, timer, and away score use independent OCR workers. The timer also compares three preprocessing variants before a full-confidence reading is accepted.

For recorded match testing, enable **Recorded Video Test Mode** in the bridge before starting it. This mode requires repeated readings before accepting a timeline seek or lower score. Leave it disabled for live matches. A captured debug image is a manual frozen snapshot—the age and capture engine are shown above it while OCR continues live. The bridge retains its last trusted state during temporary capture failures and automatically retries the selected window.

## OBS browser sources

Keep the desktop application running during the broadcast. In OBS, add a Browser Source at **1920 × 1080** using one of these local URLs:

```text
http://127.0.0.1:3174/overlays/scoreboard.html
http://127.0.0.1:3174/overlays/map-pool.html
http://127.0.0.1:3174/overlays/roster.html?program=varsity
http://127.0.0.1:3174/overlays/roster.html?program=jv
```

The OBS Outputs page in the app can copy these URLs and open scaled preview windows. Score, map, roster, image, and selected-game changes are pushed to connected overlays immediately.

## Development

Requirements: Node.js 20 or newer on Windows.

```powershell
npm install
npm run dev
```

## Quality checks

```powershell
npm run check
npm test
npm run build
```

## Build the Windows app

```powershell
npm run package
```

Artifacts are generated in `release/`:

- Installable NSIS setup executable
- Standalone portable executable
- `release/bridge/ISU Esports Game Bridge-Portable-...exe` for Rocket League or VALORANT Game PCs

## Project structure

```text
electron/          Electron main, secure preload, telemetry, bridge, and Companion API processes
companion-module/  Native Bitfocus Companion 5 connection module
public/overlays/   Transparent OBS HTML, CSS, JavaScript, and placeholders
src/app.js         Control interface and interactions
src/game-config.js Per-game rules and default data
src/store.js       Local persistence helpers
test/              Foundation data-model tests
```

## Data storage

Control data persists locally in Electron's browser storage. The Electron main process hosts read-only overlay assets and state on `127.0.0.1:3174`, while state changes are sent to OBS pages with server-sent events. Companion settings are stored separately in Electron's application-data directory; its authenticated API binds to the LAN only when explicitly enabled.
