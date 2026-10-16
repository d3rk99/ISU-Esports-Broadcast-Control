# Code audit (2026-10-16) — bugs, bad code, unused/redundant features

Severity: **BUG** = wrong behaviour, **RISK** = can break in some situation, **CLEANUP** = unused/redundant/bad code, **UX** = confusing for a new operator.

## Controller core (crates/isu-control/src/core.rs)
- **FIXED** `js_string(x).replace("null", "")` (spectated name, roster tags for the reader): meant to blank a JSON null,
  but it also cuts "null" out of real names ("Nullify" -> "ify", "Annulled" -> "Aned"). Fixed: `game_config::text()`.
- **FIXED** Undo restored a full state snapshot. Live data written since then (Rocket League clock/players/goals, reader
  scores, round history, roster autofill) is thrown away too, so pressing Undo mid-game could roll back the live data. Fixed: Undo keeps live-feed parts (test `undo_keeps_live_feed_data`).
- **FIXED** The VALORANT reader never got the roster gamertags as hints. `Core::valorant_board_snapshot` builds them
  (app.js publishValorantBoard -> setValorantBoardKnownNames) but nothing calls `BoardService::set_known_names`, so
  misread names are not snapped to the roster like in Electron. Fixed: services.rs `send_known_names`.
- **FIXED** Display Client: an NDI source named with "null" in it loses those letters (same replace("null") bug, main.rs:252).

## Features that do nothing / are redundant
- **CLEANUP** **Take live / Off air** (Match Control button, topbar LIVE pill, Companion `match.live.toggle/set`,
  variable): `match.live` only switches the small "PREVIEW/LIVE" tag inside the *generic* scoreboard. Every game
  (VALORANT, Overwatch, Rocket League, Smash) hides that scoreboard and draws its own HUD; Call of Duty is the only one that
  shows it, and there it only changes a 9 px tag. It does not start, stop or hide anything. Derk: "it does literally nothing".
- **CLEANUP** **"Auto roster & cars"** (Rocket League automation): the "cars" half needs the car render lab, which is not
  ported (Derk skipped it). The core still computes car render jobs and they are thrown away. Rename to "Auto roster",
  drop the render jobs.
- **CLEANUP** **"Growing round bar"** (`valorantGrowingRounds`): the overlay still supports it but neither app has a switch
  any more, so it can only be changed by editing the saved state. Either give it a switch or drop it (decision for Derk).
- **CLEANUP** `Core::rl_event` returns render jobs nobody reads; `ui/widgets.rs` is only a re-export now; `widgets::grid`
  is unused (replaced by `cols`).

## Network (crates/isu-net)
- **FIXED (RISK)** The accept loops of the Display Manager (3178), spectate receiver (3175) and Rocket League bridge
  receiver did `continue` on an accept error with no pause: a persistent error (out of sockets) spins a CPU core at 100%.
  Now waits 50 ms.
- **RISK (same as Electron)** Station mode (mirror/NDI) and pink-noise on/off/volume live only in memory: restarting the
  controller puts every station back to NDI + noise off. Electron does the same. Worth keeping across restarts (UX).
- **FIXED (RISK)** Game Bridge: a malformed `spectate-candidates` message from the controller would panic (unwrap) the link task.
- **FIXED (RISK)** Display Client: a NUL character in "OBS PC for NDI" would panic the NDI thread (CString unwrap).

## Apps
- **FIXED (BUG)** No single-instance lock in any Rust app (Electron has one). A second controller started the window but
  could not open 3174/3176/3178; a second Display Client fought the first over the station ("Replaced" loop); two Game
  Bridges sent double data. Now: OS file lock per app (`isu_ui::single_instance`); the controller shows "already running".
