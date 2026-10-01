const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { buildInfo, buildLabel } = require('../core/build-info.cjs');

test('build label shows version + commit; build-info.json wins over git (packaged apps have no git)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-'));
  fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify({ version: '9.9.9', commit: 'abc1234', branch: 'main', dirty: false, commitDate: '2026-10-01T17:00:00-06:00', builtAt: '2026-10-01T18:00:00-06:00' }));
  const info = buildInfo(dir);
  assert.equal(info.commit, 'abc1234');
  const label = buildLabel(info);
  assert.match(label, /^v9\.9\.9 · build abc1234 · code from /);
  assert.doesNotMatch(label, /branch/); // main is the normal case, not shown
  assert.match(buildLabel({ ...info, branch: 'mini/x', dirty: true }), /build abc1234\+changes · branch mini\/x/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('real checkout: label carries the actual git commit', () => {
  const { execFileSync } = require('node:child_process');
  const head = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: path.join(__dirname, '..') }).toString().trim();
  assert.equal(buildInfo().commit, head);
});
