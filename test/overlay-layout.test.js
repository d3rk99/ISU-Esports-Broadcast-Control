import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const overlayCss = readFileSync(new URL('../public/overlays/overlay.css', import.meta.url), 'utf8');
const overlayHtml = readFileSync(new URL('../public/overlays/scoreboard.html', import.meta.url), 'utf8');
const overlayJs = readFileSync(new URL('../public/overlays/overlay.js', import.meta.url), 'utf8');

test('controller initialization opens saved Program output after display settings load', () => {
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const init = app.slice(app.indexOf('function initialize()'));
  assert.match(init, /getOutputDisplays\(\)[\s\S]*openProgramOutput\(\{ name: state.activeOutputOverlay \|\| 'scoreboard' \}\)/);
  assert.match(init, /Automatic Program output startup failed/);
  const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const open = main.slice(main.indexOf('async function openProgramOutput'), main.indexOf('function writeJson'));
  assert.ok(open.indexOf('await Promise.all') < open.indexOf('await loadProgramOutput(name)'));
});

test('Valorant native-fit scoreboard stays in the central HUD corridor without entry expansion', () => {
  assert.match(overlayHtml, /class="valorant-hud val-native-fit"/);
  const bar = overlayCss.match(/\.val-native-fit \.val-scorebar \{([^}]+)\}/)[1];
  assert.match(bar, /top: 20px/);
  assert.match(bar, /width: 370px/);
  assert.match(bar, /height: 55px/);
  assert.match(bar, /grid-template-columns: 90px 190px 90px/);
  assert.match(bar, /background: #080d14/);
  assert.match(bar, /animation: none/);
  assert.match(overlayCss, /\.val-native-fit \.val-team \{[^}]*animation: none/s);
  assert.match(overlayCss, /\.val-native-fit\.spike-planted \.val-center \{ background: #340d17/);
});

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
