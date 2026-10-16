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
| VALORANT board reader: align, cells, credits, glyph count, parse, read ladder (native Tesseract, Derk OK'd 2026-10-15) | `electron/valorant-board-parse.cjs`, `valorant-ocr-engine.cjs` | `isu-ocr::board`, `tess` | real frames: 139/140 cells identical to JS, see `bench/RESULTS.md` |
| VALORANT agents / guns / shields, consensus, identity, HUD, capture; Overwatch reader | `electron/valorant-*.cjs`, `overwatch-*.cjs` | todo | |
| Game Bridge, spectate tracker | `electron/game-bridge.cjs`, `spectate-*` | todo | |
| Display Client + Display Manager | `electron/displays/` | todo | |
| Rocket League Stats API | `electron/rocket-league-*.cjs` | todo | |
| Restream | already Rust (`../restream`) | — | |

## Building isu-ocr
Needs Tesseract 5 (C library). Linux: the distro package. Windows: `vcpkg install tesseract:x64-windows`,
then `set TESSERACT_LIB_DIR=<vcpkg>\installed\x64-windows\lib` before `cargo build` and copy its DLLs next to the exe.

## Commands
```
cd rust
cargo test                                   # parity tests (need node for the config check)
node scripts/export-game-config.mjs          # after editing src/game-config.js
node scripts/parity-cases.mjs                # after changing the JS logic: regenerate the cases
```
