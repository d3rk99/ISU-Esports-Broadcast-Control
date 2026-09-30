# Developer Handoff

This project is a local-first Electron broadcast control app for Idaho State Esports. It controls scoreboard/map/roster overlays, telemetry bridges, Valorant OCR, Rocket League rendering experiments, Bitfocus Companion integration, and stage display clients.

## Repo Basics

- Main app: `electron/main.cjs`, `electron/preload.cjs`, `src/app.js`
- Game defaults/config: `src/game-config.js`
- OBS overlays: `public/overlays/`
- Companion module: `companion-module/`
- Stage Display Manager and Client: `electron/stage-displays/`
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
npm run package:stage-client
npm run package:companion
```

## Standard Checks

Run these before handing off changes:

```powershell
npm run check
npm test
npm run test:rl-cars
npm run build
```

`npm run test:rl-cars` opens Electron for a WebGL render verification, so it needs a graphical Windows session.

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

## Stage Display System Notes

The Stage Display subsystem is separate from game telemetry. It supports:

- Gameplay mirror mode
- Wall/span presets
- Mirror graphic presets
- Individual station content
- Blackout
- Client update push
- Station previews
- Cursor lock option

Install instructions are in `docs/stage-display-client-install.md`.

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
