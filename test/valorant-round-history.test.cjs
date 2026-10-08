const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Pull the two pure helpers out of src/app.js (the rest of app.js needs a browser).
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
const ctx = {}; vm.createContext(ctx);
vm.runInContext(src.slice(src.indexOf('function valorantRoundSwapped'), src.indexOf('function markValorantRoundWinner')), ctx);

test('VALORANT round history: only home / away won, colour flips after round 12 (and each OT round)', () => {
  // first half: home = teal (defense colour), away = coral
  assert.equal(ctx.valorantRoleFor('home', 1), 'defense');
  assert.equal(ctx.valorantRoleFor('away', 12), 'attack');
  // second half: they trade colours
  assert.equal(ctx.valorantRoleFor('home', 13), 'attack');
  assert.equal(ctx.valorantRoleFor('away', 24), 'defense');
  // overtime: swap every round
  assert.equal(ctx.valorantRoleFor('home', 25), 'defense');
  assert.equal(ctx.valorantRoleFor('home', 26), 'attack');
  assert.equal(ctx.valorantRoleFor('', 5), null);
});

test('VALORANT overlay: round dots follow the half swap for new AND old saves; spectated bar exists', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'overlays', 'overlay.js'), 'utf8');
  assert.match(js, /const swapped = valorantSidesSwapped\(index \+ 1\);/);
  assert.match(js, /round\.winnerSide \|\| \(round\.winnerRole === 'defense' \? 'home'/);
  assert.match(js, /function renderValorantSpectated\(state, teams\)/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'overlays', 'scoreboard.html'), 'utf8');
  assert.match(html, /id="val-spectated"/);
  const faces = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'valorant', 'agents', 'faces.json'), 'utf8'));
  const agents = fs.readdirSync(path.join(__dirname, '..', 'public', 'assets', 'valorant', 'agents')).filter((f) => f.endsWith('.webp')).map((f) => f.slice(0, -5));
  assert.deepEqual(agents.filter((a) => !faces[a]), [], 'every agent has a face spot');
});
