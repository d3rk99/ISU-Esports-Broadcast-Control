# Valorant Observer 3 OCR Plan

Observer 3 is a dedicated data observer. They are not producing the broadcast camera feed. Their job is to keep machine-readable Valorant HUD data visible on a fixed 1920x1080 screen, preferably in a dark scene, so Broadcast Control can turn pixels into structured match data.

## Current baseline

- The live OCR service currently locks three fields: home score, round timer, and away score.
- The controller has draggable ROI boxes and a `SAVE BOXES` action for those fields.
- The new profile `1920x1080-en-observer3-scoreboard` keeps those three live fields and adds a `scoreboardTable` schema for the next scanner pass.

## Observer setup target

- Resolution: 1920x1080.
- Valorant scoreboard remains open continuously.
- HUD scale and graphics settings stay fixed for the whole event.
- Observer camera should sit in a dark/low-detail area to increase OCR contrast.
- This feed is for data extraction only and does not need to be visually clean for the audience.

## Next implementation pass

1. Add a controller panel for `scoreboardTable` calibration.
2. Draw row/column boxes over the debug frame for all 10 scoreboard rows.
3. Save table calibration separately from the three live top-HUD ROIs.
4. Add a scanner that reads text fields first:
   - player name
   - ultimate charge
   - kills
   - deaths
   - assists
   - credits
   - ping
5. Expose a read-only `Observer 3 table` preview in the controller with confidence/stability.
6. Add smoothing rules:
   - names lock only after repeated agreement
   - KDA values should not decrease during a map
   - credits may rise/fall but require repeated agreement
   - ultimate charge should be plausible and stable
7. Add icon matching after text OCR is stable:
   - agent portraits
   - weapons/loadout
   - armor
   - spike carrier
   - alive/dead state

## Data shape goal

```json
{
  "observer3": {
    "updatedAt": 0,
    "teams": {
      "home": {
        "players": [
          {
            "name": "",
            "agent": "",
            "ultimate": { "current": 0, "required": 0, "ready": false },
            "kda": { "kills": 0, "deaths": 0, "assists": 0 },
            "credits": 0,
            "weapon": "",
            "armor": "",
            "ping": 0,
            "alive": true
          }
        ]
      },
      "away": { "players": [] }
    }
  }
}
```

