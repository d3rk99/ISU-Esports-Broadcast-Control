You are working in the ISU-Esports-Broadcast-Control repo, branch `rust-rewrite`, folder `rust/`
(a Cargo workspace). It is a Rust port of the Electron apps in `electron/` + `src/`. Everything was
built and tested on Linux; the Windows-only code has NEVER been compiled. Your job: make it build,
run and work on this Windows PC. Read `rust/README.md` first.

Rules
- Same behaviour as the Electron app. The JS is the reference: when unsure, read the matching
  file (the README status table maps every Rust module to its JS source).
- Fix code, never weaken or delete tests. Don't touch `electron/`, `src/` or `public/`.
- Small commits with clear messages, one per fixed problem. Push to `rust-rewrite`.
- At the end write `rust/docs/windows-results.md`: what worked, what you fixed, what still fails
  (with the exact error).

1. Build
- Install Tesseract 5: `vcpkg install tesseract:x64-windows`, set `TESSERACT_LIB_DIR` to its
  `installed\x64-windows\lib` (check the .lib name; set `TESSERACT_LIB_NAME` if it isn't tesseract55).
- `cd rust && cargo build --release --workspace`. Fix every compile error in the Windows-only code:
  `crates/isu-display/src/mirror.rs` (windows mod, windows-capture 2.0.1), `crates/isu-display/src/cursor.rs`
  (ClipCursor / EnumDisplayMonitors), `crates/isu-ocr/src/capture.rs` (WgcSource), and anything under
  `#[cfg(windows)]`. Check the windows-capture 2.0.1 API on docs.rs, don't guess.
- Copy the Tesseract DLLs next to the exes. `cargo test --workspace -- --test-threads=1` must pass
  (needs `node` and `npm install` in the repo root for the parity scripts).

2. Window capture (Windows Graphics Capture)
- Open VALORANT or Overwatch (or any window), run `cargo run --release -p isu-ocr --example live_board`
  and the controller's TEST READ / DEBUG CAPTURE (Match Control, VALORANT / Overwatch). Frames must
  arrive, be normalised to 1920x1080, and the size check must give a clear error for non-16:9 windows.
- Game Bridge (`isu-game-bridge`): VALORANT spectate mode must read name bars / portraits from the window.

3. Display Client (`isu-display-client`)
- NDI: put `Processing.NDI.Lib.x64.dll` (NDI 6 runtime) next to the exe. With OBS + DistroAV sending
  "ISU Stage 03", run `isu-display-client --station=3 --controller=127.0.0.1` with the controller
  open: the feed must show full screen. Check the struct layouts in `crates/isu-display/src/ndi.rs`
  against the NDI 6 SDK headers (Processing.NDI.Find.h / Recv.h / structs.h).
- Game mirror: set the station to GAME MIRROR from the controller's Displays page; the player monitor
  must show.
- Cursor lock (Ctrl+Alt+L / settings) keeps the mouse on the player monitor; unlocks on exit.
- Start with Windows: the HKCU Run entry appears / disappears with the setting.
- Pink noise plays on the picked headset output, fades in/out, volume follows the controller.

4. Output windows (`isu-outputs`, wry + WebView2)
- With the controller running, OBS Outputs -> OPEN PROGRAM: fill and key windows full screen on the
  screens picked in Settings (Direct output displays). Taking Scoreboard / Roster / Map Pool switches
  both without reloading. TOGGLE GAME OVERLAY: transparent, always on top, click-through, toggles off.
- Settings -> output screen lists must show the real monitors (ids from `isu-outputs` "monitors").

5. Controller sanity on Windows
- `isu-broadcast-control`: Companion API (Settings) answers on 3176; overlay pages on 3174 work in
  OBS browser sources; file dialogs (team logo, portraits) open and the picked image shows on the overlay.
- Release builds of the egui apps must not open a console window.

Report back with `rust/docs/windows-results.md` and the commit list.
