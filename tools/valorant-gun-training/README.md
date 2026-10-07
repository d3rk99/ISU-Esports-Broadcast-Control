# VALORANT gun reader training

`python3 tools/valorant-gun-training/make_templates.py` builds
`electron/valorant-weapon-trained.bin` (+ names in `electron/valorant-gear-templates.json`).

- Every official gun icon in `public/assets/valorant/weapons/*.png` is rendered at the size the
  scoreboard draws it (sizes measured from the real board crops), with blur / stroke / shift /
  threshold variations, then squashed to the same 64x16 silhouette the live reader makes.
- The real board crops in `public/assets/valorant/weapons/trained/<gun>/` are added as they are.
  Crops grabbed over a bright background are skipped. To add more: save a crop of the LOADOUT
  cell into the right gun folder and run the script again.
- Two old crops were in the wrong folder and were moved (2026-10-07): a short gun in `ghost/`
  is a Bandit (Bandit is about 1.6x wider than tall, Ghost about 3x).
- `--renders-only` builds from the icons alone, to check how well it works without real crops.

Result (2026-10-07): on the real crops, with the crop being tested removed from the set,
27/33 right and 0 wrong (the rest stay blank = "not sure").
