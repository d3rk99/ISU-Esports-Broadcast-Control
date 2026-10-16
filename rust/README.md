# ISU Broadcast suite in Rust (branch `rust-rewrite`)

Derk 2026-10-15: rewrite the Broadcast Control controller, the Game Bridge, the Display Client and
Restream in Rust with the same features, abilities and logic, to measure whether it is faster.
`main` keeps the Electron/Node apps; this branch adds the Rust versions next to them.
Screens are native Rust (egui, like Restream), Derk 2026-10-15 ("2"). The OBS overlay and stage
pages stay HTML (OBS browser sources need web pages); the Rust server serves the same files.

## Rules for the port
- **Same behaviour, proven.** Every ported piece is checked against the real JS code: a script
  runs the JS on a set of cases (`scripts/parity-cases.mjs`) and a Rust test runs the same cases
  and must produce the identical JSON (`crates/isu-core/tests/parity.rs`).
- **Same data.** The controller state stays the same JSON document, so saved state, overlays
  (the HTML pages in `public/`) and the Companion module keep working unchanged.
- **One source of truth.** Game tables come from `src/game-config.js` through
  `scripts/export-game-config.mjs` (test fails when it is stale), never a hand copy.

## Status
| Part | JS source | Rust | Parity |
| --- | --- | --- | --- |
| Companion actions (score, maps, swap, veto, bans, stat cards, display presets, last-game stats) | `src/companion-actions.js` | `isu-core::actions` | 294 cases + a 7-step series chain |
| Companion variables + capabilities, stage variables | `electron/companion-api-service.cjs` | `isu-core::variables` | all states |
| Gamertag folding / similarity | `src/overwatch-ocr-panel.js` | `isu-core::tags` | 10 pairs |
| Display presets | `src/display-presets.js` | `isu-core::display_presets` | via actions |
| Overlay server 3174 (/api/state, /api/health, SSE /events, WebSocket /ws, static pages, user assets, RL pack) | `electron/main.cjs`, `overlay-events.cjs` | `isu-server::overlay`, `hub`, `store` | socket tests + the real `public/overlays/scoreboard.html` in Chromium: WS connected, live update shown |
| Companion API 3176 (health, variables, capabilities, state, SSE events, action) | `electron/companion-api-service.cjs` | `isu-server::companion` | socket tests (keys, errors, CORS, restart/free port) |
| Controller UI (native egui, Derk chose option 2: everything in Rust) | `src/app.js` + panels | todo | |
| VALORANT board reader: align, cells, credits, glyph count, parse, read ladder (native Tesseract, Derk OK'd 2026-10-15) | `electron/valorant-board-parse.cjs`, `valorant-ocr-engine.cjs` | `isu-ocr::board`, `tess` | real frames: 139/140 cells identical to JS; Windows 7900X: 2.0-2.8x faster, 6.5x less RAM (`bench/RESULTS.md`) |
| VALORANT agents, guns, shields, block colours, consensus, player identity (rows re-sort) | `valorant-board-parse.cjs`, `valorant-board-identity.cjs` | `isu-ocr::icons`, `consensus`, `board::block_color` | real frames + scripted sweeps: identical to JS (`tests/parity_board.rs`) |
| VALORANT top HUD (round score, timer, spike) | `valorant-hud-reader.cjs` | `isu-ocr::hud` | 154 real images identical to JS (`tests/parity_hud.rs`) |
| Window capture: Windows Graphics Capture, size check, normalise to 1080p | `valorant-native-capture.cjs`, `valorant-capture.cjs` | `isu-ocr::capture` (windows-capture crate) | unit tests; live test on Windows: `--example live_board` |
| VALORANT board service (sweep loop, HUD votes, workers, names, known names, colours) | `valorant-board-service.cjs` | `isu-ocr::service` | real board through 3 sweeps: agents, K/D/A, guns, shields, colours right (`tests/service.rs`) |
| Overwatch reader: header bar, perks / player view, align, cells, ult ring + READY disc, heroes, consensus, service | `overwatch-ocr-parse.cjs`, `overwatch-hero-match.cjs`, `overwatch-ocr-service.cjs` | `isu-ocr::overwatch`, `ow_service` | 3 real boards: boxes + OCR images identical, 20/20 heroes, 79/80 stats (1 blank, traced); 108 vs 167 ms |
| Spectate tracker: name-bar cleanups, fuzzy match, portrait (agent + red/teal), camera vote, RL Stats API target | `spectate-tracker.cjs`, `valorant-portrait-match.cjs` | `isu-ocr::spectate` | 62 real name bars (exact images), 12 POV / broadcast frames, vote + RL cases: identical (`tests/parity_spectate.rs`) |
| Bridge link (key check, keepalive), spectate receiver (3175), spectate candidates / sides / resolve | `bridge-link.cjs`, `spectate-receiver.cjs`, `spectate-state.cjs` | `isu-net::link`, `spectate` | JS parity on 7 states; real sockets: key 1008, candidates push, spectated packets, port freed |
| Rocket League Stats API: local WebSocket 49124 / TCP 49123 fallback, bridge receiver, watchdog, throttle, simulator | `rocket-league-service.cjs` | `isu-net::rocket_league` | settings / stream parser / envelopes / full simulator run identical to JS; real sockets: bridge + split TCP stream |
| Game Bridge logic (settings, link to the Graphics PC, RL forwarding, portrait + name spectate loops) | `game-bridge.cjs` | `isu-net::bridge` | settings parity; real sockets: Rust bridge -> Rust Graphics PC receives the RL simulator; wrong key = waiting |
| Game Bridge app (window, config file + legacy fallback) | `bridge-main.cjs`, `bridge/index.html` | `isu-bridge` (egui) -> `isu-game-bridge` | form tests; renders on a virtual screen (RL + VALORANT modes checked by OCR of the screenshot) |
| Display Manager (3178 /display: hello/status/welcome/mode/noise, key 4003, station in use 4009, groups, pink-noise toggle by majority) | `displays/display-manager.cjs` | `isu-net::displays` | test/display-manager.test.cjs ported 1:1 (real sockets): all pass; plain HTTP 426 |
| Display Client app (config + CLI args, link with backoff, NDI receiver via the NDI runtime DLL, game mirror, pink noise, cursor lock, start with Windows, settings, crash log) | `displays/display-client-main.cjs`, `ndi-receiver.cjs`, `cursor-lock.cjs`, `client/*` | `isu-display` -> `isu-display-client` | pink noise sample-for-sample = noise.js; normalize = JS; real client <-> real manager on a virtual screen (mode / noise / status round trip, STATION 03 screen) |
| OBS setup for the stage displays (obs-websocket 5: auth, 10 scenes + browser pages + DistroAV NDI filters, idempotent, live status) | `displays/obs-displays.cjs` | `isu-net::obs` | test/obs-displays.test.cjs ported, run against the SAME fake OBS server (rust/scripts/fake-obs.cjs) |
| Rocket League Stats API | `electron/rocket-league-*.cjs` | todo | |
| Restream | already Rust (`../restream`) | — | |

## Building isu-ocr
Needs Tesseract 5 (C library). Linux: the distro package. Windows: `vcpkg install tesseract:x64-windows`,
then `set TESSERACT_LIB_DIR=<vcpkg>\installed\x64-windows\lib` before `cargo build` and copy its DLLs next to the exe.

## OCR input (one known difference from the live Electron app)
The cell images Rust gives Tesseract are the ones the JS accuracy tests build (`cellImage` in
test/valorant-board-fixtures.cjs and test/overwatch-ocr.test.cjs): bilinear upscale, threshold,
white border. The Electron live path makes them with Electron's own `nativeImage.resize('best')`,
which can't be reproduced bit for bit outside Electron. Both are validated on Derk's real frames.

## Running the apps
```
cargo run --release -p isu-bridge          # ISU Esports Game Bridge (Game PC)
cargo run --release -p isu-display -- --station=3 --controller=192.168.1.20   # ISU Display Client (station PC)
```
Linux virtual screen for testing: `Xvfb :97 -extension GLX` (Xvfb with GLX crashes in the sandbox).

## NDI runtime
The Display Client loads the NDI runtime at start like the Electron build: `Processing.NDI.Lib.x64.dll`
next to the exe (or NDI_RUNTIME_DIR_V6 / V5, or the NDI Runtime installer). Missing = the screen says so.

## Commands
```
cd rust
cargo test                                   # parity tests (need node for the config check)
node scripts/export-game-config.mjs          # after editing src/game-config.js
node scripts/parity-cases.mjs                # after changing the JS logic: regenerate the cases
```
