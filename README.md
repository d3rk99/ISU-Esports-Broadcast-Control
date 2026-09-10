# ISU Esports Broadcast Control

A local-first desktop control center for Idaho State Esports broadcasts. This foundation release provides game-aware scorekeeping, match/map planning, and Varsity/JV roster management for:

- Overwatch 2
- VALORANT
- Rocket League
- Smash Bros. Ultimate
- Call of Duty

## Current milestone — v0.4.3

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
- Persistent OBS boost-meter elements with interval-matched animation, eliminating the former 80 ms visual lag
- Rocket League connection details backed up outside browser storage for rebuild and forced-restart recovery
- Optional VALORANT Overwolf Game Events Provider service with standard-Electron fallback
- VALORANT test feed, debug report export, Home/Away team mapping, and broadcast-safe score/map/round/player normalization

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
- **Game PC bridge:** Broadcast Control is on the Graphics PC. Generate a private bridge key, then run the separate ISU Rocket League Bridge executable on the Game PC with the Graphics PC's displayed IPv4 address and matching key.

Player boost is supplied by Rocket League while the game client is spectating. The test-feed button verifies scoring, clocks, players, boost meters, and OBS updates without a live match.

## VALORANT live data

VALORANT live telemetry uses the Overwolf Game Events Provider (GEP). GEP is only available when the app is running under Overwolf Electron; the normal Electron app still runs, but the VALORANT Live Data panel reports **GEP unavailable** until launched through the Overwolf runtime.

Current Overwolf packages in this project:

- `@overwolf/ow-electron`
- `@overwolf/ow-electron-builder`
- `@overwolf/electron-is-overwolf`

Current requested VALORANT GEP features:

```text
gep_internal
me
game_info
match_info
kill
death
```

To test without VALORANT or Overwolf, select **VALORANT -> Match Control** and press **Run Test Feed** in the VALORANT Game Events Provider panel. The simulator drives the same normalized pipeline as real GEP data and exercises match start, round/score changes, player stats, kill feed, spike state, and match end.

To test with actual VALORANT on an Observer PC:

1. Install Overwolf and use an Overwolf Electron build/run path.
2. Launch with `npm run dev:ow` for development. The command uses Overwolf's DEV package endpoint while GEP support is in the development environment.
3. Start VALORANT and open a match or custom observer session.
4. Select **VALORANT -> Match Control**, enable **Live Data**, and confirm the status progresses from waiting/detected to receiving live data.
5. If it fails, press **Copy Debug Report** and send the copied JSON back for the next pass.

Automatic sync currently supports broadcast-safe fields when GEP provides them:

- Current map
- Round number and round phase
- Home/Away round score through the GEP Team 0 mapping control
- Match ID or pseudo match ID
- Observed player in custom/observer mode
- Roster and scoreboard player rows when available
- Kill feed summary and spike planted site/defused/detonated state

Manual controls remain available for series score, veto flow, map winners, rosters, and any field not present in GEP. The integration intentionally does not expose hidden-information tools or live spike countdown timers. VALORANT publication requires Riot and Overwolf approval; private VALORANT apps are not accepted under current Overwolf/Riot guidance.

For production Overwolf distribution, confirm the final Overwolf manifest and game ID from the Observer PC's current `%localappdata%\Overwolf\gamelist*.xml`, then coordinate with Overwolf DevRel to move VALORANT GEP support from DEV to PROD before removing the DEV package endpoint.

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

Use the Overwolf Electron runtime for VALORANT GEP development:

```powershell
npm run dev:ow
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

Optional Overwolf Electron portable build:

```powershell
npm run package:ow
```

Artifacts are generated in `release/`:

- Installable NSIS setup executable
- Standalone portable executable
- `release/bridge/ISU Rocket League Bridge-Portable-...exe` for the Rocket League Game PC

## Project structure

```text
electron/          Electron main and secure preload processes
public/overlays/   Transparent OBS HTML, CSS, JavaScript, and placeholders
src/app.js         Control interface and interactions
src/game-config.js Per-game rules and default data
src/store.js       Local persistence helpers
test/              Foundation data-model and telemetry service tests
```

## Data storage

Control data persists locally in Electron's browser storage. The Electron main process hosts read-only overlay assets and state on `127.0.0.1:3174`, while state changes are sent to OBS pages with server-sent events.
