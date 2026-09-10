# ISU Esports Broadcast Control

This module connects Bitfocus Companion to the ISU Esports Broadcast Control application over the authenticated LAN API.

## Controller setup

1. Open **Settings → Bitfocus Companion API** in Broadcast Control.
2. Enable the LAN API.
3. Copy the displayed IP address, port, and private API key.
4. Keep Broadcast Control running while Companion is in use.

## Connection settings

- **Controller IP / hostname:** the Graphics PC address shown by Broadcast Control.
- **API port:** `3176` unless changed in Broadcast Control.
- **Private API key:** copy this exactly from Broadcast Control.

Enter only the IP address in the first field, such as `134.50.16.22`. Do not enter `http://`, the port, or `/api/companion` in that field. After pasting the private API key, click **Save changes**.

## Yellow “Bad configuration” badge

Version `0.1.1` corrects a configuration-storage issue in `0.1.0`. If a connection created with `0.1.0` remains yellow after installing this update, open its settings, enter the controller IP and private API key again, and save it. The badge details and Companion log now identify the exact missing or invalid field.

The module maintains a live event connection for variables and feedbacks. Commands are sent through the controller's action endpoint.

## Included controls

- Home and Away series-score adjustment and direct score setting
- Home and Away current map/game-score adjustment and direct setting
- Next Match, score reset, live/off-air, and team swapping
- Active game selection
- Map/game activation, winner selection, and results reset
- VALORANT veto reset
- Live connection, score, map, match, VALORANT veto, and Rocket League telemetry variables
- Presets for a starter match-control page

## Network safety

The API uses authenticated HTTP intended for a trusted broadcast LAN. Do not port-forward the API or expose port `3176` to the public internet.
