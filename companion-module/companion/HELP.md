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
