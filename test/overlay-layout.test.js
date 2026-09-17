import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const overlayCss = readFileSync(new URL('../public/overlays/overlay.css', import.meta.url), 'utf8');

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
