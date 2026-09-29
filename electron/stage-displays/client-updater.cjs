const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

function createUpdaterScript({ downloadedFile, targetFile, processId, launcherId = 0, logFile, readyFile }) {
  return `
$ErrorActionPreference = 'Stop'
$downloaded = ${quote(downloadedFile)}
$target = ${quote(targetFile)}
$logFile = ${quote(logFile)}
$readyFile = ${quote(readyFile)}
$backup = $target + '.previous'
$pending = $target + '.pending'
$replaced = $false
function Log($message) { Add-Content -LiteralPath $logFile -Value ((Get-Date -Format o) + ' ' + $message) }
try {
  Log 'Updater started'
  Set-Content -LiteralPath $readyFile -Value 'ready'
  foreach ($waitId in @(${Number(processId)}, ${Number(launcherId)})) {
    if ($waitId -gt 0 -and (Get-Process -Id $waitId -ErrorAction SilentlyContinue)) {
      Wait-Process -Id $waitId -Timeout 90 -ErrorAction Stop
    }
  }
  Log 'Client and portable launcher exited'
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
      Copy-Item -LiteralPath $downloaded -Destination $pending -Force
      if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination $backup -Force }
      Move-Item -LiteralPath $pending -Destination $target -Force
      $replaced = $true
      break
    } catch {
      if ($attempt -eq 59) { throw }
      Start-Sleep -Milliseconds 1000
    }
  }
  Unblock-File -LiteralPath $target -ErrorAction SilentlyContinue
  Log 'Replacement installed; relaunching'
  Start-Process -FilePath $target -WorkingDirectory (Split-Path -Parent $target) -WindowStyle Hidden -ErrorAction Stop
  Log 'Relaunch requested successfully'
} catch {
  Log ('UPDATE FAILED: ' + $_.Exception.Message)
  try {
    if ($replaced -and (Test-Path -LiteralPath $backup)) {
      Copy-Item -LiteralPath $backup -Destination $target -Force
      Log 'Previous build restored'
    }
    if (Test-Path -LiteralPath $target) {
      Start-Process -FilePath $target -WorkingDirectory (Split-Path -Parent $target) -WindowStyle Hidden -ErrorAction Stop
      Log 'Recovery launch requested'
    }
  } catch { Log ('RECOVERY FAILED: ' + $_.Exception.Message) }
  exit 1
}
`;
}

module.exports = { createUpdaterScript };
