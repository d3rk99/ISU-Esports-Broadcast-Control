const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Every local file the Bridge requires (and their data files) must be in the Bridge package,
// or the feature fails silently in the built exe (icon-only spectate got 0 reads this way).
test('bridge package: every electron/*.cjs the Bridge requires (recursively) is in electron-builder.bridge.json', () => {
  const root = path.join(__dirname, '..');
  const files = JSON.parse(fs.readFileSync(path.join(root, 'electron-builder.bridge.json'), 'utf8')).files;
  const seen = new Set(); const todo = ['electron/bridge-main.cjs'];
  while (todo.length) {
    const f = todo.pop(); if (seen.has(f)) continue; seen.add(f);
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(/require\('\.\/([^']+\.cjs)'\)/g)) todo.push(`electron/${m[1]}`);
  }
  const missing = [...seen].filter((f) => !files.includes(f));
  assert.deepEqual(missing, [], 'missing from the Bridge package');
  for (const data of ['electron/valorant-agent-templates.json', 'electron/valorant-agent-templates.bin']) assert.ok(files.includes(data), data);
});
