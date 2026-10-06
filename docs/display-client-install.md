# Display Client install (station PCs)

Each station PC runs the **ISU Display Client** full screen on its audience-facing monitor.
The controller decides what it shows: **Game mirror** (this PC's player monitor) or **NDI** (a feed from OBS, normally `ISU Stage NN`).

## Install

1. Install the **NDI Runtime** (free from ndi.video) on the station PC.
2. Copy `ISU Display Client-Portable-<version>-x64.exe` to the PC and run it (`npm run package:display-client` builds it).
3. Press **Ctrl+Alt+S** (or double-click the tray icon) and set:
   - **Station**: 1-10 (must match the STATION column in the roster for player cards).
   - **Controller PC**: IP of the PC running ISU Broadcast Control. Port stays 3178.
   - **Display key**: only if one is set on the controller's Displays page.
   - **OBS PC for NDI**: only if the feed is not found by itself (networks that block mDNS). Put the OBS PC's IP.
   - **Player monitor / Audience monitor**: which screen is the game and which gets this window.
   - **Keep the mouse on the player monitor** (Ctrl+Alt+L toggles) and **Start with Windows** as wanted.
4. SAVE. The tray tooltip shows the station, mode and connection.

## Firewall

- Controller PC: allow TCP **3178** in (display clients) and **3174** (OBS loads the preset pages from it).
- OBS PC: allow OBS / NDI through the firewall (NDI uses 5353 UDP for discovery and 5960+ TCP).

## OBS (once, on the OBS PC)

Install **DistroAV** (OBS 31.1+), turn on **Tools → WebSocket Server**, then on the controller's Displays page enter the OBS PC, port and password and press **SET UP OBS**. It creates 10 scenes `ISU Stage 01-10`, each with the preset page and an NDI output of the same name. Press **CHECK OBS** to see the frame rate and which feeds are live.

## What the screen shows

- No picture yet: a "STATION NN" screen with what it is waiting for.
- A small red note in the corner only when something is wrong (controller gone, NDI feed lost).
- If the controller drops, an NDI feed keeps playing and the client reconnects by itself.
