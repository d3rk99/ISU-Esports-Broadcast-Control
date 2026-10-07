# Display Client install (station PCs)

Each station PC runs the **ISU Display Client** full screen on its audience-facing monitor.
The controller decides what it shows: **Game mirror** (this PC's player monitor) or **NDI** (a feed from OBS, normally `ISU Stage NN`).

## Install

1. Nothing to install first: the **NDI runtime is included** in the Display Client (no separate NDI Runtime needed).
2. Run `ISU Display Client-Setup-<version>-x64.exe` on the PC (`npm run package:display-client` builds it; a portable exe is built too).
   It installs for the current user, starts right away, and **starts with Windows** from then on.
   It has **no taskbar button**: it lives in the tray's hidden icons (the ^ arrow next to the clock), orange monitor icon.
3. Press **Ctrl+Alt+S** (or double-click the tray icon) and set:
   - **Station**: 1-10 (must match the STATION column in the roster for player cards).
   - **Controller PC**: IP of the PC running ISU Broadcast Control. Port stays 3178.
   - **Display key**: only if one is set on the controller's Displays page.
   - **OBS PC for NDI**: only if the feed is not found by itself (networks that block mDNS). Put the OBS PC's IP.
   - **Player monitor / Audience monitor**: which screen is the game and which gets this window.
   - **Keep the mouse on the player monitor** (Ctrl+Alt+L toggles).
   - **Start with Windows** is on by default; untick it to stop that.
4. SAVE. The tray tooltip shows the station, mode and connection.

## Building the installer (once, on a Windows PC)

```
npm install
npm run ndi:install
npm run package:display-client
```

`ndi:install` downloads the NDI SDK and builds the NDI addon for Electron, which puts
`Processing.NDI.Lib.x64.dll` next to it. The build then copies that DLL into the app and refuses
to finish if it's missing (`scripts/check-ndi-bundle.cjs`), so a build without NDI can't ship.
NDI license notes are in `electron/displays/NDI-LICENSE.txt` and shown by the installer.

## Firewall

- Controller PC: allow TCP **3178** in (display clients) and **3174** (OBS loads the preset pages from it).
- OBS PC: allow OBS / NDI through the firewall (NDI uses 5353 UDP for discovery and 5960+ TCP).

## OBS (once, on the OBS PC)

Install **DistroAV** (OBS 31.1+), turn on **Tools → WebSocket Server**, then on the controller's Displays page enter the OBS PC, port and password and press **SET UP OBS**. It creates 10 scenes `ISU Stage 01-10`, each with the preset page and an NDI output of the same name. Press **CHECK OBS** to see the frame rate and which feeds are live.

## What the screen shows

- No picture yet: a "STATION NN" screen with what it is waiting for.
- A small red note in the corner only when something is wrong (controller gone, NDI feed lost).
- If the controller drops, an NDI feed keeps playing and the client reconnects by itself.

## Pink noise (player headsets)

Players wear IEMs (game, desktop, comms) under a headset that plays pink noise, so they can't hear the room.
The display client makes the pink noise itself (no audio file) and plays it on one output device; the controller turns it on and off.

On each station PC, open settings (Ctrl+Alt+S):
- **Headset output**: pick the headset, NOT the IEM output. Blank = Windows default output.
- **Max volume on this PC**: the loudest it can ever get on this station (default 60%). The controller's volume is a share of this.
- **TEST 3 SECONDS** plays it on the picked headset so you can check by ear.

On the controller, Displays page: PINK NOISE ON/OFF per station, per group (1-5, 6-10), or for all 10, plus one volume slider.
Noise always fades in (1.5 s) and out (0.6 s). If the picked headset is unplugged the client falls back to the default output and the station card shows a warning.
Companion: action "Displays: Pink noise" (on / off / toggle, station or group, optional volume), feedback "Display station is playing pink noise", variables `display_N_noise` / `display_N_noise_playing`.
