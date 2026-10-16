# Codex: pull and run the Rust apps unpackaged (dev build) for a UI test

Work in the ISU-Esports-Broadcast-Control repo on this Windows PC. Do not package, do not install.

1. `git fetch` + `git checkout rust-rewrite` + `git pull`. Report the commit id (newest should be the UI pass, 6ca0a34 or later).
2. Close any running copy of the Electron controller / Display Client / Game Bridge and the Rust ones
   (ports 3174, 3175, 3176, 3178 must be free).
3. In the repo root: `npm install` (the apps read the OCR English model from node_modules).
4. `cd rust`, set `TESSERACT_LIB_DIR=C:\vcpkg\installed\x64-windows\lib` (as before), then
   `cargo build --release -p isu-control -p isu-outputs -p isu-bridge -p isu-display`.
5. Copy next to the exes in `rust\target\release\`: the Tesseract/Leptonica DLLs from
   `C:\vcpkg\installed\x64-windows\bin`, and `Processing.NDI.Lib.x64.dll` from the NDI 6 Runtime
   (same as the earlier validation). Fix anything missing until all three start.
6. Start them from `rust\target\release\` (dev build: they find public/, electron/ and node_modules/
   in the repo by themselves):
   - `isu-broadcast-control.exe` (controller)
   - `isu-game-bridge.exe` (Game Bridge)
   - `isu-display-client.exe --station=3 --controller=127.0.0.1` (Display Client, Ctrl+Alt+S = settings)
7. Leave all three running for Derk to click through. Report: commit id, build OK, which exes are
   running, any error dialogs or log lines. Do NOT change code unless something fails to build or
   start; if it does, report the exact error first.
