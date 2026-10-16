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

## Live verification after pulling `49991e1`

The user supplied a playing VALORANT recording because a ten-player custom match was impractical. Checks below use the native Rust apps; browser inspection was excluded at the user's request.

| Item | Result and evidence |
| --- | --- |
| VALORANT window capture / normalization | PASS on the recording's `VALORANT` window. `live_board` read 98/100 cells, round score 4–0, names, agents, weapons and shields. Native controller rows updated through the recording. Capture normalizes to 1920×1080; a 2560×1392 non-16:9 source was rejected. This does not establish capture compatibility with the actual VALORANT executable / anti-cheat. |
| Game Bridge spectate | PASS for portrait recognition and transport: native UI showed CWTJ and newx, and overlay state received SnOwfal and Eagl3. The name-bar path remains covered by parity fixtures; independent live name-only recognition was not established. Found and fixed Companion freshness and controller repaint wiring below. |
| Overwatch reader | PASS for real scoreboard reading in the earlier session (82/90 and 77/80 cells, names and heroes). In this follow-up Overwatch was on a menu, so DEBUG CAPTURE correctly showed that menu and rejected most cells. Debug frame, ROIs and cell crops rendered and controller input remained responsive. Found and fixed debug-card layout below. |
| NDI `ISU Stage 03` | PASS: station 3 received the OBS+DistroAV feed and displayed it full screen. The audience window occupied stageDisplay 2, the right monitor at (2560,184), 1920×1080. Six alternating NDI/mirror transitions stayed alive and online after the DLL lifetime fix. |
| NDI ABI | PASS: compiled MSVC static assertions against NDI 6 headers for Source, FindCreate, RecvCreateV3 and VideoFrameV2 size/offsets. Rust ABI test also passes. |
| GAME MIRROR | PASS: controller switched station 3 to mirror; the selected player monitor appeared full screen on the right audience monitor. NDI/mirror transitions stop and restart capture successfully. |
| Monitor order / cursor lock | PASS: shared y/x ordering gives primary 1, right 2, left 3. Ctrl+Alt+L with the controller focused toggled cursor clipping to [2,2,2558,1438], the inset of player display 1. Toggle off and app exit restored the unconstrained desktop rectangle [-1920,0,4480,1440]. Ctrl+Alt+S opened client settings. Hotkeys while the actual game has focus remain unverified. |
| Start with Windows | PASS: enabling and saving created HKCU Run `ISU Display Client` with the release executable and `--startup`; disabling removed it. Left disabled. A Windows login/reboot was not performed. |
| Pink noise | PASS on `Speakers (Realtek USB Audio)`: controller volume changed from 20% to 40%, then off, under a 10% client cap. Client reported playback without an audio error. User explicitly confirmed audible noise and level change. |
| Program fill/key | PASS: OPEN PROGRAM created full-screen fill at (-1920,196) and key at (2560,184), both 1920×1080, matching Settings. Scoreboard → Roster → Map Pool changed both inner documents while native handles and parent program documents persisted. |
| Game alignment overlay | PASS: native transparent overlay occupied 2560×1440 at (0,0); underlying video/windows remained visible. Controller navigation worked while it was open. Creation requests always-on-top and ignore-cursor-events; overlay remained visible above underlying windows. Toggled closed afterward. |
| Settings monitors | PASS: all three physical screens, dimensions and positions appeared in the native selection controls. |
| Native image dialogs | PASS: team-logo and player-portrait pickers opened, accepted a local PNG, updated the native field, and served each imported user asset with HTTP 200. Original values restored with Undo. |
| Companion / overlay server | PASS: authenticated Companion variables/actions on 3176 and overlay state/assets on 3174. Native WebView2 program outputs rendered live state. OBS browser-source rendering was not inspected, per the user's browser exclusion. |
| Release GUI console behavior | PASS: all three egui applications have the Windows GUI subsystem and opened without an extra app console. |

Additional fixes from this follow-up:

| Commit | Fix |
| --- | --- |
| `475042b` | Retain the initialized NDI DLL for the process lifetime. Unloading it during receiver/mode changes crashed a remaining runtime thread. |
| `1e12378` | Pass raw spectate `receivedAt` to Companion freshness checks; the overlay projection intentionally omits it. Added fresh/expired real-HTTP assertions. |
| `43ecdcc` | Request a controller repaint on spectate link/status/player changes. |
| `a462695` | Stack each Overwatch debug cell's label, images and OCR result vertically instead of inheriting the wrapping row layout. |

Outstanding live coverage: actual VALORANT process capture, name-only spectate recognition, shortcuts with a game focused, Windows login startup, and OBS browser-source rendering. These are coverage limits, not confirmed failures.

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

Previous nonfatal build warning (resolved upstream in `49991e1`; latest release build has no warnings):

```text
warning: variable does not need to be mutable
  --> crates\isu-display\src\mirror.rs:55:17
```

`npm install` succeeded with an engine warning: `@screen-capture/node@1.1.0` requires `>=23.5.0 || ^22.13.0 || ^20.17.0`, while the installed Node is `v22.12.0`. npm also reported 21 vulnerabilities (10 moderate, 9 high, 2 critical); dependencies were not changed to address them.

Follow-up live errors:

```text
Faulting module name: Processing.NDI.Lib.x64.dll_unloaded, version: 6.3.2.0
Exception code: 0xc0000005
Fault offset: 0x0000000000403b96
```

Observed when saving Display Client settings / restarting its receiver; resolved by `475042b` and not reproduced over six NDI/mirror transitions.

```text
Windows Graphics Capture timed out waiting for “VALORANT”
```

Intermittently observed with the recording source; subsequent moving frames resumed reading. A paused source can exceed the capture freshness timeout. No relaxation of the size/freshness checks was made.
