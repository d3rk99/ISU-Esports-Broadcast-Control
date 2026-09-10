# Studio Handoff

Date: 2026-09-10

## Current Branch

- Branch: `main`
- Last pushed baseline before this handoff: `899c3c1 Add Rocket League live overlay updates`
- This handoff adds the first VALORANT Overwolf GEP implementation pass.

## What Changed In This Pass

- Added isolated VALORANT telemetry service at `electron/valorant-service.cjs`.
- Wired VALORANT IPC through `electron/main.cjs` and `electron/preload.cjs`.
- Added VALORANT Live Data controls to Match Control:
  - Enable/disable Live Data
  - GEP Team 0 to Home/Away mapping
  - Sync toggles for score/map/round/phase/players
  - Simulator start/stop
  - Copy Debug Report
- Added VALORANT live state defaults and migration in `src/game-config.js` and `src/store.js`.
- Added UI styles in `src/styles.css`.
- Added tests in `test/valorant-service.test.cjs` and expanded `test/store.test.js`.
- Added Overwolf package tooling:
  - `@overwolf/ow-electron`
  - `@overwolf/ow-electron-builder`
  - `@overwolf/electron-is-overwolf`
- Added optional commands:
  - `npm run dev:ow`
  - `npm run package:ow`
- Added `overwolf.manifest.example.json` with the requested VALORANT GEP features.
- Updated `README.md` with VALORANT Live Data setup and limitations.

## Verified Here

These passed on this PC before handoff:

```powershell
npm run check
npm test
npm run build
npm run package
npm audit --omit=dev
```

`npm test` passed 22/22.

The packaged app launched, and the local health endpoint reported VALORANT state without crashing under standard Electron:

```text
http://127.0.0.1:3174/api/health
```

Expected standard Electron state:

```json
{
  "valorant": {
    "enabled": false,
    "status": "disabled",
    "gepAvailable": false,
    "gameDetected": false
  }
}
```

## Important Limitation

Actual VALORANT GEP capture was not tested here because this machine/session did not have a live Overwolf Electron VALORANT observer environment available. The implementation intentionally reports `GEP unavailable` in normal Electron instead of crashing.

## Studio PC Validation Steps

1. Pull the latest `main`.
2. Run:

```powershell
npm install
npm run check
npm test
```

3. For normal non-GEP app testing:

```powershell
npm run dev
```

4. For VALORANT GEP development testing:

```powershell
npm run dev:ow
```

5. Open VALORANT on the Observer PC and enter an observer/custom match if possible.
6. In Broadcast Control:
   - Select `VALORANT`
   - Open `Match Control`
   - Enable `Live Data`
   - Watch status progress from waiting/detected to receiving live data.
7. If telemetry does not work, click `COPY DEBUG REPORT` and give the copied JSON to Codex in the next session.

## Simulator Steps

The VALORANT test feed does not require Overwolf or VALORANT.

1. Run the app normally with `npm run dev` or the packaged executable.
2. Select `VALORANT`.
3. Open `Match Control`.
4. Click `RUN TEST FEED` in the VALORANT Game Events Provider panel.

The simulator drives the same normalized pipeline as real GEP and exercises match start, score/round changes, player rows, kill feed, spike state, and match end.

## Data Currently Normalized

- Match active state
- Map
- Game mode
- Match ID / pseudo match ID
- Round number
- Round phase
- Home/Away round score through GEP Team 0 mapping
- Observed player
- Roster and scoreboard player rows when GEP provides them
- Kill feed summary
- Spike planted site, defused state, and detonated state

No hidden-information tools or spike countdown timers were added.

## Still Manual

- Series score
- Veto flow
- Map winners
- Roster images and player metadata
- Any GEP field that is absent from the real payload
- Overwolf/Riot production approval and signing setup

## Files To Inspect First In Next Session

- `electron/valorant-service.cjs`
- `src/app.js`
- `electron/main.cjs`
- `electron/preload.cjs`
- `README.md`
- `overwolf.manifest.example.json`
- `test/valorant-service.test.cjs`

## Overwolf Notes

The implementation follows the Overwolf GEP event model documented for Overwolf Electron:

- `game-detected`
- `new-info-update`
- `new-game-event`

Requested VALORANT features:

```text
gep_internal
me
game_info
match_info
kill
death
```

Before production submission, confirm the current VALORANT game ID on the Observer PC from:

```text
%localappdata%\Overwolf\gamelist*.xml
```

The example manifest currently uses `21640`, which should be verified in the actual Overwolf environment before production packaging.

## Known Follow-Up Work

- Test real payloads on the VALORANT Observer PC.
- Compare copied debug report JSON against `normalizeInfoUpdate()` and `normalizeGameEvent()`.
- Adjust field names if Overwolf sends payloads differently than the docs/examples.
- Decide whether VALORANT live player stats should appear on OBS overlays or remain controller-only for now.
- Finalize real Overwolf app manifest/package once Riot/Overwolf distribution requirements are confirmed.
