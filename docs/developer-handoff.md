# Developer Handoff

This project is a local-first Electron broadcast control app for Idaho State Esports. It controls scoreboard/map/roster overlays, telemetry bridges, Valorant OCR, Rocket League rendering experiments, Bitfocus Companion integration, and stage display clients.

## Repo Basics

- Main app: `electron/main.cjs`, `electron/preload.cjs`, `src/app.js`
- Game defaults/config: `src/game-config.js`
- OBS overlays: `public/overlays/`
- Companion module: `companion-module/`
- Display system (manager, client, OBS setup): `electron/displays/`, preset pages `public/displays/`, controller page `src/displays-view.js` + `src/display-presets.js`
- Rocket League car renderer lab: `src/rl-car-lab.js`, `src/rl-car-renderer.js`
- Valorant OCR service: `electron/valorant-ocr-service.cjs`, `electron/valorant-ocr-engine.cjs`, `electron/valorant-capture.cjs`

## Required Local Setup

Install Node.js 20 or newer, then:

```powershell
npm install
npm run dev
```

Packaged builds:

```powershell
npm run package:dir
npm run package
npm run package:bridge
npm run package:display-client
npm run package:companion
```

## Standard Checks

Run these before handing off changes:

```powershell
npm run check
npm test
npm run test:rl-cars
npm run test:ui
npm run build
```

`npm run test:rl-cars` opens Electron for a WebGL render verification, so it needs a graphical Windows session.

`npm run test:ui` checks in real Chromium that the controller's in-place renderer (`src/dom-patch.js`) keeps focus, typed text, caret, panel scroll, open `<details>` and click targets intact across live re-renders.

## UI rendering

`render()` builds the whole view as an HTML string, but applies it with `patchHtml()` (src/dom-patch.js) instead of `innerHTML`, so live telemetry never steals focus or resets scroll. Elements are matched by id, `data-key`, or `data-action`/`data-view` plus identity attributes (`data-index`, `data-team`, `data-prop`, ...). When adding a repeated row, give it one of those so rows don't swap state. Mark anything that must never be touched after first render with `data-preserve`.

Destructive buttons use `data-confirm="label while armed"`: the first click arms the button for 3 s, and a second click runs it. This is non-blocking on purpose, so no modal ever freezes the controller on air.

## Important Runtime Ports

- Overlay/state server: `3174`
- Bitfocus Companion API: `3176`
- Stage Display Manager WebSocket/API: `3178`
- Rocket League Stats API default TCP/WebSocket: `49123` / `49124`

## Large Local Assets

The Rocket League loadout asset pack is intentionally not stored in git because the current zip is about 7.56 GB, which exceeds GitHub file limits.

Expected local path:

```text
assests/rl-loadout-assets.zip
```

See `docs/rocket-league-loadout-assets.md` for the current hash, source layout, and renderer expectations.

The Rocket League item database CSV is small enough to commit and should live at:

```text
assests/rocket-league-items.csv
```

## Rocket League Renderer Lab Notes

The renderer lab is experimental. It reads `Players[].Loadout`, matches body/decal/wheel entries through `items.csv`, then uses the local asset pack to preview and save a transparent PNG for overlays.

Current behavior:

- Body, wheel, and decal assets are read lazily so opening the lab does not freeze the controller.
- Body and wheel GLBs are served through `/rl-loadout-assets/...`.
- Material `.mat` files are parsed only for selected assets.
- Diffuse, normal, paint mask, and decal textures are applied in Three.js.
- Generic GLB material names like `material_0` are mapped back to likely body/chassis materials.
- Manual body, decal, wheel, and paint controls exist for lab testing without a complete live packet.

Known limits:

- Exact player paint colors depend on live API data that may not be exposed consistently.
- Finish recreation is not a priority.
- Wheels need more validation for orientation, scale, and tire/rim material separation.
- Some original Unreal material graphs are more complex than diffuse/normal/mask and may need body-specific tuning.

## Display System Notes

Rebuilt from scratch 2026-10-06 around NDI. Install guide: `docs/display-client-install.md`.

- **Display client** (one per station PC, `npm run display-client`, packaged with `npm run package:display-client`): full screen on the audience monitor, two modes only, chosen by the controller:
  - **Game mirror**: shows that PC's player monitor.
  - **NDI**: shows an NDI feed, by default `ISU Stage NN` for its station.
  Keeps reconnecting to the controller; an NDI feed keeps playing if the controller drops. Settings: Ctrl+Alt+S. Cursor lock (mouse stays on the player monitor, Windows): Ctrl+Alt+L.
- **Controller** (Displays page): flip any/all stations between mirror and NDI, pick NDI presets per station or all, set up OBS, optional display key. Port 3178, WebSocket `/display`.
- **Presets** (`src/display-presets.js`, stored in `state.displays.stations[N]`): idle, team intro, player cards (the roster player whose STATION is N), team banners (one canvas across 5 screens: 1-5 home, 6-10 away, or force a team), series score, black.
- **OBS** draws the presets: 10 scenes, each a Browser Source of `/displays/station.html?station=N` with a DistroAV NDI filter `ISU Stage NN`. SET UP OBS on the Displays page makes them (needs OBS 31.1+, DistroAV, WebSocket server on). Pages update live from the controller; OBS never reloads.
- **Companion**: `Displays: Game mirror / NDI` and `Displays: NDI preset` actions, feedbacks, and `display_N_*` variables.
- Preview the preset pages offline: `scripts/display-preview.cjs`.

## Valorant OCR Notes

The current Valorant OCR workflow is built around Observer 3 running a stable scoreboard view. It scans player names, ultimate, K/D/A, credits, loadout icons, and scores. Timer OCR was intentionally de-emphasized because the in-game timer is allowed to show through the overlay.

Weapon/loadout recognition supports trained templates stored under:

```text
public/assets/valorant/weapons/trained/
```

Keep trained templates organized by weapon folder.

## Git Hygiene

- Do not commit `release/`, `dist/`, `node_modules/`, or the 7.56 GB Rocket League asset zip.
- Do commit source, docs, small CSV/databases, and small trained templates.
- Do not start the controller hidden/headless for user testing. If relaunching it for the user, start the visible packaged executable.
