import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const overlayCss = readFileSync(new URL('../public/overlays/overlay.css', import.meta.url), 'utf8');
const overlayHtml = readFileSync(new URL('../public/overlays/scoreboard.html', import.meta.url), 'utf8');
const overlayJs = readFileSync(new URL('../public/overlays/overlay.js', import.meta.url), 'utf8');

test('Rocket League away boost cards keep names in the visible outside column', () => {
  assert.match(
    overlayCss,
    /#rl-away-players \.rl-boost-player strong \{ grid-column: 4; grid-row: 1; text-align: right; \}/,
  );
  assert.doesNotMatch(
    overlayCss,
    /#rl-away-players \.rl-boost-player\[data-rl-color="orange"\] strong/,
  );
});

test('Rocket League card geometry follows screen side instead of team color', () => {
  const orangeRule = overlayCss.match(/\.rl-boost-player\[data-rl-color="orange"\] \{([^}]*)\}/)?.[1] || '';
  assert.match(orangeRule, /--rl-player-color: var\(--rl-orange\)/);
  assert.doesNotMatch(orangeRule, /grid-template-columns/);
  assert.match(
    overlayCss,
    /#rl-away-players \.rl-boost-player > span \{\s*display: flex;\s*justify-content: flex-end;\s*\}/,
  );
});

test('Valorant scoreboard has a dedicated OCR HUD with first-class loadout icons', () => {
  assert.match(overlayHtml, /id="valorant-hud"/);
  assert.match(overlayHtml, /id="val-round-history"/);
  assert.match(overlayHtml, /id="val-home-players"/);
  assert.match(overlayHtml, /id="val-away-players"/);
  assert.match(overlayCss, /body\[data-game="valorant"\] \.scoreboard-generic/);
  assert.match(overlayCss, /\.val-players\s*\{/);
  assert.match(overlayCss, /\.val-weapon-slot img/);
  assert.match(overlayJs, /live\?\.observer3\?\.roundTimeline/);
  assert.match(overlayJs, /player\?\.loadout/);
  assert.match(overlayJs, /loadout\.status !== 'matched'/);
  assert.match(overlayJs, /VALORANT_WEAPON_ICON_BY_SLUG/);
});
