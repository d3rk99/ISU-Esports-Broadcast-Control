# Windows validation results — 2026-10-16

Branch: `rust-rewrite`. Windows PC: Ryzen 9 7900X, Rust 1.99.1 MSVC, Node 22.12.0, vcpkg Tesseract 5.5.3 (`tesseract55.lib`).

## Build and automated checks

- `cargo build --release --workspace`: passed, including all Windows-only capture, cursor, and output-window code. No Windows compile errors were found in the initial build.
- `cargo test --workspace -- --test-threads=1`: passed, exit 0, after the fixes below and closing live clients/controllers that occupied the test ports. No tests were deleted, skipped, or weakened.
- Tesseract dependency DLLs and `Processing.NDI.Lib.x64.dll` from the installed NDI 6 Runtime were copied beside the release executables. Tesseract DLLs were also copied beside `live_board.exe`.
- windows-capture 2.0.1 settings, FrameBuffer access and CaptureControl API were checked against docs.rs and the downloaded crate source.
- Full test log on this PC: `%TEMP%\isu-windows-tests-exclusive.log`; final build log: `%TEMP%\isu-windows-build-final.log`.

## Fixes pushed

| Commit | Fix |
| --- | --- |
| `4a81da4` | Join the cursor clipping worker before releasing ClipCursor, and release it on Drop. Avoid zero-index underflow. |
| `999c756` | Add `ISU_BRIDGE_USER_DATA` and isolate the bridge config test from the Linux-only XDG assumption. The config-location and loaded-value assertions remain covered. |
| `9829037` | Register Ctrl+Alt+S / Ctrl+Alt+L as Windows global hotkeys on a dedicated message thread; unregister on exit. |
| `15a7124` | Invoke the controller's repaint callback after releasing its registration mutex. The previous callback path could invert locks between egui and OCR threads. Added regression coverage for both UI commits and Overwatch snapshot repaints. |
| `7e0939a` | Consume peeked plain HTTP request data and shut down the writer before closing a Display Manager socket. Prevents Windows resets truncating the 426 reply. |

## Live checks observed

- `live_board Overwatch 5` successfully captured the real Overwatch window. Because this example is the VALORANT reader, its expected status on the Overwatch scoreboard was `Window found but no scoreboard visible (is Tab open on Observer 3?)`.
- The controller's real Overwatch reader received names and heroes (including Bastion, Symmetra, Baptiste, Brigitte, Reinhardt; later Sojourn, Ashe, Kiriko, Lúcio, Ramattra), and reported reading 82/90 and later 77/80 cells.
- The original controller became unresponsive while its HTTP server continued to answer. Windows reported `Responding: False`. No panic or stderr error was produced. The repaint callback mutex was held while entering egui, allowing a UI/worker lock inversion. After the fix, the restarted controller was observed responding with live OCR updates. The native GUI regression test also passed DEBUG CAPTURE, HIDE DEBUG, repeated TEST READ, view switching and service actions.
- The final rebuilt controller was reopened and Windows reported `Responding: True`. It uses the isolated validation data folder `%TEMP%\isu-windows-controller`; the scoreboard reader setting there was off at the final check.
- Overlay API on 3174 answered HTTP 200 while checking the original freeze. Companion API and overlay routes also passed the real-socket workspace tests.
- `isu-outputs` monitor command listed all three actual monitors: 2560x1440 at (0,0), 1920x1080 at (-1920,196), and 1920x1080 at (2560,184), all scale 1.0.
- All three egui entry points already have the Windows GUI subsystem attribute for release builds. Native apps opened without an additional app console.

## Remaining live verification

The following are **not yet verified**, rather than confirmed passes:

- A real VALORANT game capture and Game Bridge name-bar / portrait tracking. Only Overwatch was open.
- Native controller DEBUG CAPTURE rendering and repeated interactions after the repaint fix (automated fixture-backed GUI coverage passed; native input was interrupted / overlapped with user interaction).
- NDI `ISU Stage 03` reception/full-screen rendering from OBS+DistroAV. The runtime DLL is installed and copied. FindCreate, RecvCreateV3 and VideoFrameV2 fields were inspected against SDK headers distributed in DistroAV, but a compiled ABI comparison and real feed check remain.
- GAME MIRROR, audience-monitor placement, physical cursor confinement and hotkey operation while a game has focus, Run-key appearance/removal, and audible pink-noise fades/volume on Realtek USB Audio.
- Program fill/key monitor placement and live switching, transparent always-on-top click-through game overlay, OBS browser-source rendering, and native team-logo/portrait file dialogs.

The Display Client was stopped to free station 3 during tests. Its `stageDisplay` setting is not currently applied to native window placement; that runtime gap remains to be fixed. Mirror monitor ordering and capture lifetime need further live review.

## Exact errors encountered and resolved

Initial bridge test failure:

```text
thread 'tests::config_read_from_xdg' panicked at crates\isu-bridge\src\main.rs:451:9:
assertion `left == right` failed
  left: "C:\\Users\\13der\\AppData\\Roaming"
 right: "C:\\Users\\13der\\AppData\\Local\\Temp\\isu-bridge-cfg-25552"
```

A live station-3 Display Client competed with the GUI test's station-3 socket:

```text
thread 'controller_window_like_a_user' panicked at crates\isu-control\tests\ui.rs:101:80:
called `Option::unwrap()` on a `None` value
```

Display Manager truncated HTTP reply before the socket fix:

```text
thread 'plain_http_gets_426' panicked at crates\isu-net\tests\displays.rs:107:5:
HTTP/1.1 426 Upgrade Required
C
```

The controller was reopened during one test run, occupying its required port:

```text
Port 3174 is unavailable. Close any other copy of ISU Esports Broadcast Control and reopen the app.

Only one usage of each socket address (protocol/network address/port) is normally permitted. (os error 10048)
```

The exclusive-port run subsequently passed in full.

Remaining nonfatal build warning:

```text
warning: variable does not need to be mutable
  --> crates\isu-display\src\mirror.rs:55:17
```

`npm install` succeeded with an engine warning: `@screen-capture/node@1.1.0` requires `>=23.5.0 || ^22.13.0 || ^20.17.0`, while the installed Node is `v22.12.0`. npm also reported 21 vulnerabilities (10 moderate, 9 high, 2 critical); dependencies were not changed to address them.
