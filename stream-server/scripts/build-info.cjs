'use strict';
// Writes build-info.json (version, git commit, branch, dirty flag, build time) next to main.cjs.
// Runs before start/build/package so the app footer always says exactly which code is running.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const git = (...args) => { try { return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
const info = {
  version: require(path.join(root, 'package.json')).version,
  commit: git('rev-parse', '--short=7', 'HEAD'),
  branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  commitDate: git('log', '-1', '--format=%cI'),
  dirty: Boolean(git('status', '--porcelain', '--', '.')),
  builtAt: new Date().toISOString()
};
fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log(`build-info: v${info.version} ${info.commit}${info.dirty ? '+changes' : ''} (${info.branch})`);
