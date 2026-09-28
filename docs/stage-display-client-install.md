# Stage Display Client Install Checklist

Use this checklist when installing the Stage Display Client on each gaming station.

## Files

Controller PC:

- Main controller: `release/win-unpacked/ISU Esports Broadcast Control.exe`

Station PCs:

- Stage client portable build: `release/stage-client/ISU Stage Display Client-Portable-0.6.2-x64.exe`
- Config template: `stage-display-client.config.example.json`

## Before Installing

1. Keep Windows display mode set to Extend.
2. Confirm Display 1 is the player gaming monitor.
3. Confirm Display 2 is the audience-facing monitor.
4. Do not change the player display resolution or refresh rate for this system.
5. Confirm the station PC can reach the controller PC over the LAN.

## Station Config

Each station needs a config based on:

```json
{
  "stationId": 1,
  "controller": "http://CONTROL-PC-IP:3178",
  "playerDisplay": 1,
  "stageDisplay": 2,
  "wallPosition": 1,
  "cursorLockEnabled": false
}
```

Set these per station:

- `stationId`: 1 through 10
- `controller`: controller PC address, using port `3178`
- `playerDisplay`: normally `1`
- `stageDisplay`: normally `2`
- `wallPosition`: normally same as `stationId`
- `cursorLockEnabled`: optional. Leave `false` until tested with the players' game setup.

## First Test Per Station

1. Start the main controller on the broadcast/control PC.
2. Start the Stage Display Client on the station PC.
3. Open the Stage Displays page in the controller.
4. Confirm the station appears online with the correct station number.
5. Send Blackout.
6. Send Test Graphic or Mirror Graphic.
7. Send Gameplay Mirror.
8. Confirm Display 1 is unchanged and Display 2 changes only through the client.
9. If cursor lock is enabled, confirm the player can still launch games and play normally.

## Preset Test

1. Import a test preset from the controller.
2. Send it to one station first.
3. Confirm the station preview updates.
4. Send it to all stations.
5. Confirm each station shows the correct crop/position for its wall position.

## Client Updates

The controller can publish and push Stage Display Client updates over the LAN.

1. Build or obtain the new Stage Display Client portable `.exe`.
2. In the controller, open Stage Displays.
3. Use `PUBLISH BUILD` and select the new Stage Display Client `.exe`.
4. Online clients with an older client version will show an update warning.
5. Use `UPDATE OUTDATED` to update only old clients, or `UPDATE ALL` to resend to every online client.
6. Each client downloads the update, verifies it, closes itself, replaces the local client `.exe`, and relaunches.

Notes:

- The update flow is intended for the portable Stage Display Client build.
- The client must have write permission to the folder where its `.exe` is stored.
- If a client cannot replace itself, manually copy the new portable build to that station.

## Safety Notes

- The client should never change Windows Duplicate/Extend mode.
- The client should never change Display 1 resolution or refresh rate.
- If the controller disconnects, the client should keep showing the last valid state.
- If a station behaves unexpectedly, use Blackout or Hold before troubleshooting.
