const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createUpdaterScript } = require('../electron/stage-displays/client-updater.cjs');

for (const failLaunch of [false, true]) {
  test(`Windows updater ${failLaunch ? 'restores backup when launch fails' : 'replaces target and requests relaunch'}`, { skip: process.platform !== 'win32' }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "isu updater's test-"));
    const targetFile = path.join(root, 'Client.exe');
    const downloadedFile = path.join(root, 'Downloaded.exe');
    const logFile = path.join(root, 'update.log');
    const readyFile = path.join(root, 'ready');
    fs.writeFileSync(targetFile, 'old build');
    fs.writeFileSync(downloadedFile, 'new build');
    const script = createUpdaterScript({ downloadedFile, targetFile, processId: 0, logFile, readyFile });
    // Real file replacement and rollback, with application launching mocked.
    const harness = `
$global:launches = 0
function Start-Process {
  param($FilePath, $WorkingDirectory, $WindowStyle, $ErrorAction)
  $global:launches++
  if ($WindowStyle -ne 'Hidden') { throw 'Expected hidden launch' }
  if ($WorkingDirectory -ne (Split-Path -Parent $FilePath)) { throw 'Wrong working directory' }
  ${failLaunch ? "if ($global:launches -eq 1) { throw 'Simulated launch failure' }" : ''}
}
${script}`;
    const scriptPath = path.join(root, 'run.ps1');
    fs.writeFileSync(scriptPath, harness);
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(result.status, failLaunch ? 1 : 0, result.stderr);
    assert.equal(fs.readFileSync(targetFile, 'utf8'), failLaunch ? 'old build' : 'new build');
    assert.equal(fs.readFileSync(`${targetFile}.previous`, 'utf8'), 'old build');
    assert.ok(fs.existsSync(readyFile));
    assert.match(fs.readFileSync(logFile, 'utf8'), failLaunch ? /Previous build restored/ : /Relaunch requested successfully/);
  });
}
