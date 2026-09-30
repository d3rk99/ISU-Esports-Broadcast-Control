# Rocket League Car Render Lab — prototype

Open **Rocket League → CAR RENDER LAB**. This is an original Three.js implementation inspired by Rocket Loadout's local mesh/material rendering approach, not a copy of its Angular application or shaders.

## What works

- `Players[].Loadout` is retained in normalized live state alongside player identity. Slot positions are preserved.
- Choose a telemetry player and inspect the reported asset names. Refresh explicitly when players or loadouts change; boost updates never recreate the lab.
- Import a complete car as a self-contained glTF 2.0 `.glb` (32 MB maximum, embedded PNG/JPEG/WebP textures, uncompressed geometry).
- Drag/zoom the lit WebGL preview, then save a transparent 800×500 PNG for that body or reported loadout.
- Enable **Use saved car artwork on player stat cards**. Loadout-specific mappings take priority over body mappings. Unknown bodies retain roster headshot/team-logo fallback.
- Models and content-addressed PNGs are stored under the controller's userData/broadcast-assets directory. State holds URLs, not binary assets. Mapping removal does not delete source files.
- The stat overlay uses cached PNGs, not WebGL. Rendering is on-demand, and closing the lab releases its WebGL context.

## Important limits

No production Rocket League models or textures are bundled. Rocket Loadout's documented production storage bucket returned HTTP 404 during investigation. Its source-code license is not evidence of permission to redistribute game assets. Import models you have permission to use. Models need wheels and all desired cosmetics already assembled; this prototype does not compose arbitrary decals, wheels or paint shaders from asset names.

API loadout names are not a complete appearance specification: the documentation does not expose every individual paint parameter. **Loadout-specific mapping is an operator-supplied illustration, not a verified exact replica.** The renderer preserves GLB materials and never invents missing paint colors. All players sharing a body mapping reuse the same illustration. Body/loadout detection needs validation against a real current-game packet; no live match was controlled during development.

The demo is original generic geometry for testing GPU output; it cannot be saved to real player mappings. No screenshots are taken and no spectator camera is changed. No bridge protocol change is needed.

Assets remain on this controller PC; copying source code to another PC does not migrate userData. WebGL2 and a working graphics driver are required. Unsupported compressed models fail visibly instead of downloading decoder code. External model resource URLs are rejected.

## Tests

`node --test test/rl-loadout.test.js test/rocket-league-camera.test.cjs`

`npx electron scripts/verify-rl-car-lab.cjs` tests real WebGL rendering, GLB round-trip, saving, demo safeguards, and disposal using isolated fixtures (no live controller connection).

## Next

1. Acquire a permitted core model/material pack and map the real body/decal asset identifiers.
2. Verify real packets for paint/variant information before promising accurate cosmetics.
3. Add body-specific UV/decal masks, wheel attachments and paint shaders, with explicit fidelity reporting.

References: https://github.com/Longi94/rl-loadout and https://github.com/Longi94/rl-loadout-lib (research only; no code copied); https://www.rocketleague.com/developer/stats-api; https://threejs.org/ (MIT, license in node_modules/three/LICENSE).
