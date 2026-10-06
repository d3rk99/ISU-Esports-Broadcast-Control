# Overwatch hero art (HD)

Transparent full-body hero art, up to 1800 px, used for player cards (stage displays) and overlays.
Source: Overwatch Wiki (overwatch.fandom.com), mostly the official "Victory Pose" renders; each file's
source page is in `index.json`. Heroes missing here fall back to the old 340x655 art in `../heroes/`
(see OVERWATCH_HD_ART in src/game-config.js).

Not here yet (no good transparent art found): Anran, D.Mon, Emre, Jetpack Cat, Sierra, Wrecking Ball.
Sigma uses a Street Fighter collab pose, Brigitte and Orisa use event poses (only transparent art found).
To swap one: drop `<hero>.webp` in here, and add the slug to OVERWATCH_HD_ART if it's new.
