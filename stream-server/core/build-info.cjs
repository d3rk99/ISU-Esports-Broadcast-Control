'use strict';
// Which code is running: build-info.json written at build/start time (packaged apps have no git),
// falling back to asking git directly when running from a checkout without it.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function buildInfo(root = path.join(__dirname, '..')) {
  let info = {};
  try { info = JSON.parse(fs.readFileSync(path.join(root, 'build-info.json'), 'utf8')); } catch {}
  if (!info.commit) {
    try {
      info.commit = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().trim();
      info.commitDate = execFileSync('git', ['log', '-1', '--format=%cI'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().trim();
    } catch {}
  }
  if (!info.version) { try { info.version = require(path.join(root, 'package.json')).version; } catch {} }
  return {
    version: info.version || '?', commit: info.commit || 'unknown', branch: info.branch || '', dirty: Boolean(info.dirty),
    commitDate: info.commitDate || '', builtAt: info.builtAt || ''
  };
}

function buildLabel(info) {
  const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  const parts = [`v${info.version}`, `build ${info.commit}${info.dirty ? '+changes' : ''}`];
  if (info.branch && info.branch !== 'main' && info.branch !== 'HEAD') parts.push(`branch ${info.branch}`);
  if (info.commitDate) parts.push(`code from ${when(info.commitDate)}`);
  if (info.builtAt) parts.push(`built ${when(info.builtAt)}`);
  return parts.join(' · ');
}

module.exports = { buildInfo, buildLabel };
