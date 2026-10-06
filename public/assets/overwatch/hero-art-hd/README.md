# Overwatch hero art (HD cutouts)

Transparent full-body hero cutouts, up to 1800 px, trimmed to the hero, used for player cards
(stage displays) and overlays. Source: Overwatch Wiki (overwatch.fandom.com), mostly official
"Victory Pose" renders and default-skin renders; each file's source page is in `index.json`.
Pictures that came with a background had it removed with rembg (BiRefNet-general model);
those are marked `background_removed` in `index.json`.

Heroes missing here fall back to the old 340x655 art in `../heroes/` (see OVERWATCH_HD_ART in
src/game-config.js). Not here yet: D.Mon, Wrecking Ball (no usable art found).
Sigma uses a Street Fighter collab pose, Brigitte and Orisa use event poses.

To swap one: drop a transparent `<hero>.webp` in here (add the slug to OVERWATCH_HD_ART if new).
To cut out a new picture: `pip install "rembg[cpu]"`, then
`rembg i -m birefnet-general in.png out.png`.
