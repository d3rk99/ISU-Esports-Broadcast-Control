const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const implementation = source.match(/function closeProgramOutput\(\) \{[\s\S]*?\n\}/)[0];

test('controller shutdown destroys both Program outputs and safely handles an already closed output', () => {
  let destroyed = 0;
  const makeWindow = (closed = false) => ({ isDestroyed: () => closed, destroy: () => { destroyed++; } });
  const context = vm.createContext({ programOutputWindows: { fill: makeWindow(), key: makeWindow() } });
  vm.runInContext(`${implementation}; closeProgramOutput(); closeProgramOutput();`, context);
  assert.equal(destroyed, 2);
  assert.equal(context.programOutputWindows.fill, null);
  assert.equal(context.programOutputWindows.key, null);
  context.programOutputWindows = { fill: makeWindow(true), key: makeWindow() };
  vm.runInContext('closeProgramOutput()', context);
  assert.equal(destroyed, 3);
  assert.match(source, /controllerWindow = null;\s+closeProgramOutput\(\);/);
});
