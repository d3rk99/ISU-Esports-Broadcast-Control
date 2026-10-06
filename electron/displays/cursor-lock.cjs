'use strict';
// Windows only: keep the mouse on the player's monitor (ClipCursor, re-applied every 200 ms
// because games and Windows clear it). Other platforms: no-op.
const { spawn } = require('node:child_process');

const HEADER = `$code = @'
using System;
using System.Runtime.InteropServices;
public static class NativeMethods {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll", SetLastError=true)] public static extern bool ClipCursor(ref RECT rect);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool ClipCursor(IntPtr rect);
}
'@
Add-Type $code
`;

class CursorLock {
  constructor({ spawnImpl = spawn, platform = process.platform } = {}) { Object.assign(this, { spawnImpl, platform }); this.child = null; this.key = ''; }

  lock(rect) {
    if (this.platform !== 'win32') return false;
    const key = `${rect.left},${rect.top},${rect.right},${rect.bottom}`;
    if (this.child && this.key === key) return true;
    this.unlock();
    const script = `${HEADER}$r = New-Object NativeMethods+RECT
$r.Left = ${Math.round(rect.left)}; $r.Top = ${Math.round(rect.top)}; $r.Right = ${Math.round(rect.right)}; $r.Bottom = ${Math.round(rect.bottom)}
while ($true) { [NativeMethods]::ClipCursor([ref]$r) | Out-Null; Start-Sleep -Milliseconds 200 }`;
    this.child = this.spawnImpl('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: 'ignore' });
    this.key = key;
    return true;
  }

  unlock() {
    if (this.child) { try { this.child.kill(); } catch {} this.child = null; }
    this.key = '';
    if (this.platform === 'win32') {
      const release = this.spawnImpl('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `${HEADER}[NativeMethods]::ClipCursor([IntPtr]::Zero) | Out-Null`], { windowsHide: true, stdio: 'ignore' });
      release.on?.('error', () => {});
    }
  }
}

module.exports = { CursorLock };
