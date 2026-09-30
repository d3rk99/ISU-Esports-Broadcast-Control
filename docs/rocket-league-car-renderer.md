# Rocket League Car Render Lab - prototype

Open **Rocket League -> CAR RENDER LAB**. This is an original Three.js implementation inspired by Rocket Loadout's local mesh/material rendering approach, not a copy of its Angular application or shaders.

## What works

- `Players[].Loadout` is retained in normalized live state alongside player identity. Slot positions are preserved.
- Choose a telemetry player and inspect the reported asset names. Refresh explicitly when players or loadouts change; boost updates never recreate the lab.
- If `assests/rl-loadout-assets.zip` or `assests/rl-loadout-assets/manifest.json` exists, the lab reads its manifest and exposes the extracted Rocket League body library directly. The pack is served on demand from the controller through `/rl-loadout-assets/...`; it is not copied into `public` or bundled into overlay HTML.
- The updated extraction pack includes body meshes, wheel meshes, decal textures, `.mat` material links, thumbnails, texture roles and wheel anchors. The renderer now prefers those `.mat` bindings before falling back to filename matching.
- Import a complete car as a self-contained glTF 2.0 `.glb` (32 MB maximum, embedded PNG/JPEG/WebP textures, uncompressed geometry).
- Drag/zoom the lit WebGL preview, then save a transparent 800x500 PNG for that body or reported loadout.
- Enable **Use saved car artwork on player stat cards**. Loadout-specific mappings take priority over body mappings. Unknown bodies retain roster headshot/team-logo fallback.
- Models and content-addressed PNGs are stored under the controller's userData/broadcast-assets directory. State holds URLs, not binary assets. Mapping removal does not delete source files.
- The stat overlay uses cached PNGs, not WebGL. Rendering is on-demand, and closing the lab releases its WebGL context.

## Important limits

No production Rocket League models or textures are bundled with app source by default. `assests/rl-loadout-assets.zip` is a local operator-supplied extraction pack. Keep that pack beside the app when you need the body browser. Manual imports still require models you have permission to use.

The official Stats API (checked 2026-09-30) sends each player's `Loadout` (asset names by slot) and each team's `ColorPrimary`/`ColorSecondary`. It does NOT send a player's own garage colours, paint finishes or painted-item colours. Those exist only in replays (`TeamPaint`: primary/accent colour IDs + finishes) and BakkesMod loadout codes. Paint therefore resolves: per-player garage colours saved in the lab (PAINT MODE -> Player's garage colors, stored by player id in `carRenderer.playerPaint`) -> team colours from the packet -> stock garage defaults (blue #35, orange #33, accent #0). Palettes live in `src/rl-car-palette.js` (70 blue / 70 orange / 105 accent, indexed by in-game ID).

The renderer currently prioritizes:

1. Body mesh from loadout slot 0.
2. Decal texture from loadout slot 1 when it applies to the selected body.
3. Wheel mesh from loadout slot 2 using the body wheel anchors.
4. `.mat` file diffuse/normal/mask bindings, then filename matching as fallback.

Boosts, toppers and antennas are intentionally not composed yet. Some wheels in extracted packs are single-material meshes; those are neutralized to dark rubber/metal so team-colored tire materials do not tint the whole wheel.

The demo is original generic geometry for testing GPU output; it cannot be saved to real player mappings. No screenshots are taken and no spectator camera is changed. No bridge protocol change is needed.

Assets remain on this controller PC; copying source code to another PC does not migrate userData. WebGL2 and a working graphics driver are required. Unsupported compressed models fail visibly instead of downloading decoder code. External model resource URLs are rejected.

## Tests

`node --test test/rl-loadout.test.js test/rocket-league-camera.test.cjs`

`npx electron scripts/verify-rl-car-lab.cjs` tests real WebGL rendering, GLB round-trip, saving, demo safeguards and disposal using isolated fixtures (no live controller connection).

## Next

1. Validate exact body/decal/wheel matches against real current-game packets for several cars.
2. Paint finishes (matte, pearlescent, etc.) are not rendered yet; replay parsing could auto-fill garage colour IDs.
3. Add body-specific material tuning where the extracted `.mat` links are correct but the original Unreal material logic is more complex than diffuse/normal/mask.

References: https://github.com/Longi94/rl-loadout and https://github.com/Longi94/rl-loadout-lib (research only; no code copied); https://www.rocketleague.com/developer/stats-api; https://threejs.org/ (MIT, license in node_modules/three/LICENSE).
