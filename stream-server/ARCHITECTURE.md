# ISU Stream Server — architecture (real engine, v0.2.0)

Standalone Director-PC Electron app. Separate executable, config, logs, ports and lifecycle from the
Broadcast Controller. Two engines, selected explicitly in Settings (`config.engine`):

- **real** (default): FFmpeg capture → ONE H.264/AAC encode → disk delay buffer → stream-copy
  fan-out to any number of RTMP/RTMPS destinations.
- **simulation**: the original Codex scaffold (`core/sim-service.cjs`), clearly badged
  "SIMULATION • NO MEDIA SENT". It is never used as a fallback: if the real engine can't start
  (no FFmpeg, NVENC missing, disk full) the UI shows the error and outputs stay locked.

## Pipeline

```text
input (test pattern / file / DeckLink SDI)
  └─ ProgramEncoder: ONE ffmpeg process — capture + H.264 (NVENC or x264) + AAC → MPEG-TS on stdout
       └─ DelayBuffer: TS split into keyframe-aligned chunks (≈2.5 s) on local disk
            └─ release: a chunk leaves only when its LAST byte is ≥ delay old (monotonic clock)
                 └─ fan-out: the same released bytes go to every Destination
                      ├─ Destination 1: ffmpeg -c copy → FLV → rtmp(s)://… (no encoding)
                      ├─ Destination 2: ffmpeg -c copy → …
                      └─ Destination N
```

Raw frames never enter Node/Electron: the encoder process owns capture. Node only moves encoded
188-byte TS packets (stdout → disk → stdin of each destination process).

| File | Role |
| --- | --- |
| `core/media/ffmpeg.cjs` | Find FFmpeg (setting → `ISU_FFMPEG` → `resources/ffmpeg` → `vendor/ffmpeg` → PATH) and probe capabilities: libx264, h264_nvenc (proven with a test encode), aac, rtmp/rtmps, decklink |
| `core/media/sources.cjs` | Input → FFmpeg args. Test source = `testsrc2` with a burnt-in clock + frame number and a 1 kHz tone beeping once a second (A/V sync marker). 59.94 → `60000/1001` (rational, no drift) |
| `core/media/encoder.cjs` | The single program encoder. 2 s GOP, closed, no B-frames, CBR, IDR keyframes, `-progress` stats (frames, fps, drops, speed); measured bitrate from bytes actually produced |
| `core/media/ts.cjs` | MPEG-TS reader: PAT/PMT, video/audio PIDs, keyframes (random_access_indicator), PTS, continuity errors. Never modifies media |
| `core/media/delay.cjs` | The delay buffer (below) |
| `core/media/output.cjs` | One destination: bounded queue, stream-copy FFmpeg, retry/backoff, key redaction |
| `core/media/engine.cjs` | Wires it together; the interlock lives at the byte boundary |
| `core/service.cjs` | Command facade used by the UI (and the future API); picks the engine |

## The delay (safety boundary)

- Every chunk starts with PAT/PMT + a video keyframe, so any chunk is a clean join point.
- A chunk is released only when `now - chunk.lastByteArrival ≥ delaySeconds` on
  `performance.now()` (monotonic; unaffected by wall-clock changes). Because the check uses the
  chunk's **last** byte, nothing inside a chunk is ever younger than the delay. Measured result:
  first released chunk age = 10.10 s at a 10 s delay, 5.00 s at 5 s (always ≥ delay; the extra is
  the 100 ms release tick).
- **Ready** = the current epoch has already released one full chunk that contains both audio and
  video. Elapsed time alone never makes it ready.
- **Epochs:** starting the program, Reset buffer, input/encoder/delay changes and encoder crashes
  all start a new epoch. All older chunks are discarded and can never be released afterwards.
- Destinations only receive chunks from the release path of the current epoch; there is no code
  path from the encoder to a destination. Start/StartAll check readiness, and the release path
  re-checks the epoch, so a start that races a reset still can't send anything early.
- **Storage:** `%APPDATA%/ISU Stream Server/delay-buffer/epoch-N/*.ts` (or the folder set in
  Advanced). Before encoding, a preflight checks free space ≥ (video+audio kbps) × (1.25 × delay +
  10 s) with TS overhead. At 6000+160 kbps a 300 s delay needs about 0.3 GB, 600 s about 0.6 GB.
  Released chunks are deleted right away, so disk use is roughly one delay's worth.
- **Cleanup:** the folder holds an `.isu-stream-delay` owner marker. The app only deletes
  `epoch-*` folders inside a marked folder, never arbitrary paths. Leftovers from a crash are
  deleted at startup and never trusted as ready.
- **Failure = fail closed:** a disk write/read error or an unexpected encoder exit stops every
  output, discards the buffer and shows the error. Nothing live is ever sent to keep a connection up.
- Increasing or decreasing the delay = stop outputs + new epoch + refill (simple and safe).
- Delay range is 0–86400 s. Zero delay still waits for a complete keyframe chunk.

## Destinations

- Generic RTMP/RTMPS (server URL + stream key). No platform-specific code.
- Each destination is its own `ffmpeg -f mpegts -i pipe:0 -c copy -f flv <url>` process, so muxing
  happens once per destination but **encoding happens once in total**. Test evidence: every
  destination records the encoder instance id it was fed from; 3 outputs all report instance 1.
- Bounded queue of 64 MB per destination. If a destination can't keep up, its queue is dropped and
  it rejoins on the next delayed keyframe chunk. The other destinations are unaffected, RAM stays
  bounded, and it never jumps to the live edge.
- Reconnect: exponential backoff 1, 2, 4, 8, 15, 30 s (capped), counted per destination. Stop and
  disable cancel pending retries.
- CONNECTED = FFmpeg is still alive 3 s after taking media.
- **Keys** are encrypted with Windows DPAPI (Electron `safeStorage`) in `config.json`, decrypted
  only when connecting, never in status/IPC/logs. Errors are redacted. Known local exposure: FFmpeg
  takes the publish URL as a command-line argument, so another process running as the same Windows
  user could read the key while streaming.

## Config

`config.json` schema v2 (`engine`, `ffmpegPath`, `storageDir`, `input.type/file/device/formatCode`
added). v1 files are migrated to v2 with `engine: 'simulation'` (so an old setup doesn't
unexpectedly start encoding), and the original is kept as `config.json.v1.bak`. Corrupt or unknown
config fails startup without being overwritten. Destination-only edits don't touch the buffer;
input/encoder/delay edits stop outputs and refill.

## Tests and evidence (2026-10-01, Linux dev box: Ryzen + RTX 5090, FFmpeg n9.0.2)

| Check | Command | Result |
| --- | --- | --- |
| Unit: interlock, migration, missing FFmpeg = error not simulation, delay never early (fake clock), reset discards epoch, disk preflight, key redaction, 59.94 rational | `npm test` | 10/10 pass |
| Real media, x264, 10 s delay, 3 outputs → 3 local RTMP receivers | `npm run test:media` | PASS: first chunk released at 10.10 s age, receivers decoded h264 720p @ 60000/1001 + aac, all 3 fed by encoder instance 1 |
| Real media, NVENC, 5 s delay, 3 outputs | `MODE=hardware node test/media/pipeline.e2e.cjs 5 3` | PASS: h264_nvenc, 0 dropped frames |
| Real media, NVENC, **300 s** delay, 3 outputs (real time, no fast clock) | `npm run test:media:300` | PASS: ready after 305.6 s, first released chunk age **300.054 s**, receivers first got media 313.8 s after encode start, 19,270 frames, 0 dropped, all fed by encoder instance 1 |
| Isolation: kill one receiver mid-stream | `node test/media/isolation.e2e.cjs` | PASS: the other output kept receiving (+3.4 MB, stayed CONNECTED), the dead one went ERROR → RECONNECTING (1 retry), Stop cancelled the pending retry |
| Real Electron UI: set delay + destination through the form, locked until ready, START ALL in the UI, receiver gets h264+aac, key not in config/view | `npm run test:ui-real` | PASS |
| Simulation smoke (scaffold) | `npm run smoke` | PASS |

The local receiver is `ffmpeg -listen 1 -i rtmp://127.0.0.1:<port>/live/test-key`. Nothing is
ever published to Twitch/YouTube/the league in tests.

## Not done yet / not verified

- **DeckLink SDI capture** is written (FFmpeg `decklink` input, embedded audio, optional
  `format_code`) but **untested**: no DeckLink card here, and stock FFmpeg builds lack DeckLink.
  Acceptance step: on the Director PC, with a DeckLink-enabled FFmpeg, select DeckLink, enter the
  device name exactly as `ffmpeg -sources decklink` lists it, confirm 1080p59.94 + embedded audio
  in the stats, then run a 300 s delay to a local receiver.
- **Windows build/package** not run (dev box is Linux). Run `npm --prefix stream-server run build`
  on Windows with `vendor/ffmpeg/ffmpeg.exe` in place.
- **RTMPS against a real TLS endpoint**: the protocol is supported by the FFmpeg build, but only
  plain RTMP was exercised against the local receiver.
- Not built yet: input preview + audio meters, the local HTTP/WebSocket API for Companion,
  log viewer + async logging, a multi-hour soak, live delay changes without a refill, and
  a throttled (slow, not dead) receiver test.
