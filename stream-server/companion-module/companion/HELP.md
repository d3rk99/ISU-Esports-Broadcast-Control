# ISU Esports Stream Server

Controls the ISU Stream Server (delayed multistream + live recording) from a Stream Deck.
This is a separate module and a separate key from **ISU Esports Broadcast Control**.

## Stream Server setup

1. In Stream Server open **06 / COMPANION API**, tick **Enable Companion / Stream Deck control**, and press **SAVE SETTINGS**.
2. Press **Show / copy key** and copy the key.
3. Companion on the same PC: leave **Allow other PCs** off and use `127.0.0.1`.
   Companion on another PC: tick **Allow other PCs (LAN)**, save, and use the Director PC's IP.

## Connection settings

- **IP / hostname:** `127.0.0.1` or the Director PC IP (no `http://`).
- **Port:** `3180` unless changed in Stream Server.
- **API key:** the Stream Server key from step 2.

## Safety

GO LIVE / START ALL and destination starts are refused by Stream Server until the delay buffer
holds the full delay of real audio + video. A refused press is logged with the reason and nothing
is sent. Changing the delay from a button stops the outputs and refills the buffer.

## Buttons (Presets → Stream Control)

- **GO LIVE**: grey with fill %, green "READY" when the delay is full, red "ON AIR x/y OK" when live, green "ALL OK" when every enabled destination and the program are healthy.
- **STOP ALL**, **● REC** (live, undelayed recording), and **PROGRAM / DELAY / AUDIO** status tiles.
- **Destination 1-4**: press to start/stop. Red = live, green = live and healthy, amber = problem.

## Health

- Destination **HEALTHY** = connected and data actually moved in the last 5 s, and it has not had to skip ahead in the last 30 s.
- **STALLED** = connected but no data moving. **LAGGING** = falling behind (skipped ahead). **FAILED** = error or reconnecting.
- Program healthy = encoder running at ≥90% of the frame rate, no new dropped frames in 30 s, audio present and not silent for 10 s, delay ready.
- If Companion loses the Stream Server, every live/healthy value is cleared so buttons never show a stale green.

## Variables (use as `$(label:name)`)

`program_healthy`, `program_problems`, `any_live`, `all_enabled_live`, `all_enabled_healthy`,
`outputs_live`, `outputs_healthy`, `outputs_total`, `delay_ready`, `delay_percent`,
`delay_filled_seconds`, `delay_seconds`, `outputs_locked`, `recording`, `recording_seconds`,
`fps`, `bitrate_kbps`, `dropped_frames`, `audio_peak_l`, `audio_peak_r`, `audio_silent`, `engine`,
`error`, and for each destination 1-8: `outN_name`, `outN_state`, `outN_live`, `outN_healthy`,
`outN_health`, `outN_reconnects`.

## Triggers

Use Companion **Triggers → On variable change** with these. Examples:

- **Stream dropped:** condition `$(label:any_live)` is `false` → flash a button / play a sound.
- **Destination problem:** feedback condition "Destination has a problem" for destination 1.
- **Audio lost:** `$(label:audio_silent)` is `true`.
- **Auto-record when going live:** condition `$(label:any_live)` becomes `true` → action **Recording: Start**.
