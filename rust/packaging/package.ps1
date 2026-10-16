# Builds the Rust apps and makes a folder, a portable zip and an installer for each:
#   ISU Esports Broadcast Control (controller), ISU Esports Game Bridge, ISU Display Client.
# Same contents as the Electron builds (electron-builder*.json): models, templates, overlay pages,
# NDI runtime for the display client. Output: rust\release\
#
# Needs (once):
#   - Rust (MSVC), Node + `npm install` in the repo root (for the tesseract eng model file)
#   - vcpkg tesseract:x64-windows, $env:TESSERACT_LIB_DIR = <vcpkg>\installed\x64-windows\lib
#   - NDI 6 Runtime installed (Processing.NDI.Lib.x64.dll is copied from it)
#   - Inno Setup 6 (iscc.exe) for the installers; without it you still get the folders + zips
#
# Usage: cd rust; powershell -ExecutionPolicy Bypass -File packaging\package.ps1 [-Version 0.7.0]
param([string]$Version = "")

$ErrorActionPreference = "Stop"
$rust = Resolve-Path "$PSScriptRoot\.."
$repo = Resolve-Path "$rust\.."
$out = "$rust\release"
# Keep cleanup confined to this workspace's generated release directory.
if ([IO.Path]::GetFullPath($out) -ne [IO.Path]::GetFullPath((Join-Path $rust 'release'))) { throw "Invalid release directory: $out" }
if (-not $Version) { $Version = (Get-Content "$repo\package.json" | ConvertFrom-Json).version }
Write-Host "ISU Rust apps $Version"

# ---- build ----
if (-not $env:TESSERACT_LIB_DIR) { throw "Set TESSERACT_LIB_DIR to <vcpkg>\installed\x64-windows\lib" }
Push-Location $rust
cargo build --release -p isu-control -p isu-outputs -p isu-bridge -p isu-display
if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
Pop-Location
$bin = "$rust\target\release"

# ---- shared pieces ----
$tessBin = Resolve-Path "$env:TESSERACT_LIB_DIR\..\bin"
$tessDlls = Get-ChildItem "$tessBin\*.dll"
# The OCR DLLs also import the MSVC runtime. Ship the redistributable CRT locally
# so a fresh station does not depend on a developer's global VC++ installation.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = if (Test-Path $vswhere) { & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath }
if (-not $vs) { throw "Visual C++ Build Tools not found (vswhere)" }
$crt = Get-ChildItem "$vs\VC\Redist\MSVC\*\x64\Microsoft.VC143.CRT" -Directory | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $crt) { throw "MSVC redistributable CRT directory not found under $vs" }
$dumpbin = Get-Command dumpbin.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1
if (-not $dumpbin) { $dumpbin = Get-ChildItem "$vs\VC\Tools\MSVC\*\bin\Hostx64\x64\dumpbin.exe" | Sort-Object FullName -Descending | Select-Object -ExpandProperty FullName -First 1 }
if (-not $dumpbin) { throw "dumpbin.exe not found in Visual C++ Build Tools" }
$engGz = "$repo\node_modules\@tesseract.js-data\eng\4.0.0\eng.traineddata.gz"
if (-not (Test-Path $engGz)) { throw "Missing $engGz (run npm install in the repo root)" }
$ndiDll = @("$env:NDI_RUNTIME_DIR_V6\Processing.NDI.Lib.x64.dll", "$env:NDI_RUNTIME_DIR_V5\Processing.NDI.Lib.x64.dll", "$env:ProgramFiles\NDI\NDI 6 Runtime\v6\Processing.NDI.Lib.x64.dll") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $ndiDll) { throw "NDI 6 Runtime not found (Processing.NDI.Lib.x64.dll); install it from ndi.video" }

function Unzip-Gz($src, $dst) {
  $in = [IO.File]::OpenRead($src); $gz = New-Object IO.Compression.GZipStream($in, [IO.Compression.CompressionMode]::Decompress)
  $o = [IO.File]::Create($dst); $gz.CopyTo($o); $o.Close(); $gz.Close(); $in.Close()
}
function Copy-Files($files, $dir) { New-Item -ItemType Directory -Force $dir | Out-Null; foreach ($f in $files) { Copy-Item $f $dir -Force } }
function Ocr-Data($app) {
  # tessdata/eng.traineddata (the apps look there when node_modules is not around)
  New-Item -ItemType Directory -Force "$app\tessdata" | Out-Null
  Unzip-Gz $engGz "$app\tessdata\eng.traineddata"
  # electron\ = the models + templates folder the Electron builds ship too
  Copy-Files (Get-ChildItem "$repo\electron\*.json", "$repo\electron\*.bin") "$app\electron"
  Copy-Item "$repo\electron\ocr-models" "$app\electron\ocr-models" -Recurse -Force
  Copy-Files $tessDlls $app
}

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory $out | Out-Null

# ---- controller ----
$ctl = "$out\ISU Esports Broadcast Control"
Copy-Files @("$bin\isu-broadcast-control.exe", "$bin\isu-outputs.exe") $ctl
Ocr-Data $ctl
Copy-Item "$repo\public" "$ctl\public" -Recurse -Force
New-Item -ItemType Directory -Force "$ctl\assests" | Out-Null
Copy-Item "$repo\assests\rocket-league-items.csv" "$ctl\assests\" -Force
foreach ($pack in @("rl-loadout-assets", "rl-loadout-assets.zip")) { if (Test-Path "$repo\assests\$pack") { Copy-Item "$repo\assests\$pack" "$ctl\assests\" -Recurse -Force } }

# ---- game bridge ----
$br = "$out\ISU Esports Game Bridge"
Copy-Files @("$bin\isu-game-bridge.exe") $br
Ocr-Data $br

# ---- display client ----
$dc = "$out\ISU Display Client"
Copy-Files @("$bin\isu-display-client.exe", $ndiDll, "$repo\electron\displays\NDI-LICENSE.txt") $dc
foreach ($app in @($ctl, $br, $dc)) { Copy-Files (Get-ChildItem "$($crt.FullName)\*.dll") $app }

# ---- check: every app starts far enough to find its files (scripts\check-ndi-bundle.cjs idea) ----
foreach ($need in @("$ctl\public\overlays\scoreboard.html", "$ctl\electron\ocr-models", "$ctl\tessdata\eng.traineddata", "$br\electron\valorant-agent-templates.json", "$br\tessdata\eng.traineddata", "$dc\Processing.NDI.Lib.x64.dll")) {
  if (-not (Test-Path $need)) { throw "Package is missing $need" }
}
foreach ($app in @($ctl, $br, $dc)) {
  foreach ($file in (Get-ChildItem "$app\*.exe", "$app\*.dll")) {
    $deps = & $dumpbin /dependents $file.FullName 2>$null
    if ($LASTEXITCODE -ne 0) { throw "dumpbin failed on $($file.FullName)" }
    foreach ($line in $deps) {
      if ($line -match '^\s+([\w.\-]+\.dll)\s*$') {
        $n = $Matches[1]
        if ((Test-Path "$app\$n") -or $n -like 'api-ms-*' -or $n -like 'ext-ms-*') { continue }
        if ($n -match '^(msvcp|vcruntime|concrt)' -or -not (Test-Path "$env:WINDIR\System32\$n")) { throw "$($file.Name) needs $n next to it in $app" }
      }
    }
  }
}

# ---- portable zips ----
foreach ($app in @($ctl, $br, $dc)) {
  $name = Split-Path $app -Leaf
  # Compress-Archive cannot handle the optional multi-GB RL asset pack.
  & "$env:WINDIR\System32\tar.exe" --format=zip -cf "$out\$name-Portable-$Version-x64.zip" -C $app .
  if ($LASTEXITCODE -ne 0) { throw "Portable ZIP failed for $name" }
}

# ---- installers (Inno Setup) ----
$iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($iscc) {
  foreach ($iss in @("controller.iss", "bridge.iss", "display-client.iss")) {
    & $iscc "/DAppVersion=$Version" "/DSrc=$out" "/O$out" "$PSScriptRoot\$iss"
    if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed on $iss" }
  }
} else {
  Write-Warning "Inno Setup 6 not found: made folders + portable zips only (install it from jrsoftware.org for the Setup.exe files)"
}
Get-ChildItem $out -File | Format-Table Name, @{n="MB";e={[math]::Round($_.Length/1MB,1)}}
