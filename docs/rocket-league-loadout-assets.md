# Rocket League Loadout Asset Pack

The Rocket League car renderer lab can use extracted Rocket League meshes and textures for local WebGL previews. The source asset pack is large and must be installed locally.

## Local Asset Pack

Expected zip path:

```text
assests/rl-loadout-assets.zip
```

Current local file:

```text
Size:   7,559,451,151 bytes
SHA256: 31BB61D57C5F9EA3385A8F4672E80159215CB957958508040835738D685813C9
```

This zip is intentionally ignored by git. It exceeds normal GitHub file limits and should be shared by external storage or recreated from the extraction workflow.

The renderer can also use an extracted folder at:

```text
assests/rl-loadout-assets/
```

The app expects a manifest at:

```text
assests/rl-loadout-assets/manifest.json
```

## Committed Metadata

The Rocket League item database is small enough to commit and should be kept in the repo:

```text
assests/rocket-league-items.csv
```

That CSV is used to map Stats API loadout item IDs to readable body, wheel, decal, boost, and paint entries.

## Expected Pack Layout

The extracted pack is expected to contain these top-level areas:

```text
manifest.json
bodies/
wheels/
decals/
decals/_premium_skins/
docs/extraction-log.md
docs/unmapped-items.json
```

The current renderer focuses on:

- Body GLBs
- Wheel GLBs
- Decal texture sets
- Diffuse textures
- Normal maps
- Paint masks
- Material binding metadata

Boosts, trails, toppers, antennas, finish recreation, and complex Unreal material graphs are out of scope for the first renderer milestones.

## Extractor Notes

These notes come from the extraction readme included in the asset pack:

- GLB orientation is meters, `+Y` up, `+Z` car nose, and `+X` car left.
- Body metadata can include `wheelAnchors` for `FL`, `FR`, `BL`, and `BR`.
- Wheels are centered on the hub. One side may need to be rotated 180 degrees around Y.
- Texture roles include diffuse, normal, mask, blankskin, curvature, PBR, and other.
- Rocket League normal maps are DirectX-style. Three.js should use `normalScale.y = -1`.
- `.mat` files are plain-text material slot hints from the extracted assets.
- Paint masks usually use RGB channels to drive primary, accent, decal, and trim layers.
- Decal `_D` or `_RGB` textures can overlay or replace body paint layers depending on the body and decal.

## Renderer Milestone State

Current implementation:

- Reads the asset summary lazily so opening the lab does not freeze the controller.
- Loads selected asset details only when the user selects a body, wheel, or decal.
- Parses basic material bindings and texture roles.
- Applies body paint, normal maps, paint masks, and decals where the asset metadata is usable.
- Provides manual body, decal, wheel, and paint controls for testing.
- Saves transparent PNG renders back to the controller mapping only when a live/API-backed mapping is selected.

Known limitations:

- Some bodies still need per-body material tuning.
- Wheel scale, side orientation, and rim/tire material separation need more validation.
- Exact player paint colors depend on whether the live Rocket League packet exposes enough data.
- Finish recreation is intentionally lower priority than body, decal, wheel, and color fidelity.
