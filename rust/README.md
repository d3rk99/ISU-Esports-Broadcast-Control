# ISU Broadcast suite in Rust (branch `rust-rewrite`)

Derk 2026-10-15: rewrite the Broadcast Control controller, the Game Bridge, the Display Client and
Restream in Rust with the same features, abilities and logic, to measure whether it is faster.
`main` keeps the Electron/Node apps; this branch adds the Rust versions next to them.

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
| Overlay server (HTTP, SSE, WebSocket), Companion API server | `electron/main.cjs`, `overlay-events.cjs`, `companion-api-service.cjs` | todo | |
| Controller UI | `src/app.js` + panels | todo | |
| Game Bridge, OCR readers, spectate tracker | `electron/game-bridge.cjs`, `*-ocr-*`, `spectate-*` | todo | |
| Display Client + Display Manager | `electron/displays/` | todo | |
| Rocket League Stats API | `electron/rocket-league-*.cjs` | todo | |
| Restream | already Rust (`../restream`) | — | |

## Commands
```
cd rust
cargo test                                   # parity tests (need node for the config check)
node scripts/export-game-config.mjs          # after editing src/game-config.js
node scripts/parity-cases.mjs                # after changing the JS logic: regenerate the cases
```
