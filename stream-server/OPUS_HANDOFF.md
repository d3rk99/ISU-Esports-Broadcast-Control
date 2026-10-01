# Opus 5.5 takeover instructions — production ISU Stream Server

Use this document as the implementation prompt. Implement and verify the features; do not stop at another plan or scaffold.

## Repository and starting point

- Repository: https://github.com/d3rk99/ISU-Esports-Broadcast-Control
- Branch: `main`; initial Stream Server scaffold commit: `53cc2b3`.
- Application: `stream-server/`. Read its `ARCHITECTURE.md`, all core modules, entry point, preload, UI and tests before changing code. Also read applicable repository instructions and `docs/developer-handoff.md`.
- Inspect current Git state and preserve subsequent user/developer changes. Do not assume this document describes every later commit.
- The controller uses Electron, vanilla JavaScript and electron-builder. Reuse appropriate conventions while keeping Stream Server independently runnable and independently packaged.

The scaffold is runnable and tested but **every media behavior is fake**. It has no real capture, encoder, buffer, muxer or network output. Abstract classes are design seams, not evidence of implemented packet handling. `StreamService` currently constructs simulation adapters directly; its ticks cannot certify real media readiness. Preserve useful UI/configuration/credential behavior while replacing this coupling.

## Product objective

Build a production-capable Windows Director PC application that can replace the OBS program-stream workflow:

```text
ATEM Program SDI
  → DeckLink capture (other capture adapters remain possible)
  → ONE shared program video/audio encoding pipeline
  → configurable true program delay, default 300 seconds
  → packet fanout
  → simultaneous independent RTMP/RTMPS destinations
```

Target H.264 video with NVENC when supported and AAC audio. Provide a verified software encoding option. Preserve synchronized audio/video and support the actual discovered input formats, including fractional frame rates such as 59.94. Twitch, YouTube and league outputs are generic destination definitions, not hardcoded streaming engines.

Keep the Broadcast Controller and Stream Server separate executables with separate state, credentials, logs, ports and lifecycle. Both must run simultaneously. Do not restructure or regress unrelated controller features.

## Work method and scope

1. Establish a passing baseline and inspect available hardware, drivers, GPU, disk and media dependencies. Treat device discovery as evidence; do not invent capabilities or claim hardware tests ran without the hardware.
2. Verify current official FFmpeg, Blackmagic SDK, Electron and relevant encoder documentation when choosing APIs, build flags and distribution strategy. Record concrete dependency versions and capabilities. Do not assume a generic FFmpeg download includes DeckLink or NVENC support.
3. Implement in runnable increments with meaningful tests. Keep a short progress/validation record and update `ARCHITECTURE.md` to match the finished code. Do not let a design proposal substitute for implementation.
4. Work inside this application and minimal shared build/docs changes. Add native/helper projects inside its directory if justified. Do not force real-time media through Electron renderer IPC or block the UI/main-process event loop.
5. Use a local RTMP test receiver and deterministic test media by default. Do not publish to public Twitch/YouTube/league channels merely to test. Obtain explicit operator authorization before using real channel credentials for a public broadcast.
6. Continue independent implementation/testing if specific hardware is unavailable. Deliver runnable real-media paths using a generated clock/slate/audio source or a file source, and clearly identify any unverified hardware-specific functionality. Do not silently substitute simulated behavior for real mode.

## Stage 1 — real engine boundary and dependency management

- Introduce explicit simulation and real engine selection. Simulation must remain conspicuously labeled and isolated from production configuration/readiness. A real-mode startup failure must produce an actionable error, never fall back silently to simulation.
- Inject capture, encoder, delay and output adapters into the service. Replace simulation-clock logic with measured engine events in real mode. UI and future API use the same command facade and centralized status model.
- Define actual frame/packet types, timestamp/timebase rules, ownership, immutable/shared packet lifetime, codec configuration, discontinuity epochs, bounded queues and backpressure. Define cancellation and asynchronous shutdown semantics.
- Select and implement an FFmpeg subprocess/native/helper strategy that actually supports encode-once, delayed release and independent destinations. A process per destination is acceptable only if it remuxes/copies the already encoded program; it must not instantiate another encoder.
- Document helper IPC and crash recovery if using another process. Supervise exits/timeouts, reclaim resources, and invalidate readiness on failure.
- Provide reproducible Windows dependency setup, capability/version checks and actionable missing-dependency errors. Decide on managed installation versus user-supplied binaries. Avoid committing large vendor binaries or SDK material into Git. Verify redistribution/license requirements from official sources and document the chosen build; do not assume any random FFmpeg binary is distributable or capable.

## Stage 2 — capture, encode and preview

- Implement real device enumeration, signal status, capability negotiation, input selection and capture lifecycle, prioritizing DeckLink SDI with embedded audio.
- Implement a deterministic real-media test/file source for development without hardware. It must produce actual audio/video that traverses the production pipeline, unlike the current state-only simulation.
- Implement one shared H.264/AAC program encoder, settings validation and measured stats. Detect NVENC support and failures accurately; allow an explicit software alternative. Do not report successful encoding from a timer or requested bitrate.
- Preserve rational timestamps, audio sample timing, decode/presentation order, monotonic continuity and codec headers. Handle input format changes and signal loss through a deliberate restart/rebuffer policy.
- Provide an input preview and audio meters without creating another program encoder per output. Rate-limit preview transfers and keep large media payloads off control IPC.
- Confirm actual detected resolution/FPS, encoder mode, achieved bitrate, dropped/encoded frames, audio presence and A/V synchronization warnings in the UI.

## Stage 3 — true synchronized broadcast delay

This is the critical safety boundary. Implement a real encoded-media delay, not a delayed Start button, an output timestamp offset, a player-side delay or an elapsed-time progress bar.

- Support zero, 30, 60, 300, 600 seconds and longer configurable delays, with documented supported limits. Audio and video must be released from one synchronized delayed program timeline.
- Prefer bounded rolling encoded storage on a configured local disk with a small RAM index/cache. Alternative storage is acceptable if justified and bounded. Size storage from measured/configured media rates with headroom, and preflight writable capacity/throughput.
- Release media only after it has genuinely aged by the requested delay, using a stable monotonic capture/program clock mapping. Do not let scheduling jitter, segment rounding or keyframe selection release a packet early. Document additional codec/mux/network/player latency separately from the enforced program delay.
- Make readiness require contiguous, decodable, synchronized media with valid codec headers and a usable keyframe/release point. Progress reflects available playable media duration, not wall-clock time since launch.
- Enforce the interlock below the UI for every start, reconnect and API path. At 300 seconds, no live/undelayed packet may escape before its eligibility time. Zero-delay mode still requires healthy input/codec initialization.
- Specify behavior for increasing/decreasing delay, resetting the buffer, media discontinuities, missing audio/video, disk full/slow/unavailable, helper crash and system suspend/resume. Initially, stop outputs and refill for delay changes. Fail closed on uncertainty; never bypass delay to keep a connection alive.
- Distinguish Stop outputs from Reset buffer. Define whether capture/buffering continues while stopped, communicate this in the UI, and stop/release all resources on app shutdown.
- Add retention limits, owned-directory cleanup, crash recovery and safe temp-file handling. Never recursively delete arbitrary operator paths. Do not trust stale on-disk files as ready at startup without validated recovery.

## Stage 4 — independent real destinations

- Implement arbitrary generic RTMP/RTMPS destinations with enable, add/edit/remove, start, stop, connection/error state and reconnect behavior. Validate server/credential combinations before connecting in real mode.
- Fan out the same encoded program. Use independent muxing/connections and bounded queues so a slow/failing destination cannot freeze healthy ones or consume unlimited RAM.
- Implement retry with bounded exponential backoff, cancellation, reconnect counts, useful redacted diagnostics and per-destination telemetry. Stop/remove/disable must cancel pending reconnects and in-flight work safely.
- Start/reconnect on a decodable point in the delayed timeline, with codec configuration and correct timestamps. Define skip/replay behavior, maximum extra lag and queue overflow recovery; never reconnect to the live capture edge.
- Preserve same-account Windows-encrypted keys and blank-keeps/explicit-clear semantics. Decrypt only at the connection boundary. Redact secrets in URLs, child-process arguments/errors, logs, status/API DTOs and diagnostic exports. Avoid plaintext keys in command lines where a safer helper/IPC design is available; document any remaining local exposure.
- START ALL affects enabled destinations; failures are surfaced individually. STOP ALL reliably stops connections/retries. The interlock is checked during asynchronous start completion too, not only at the moment the button is clicked.

## Stage 5 — operator controls, persistence and Companion

- Replace every real-mode fake status with measured data or an explicit unavailable/error state. Keep clear READY/BUFFERING/LOCKED states, requested versus effective delay, disk capacity/health, encoder state, uptime and per-output status.
- Implement the missing encoder/signal/storage error handling and recovery. Avoid brief false-ready transitions during asynchronous reconfiguration. Validate new settings before disruption; design rollback or leave the app explicitly stopped/error if applying them fails.
- Retain focus/edits during telemetry updates. Persist non-secret settings and encrypted credentials atomically with schema migration/backup strategy. Surface corrupt config and decryption failures without overwriting recoverable data.
- Upgrade structured logging for production: rotation/retention, nonblocking writes, severity/event identifiers, safe output correlation, readable operator log viewer and visible log/disk failure. Never flood media hot paths with synchronous log writes.
- Implement an opt-in authenticated local HTTP/WebSocket API around the same serialized service commands and safe status DTOs:
  - `GET /api/status`
  - `POST /api/stream/start` and `/api/stream/stop`
  - `POST /api/delay`
  - `POST /api/outputs/{id}/start` and `/api/outputs/{id}/stop`
  - authenticated status subscriptions over WebSocket, with a documented event schema.
- Choose a configurable unused port after inspecting controller/bridge listeners. Default to loopback. LAN binding must be explicit and authenticated; protect against unwanted browser origins, oversized bodies, malformed commands and credential leakage. Do not reuse the controller's listener or private tokens.
- Document Companion Generic HTTP/WebSocket setup and command examples. A custom Companion module is optional and must not delay completion of the service API.

## Required tests and evidence

Add meaningful unit/integration/end-to-end tests rather than replacing simulations with functions that only update status strings.

1. **Real pipeline:** generated or recorded video with visible source clock/frame identifiers and synchronized audio markers runs through actual capture/test-source → encoder → storage → delayed release → local receivers. Decode received media and check timestamps/content, not just process exit codes.
2. **Delay:** test zero and short delays automatically, plus real-duration 300-second and 600-second runs. An accelerated fake clock does not validate the production five-minute buffer. Measure earliest packet release relative to capture eligibility and explain measurement tolerance; include A/V drift and discontinuity coverage. Distinguish app-enforced delay from downstream player/network latency.
3. **Encode once:** three or more simultaneous outputs share the same encoding instance/session. Add evidence from instrumentation/process configuration and verify no destination path re-encodes.
4. **Isolation:** disconnect/throttle/fail one receiver while others continue; verify memory/disk bounds, stop cancellation, independent retry and delayed keyframe reconnection. Exercise RTMP and RTMPS with certificate validation enabled.
5. **Interlock:** attempt starts/reconnects/API commands before readiness, during settings changes, after resets, signal loss, disk failure, suspend/resume and helper crashes. Assert no ineligible media is sent.
6. **Lifecycle/security:** repeated start/stop, disabled/removed output, concurrent commands, app close, persistence/restart, corrupt config, wrong-user credentials, log redaction and API auth/origin validation. Check child processes/files/handles are reclaimed.
7. **Hardware:** when available, verify actual ATEM SDI → DeckLink, embedded audio, fractional frame rate, NVENC and supported fallback. List exact devices/drivers/builds used. Do not mark this passed using a generated source.
8. **Soak:** run a representative long session with several outputs and the intended delay, recording CPU/GPU, working set, disk retention, A/V drift and dropped frames. Report duration and bounds. Explain any tests not runnable in the available environment.
9. **Regression/package:** run the new app tests and real Electron UI checks, build the Windows app/portable package, and launch the packaged real and simulation modes. Run existing root `check`, `test`, `test:ui`, `test:rl-cars` and `build` commands. Check the controller and Stream Server can operate concurrently without state/port collisions.

Baseline scaffold commands from the repository root:

```powershell
npm install
npm --prefix stream-server start
npm --prefix stream-server test
npm --prefix stream-server run smoke
npm --prefix stream-server run build
npm --prefix stream-server run package
```

Retain these or document intentional replacements. Add automated real-media test commands, setup documentation and fixtures without requiring production credentials or broadcasting publicly.

## Completion and handoff

Deliver working code, a separately runnable Windows application, operator setup/runbook, reproducible dependency/build instructions, current architecture/API documentation, and a precise validation matrix. Explain changed files, decisions, limitations and exact tests performed. Distinguish implemented-but-unverified hardware code from tested production paths. Provide binaries through appropriate release/artifact mechanisms, not large Git blobs; never commit keys or private SDK files.

The result is complete only when real audio/video can traverse the encode-once delayed multi-output path with the interlock and failure behavior verified. Do not claim production readiness based on the current mock tests, synthetic READY state, successful build alone or a diagram. If external hardware/credentials block final validation, finish all independent work and state the exact remaining acceptance steps without inventing results.
