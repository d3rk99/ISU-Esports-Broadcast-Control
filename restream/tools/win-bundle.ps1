# Assemble a self-contained dist\ folder: restream.exe + restream-cli.exe +
# the GStreamer runtime DLLs + the plugins the app can use. The app finds
# the plugins in the "gst-plugins" folder next to the exe.
#
# usage:  powershell -ExecutionPolicy Bypass -File tools\win-bundle.ps1
$ErrorActionPreference = "Stop"
$root = Join-Path $PSScriptRoot ".."
$gst = $env:GSTREAMER_1_0_ROOT_MSVC_X86_64
if (-not $gst) { $gst = "C:\Program Files\gstreamer\1.0\msvc_x86_64\" }
$dist = Join-Path $root "dist"

if (-not (Test-Path "$root\target\release\restream.exe")) { throw "build first: tools\win-build.ps1 -Release" }
Remove-Item -Recurse -Force $dist -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path "$dist\bin\gst-plugins" | Out-Null

# root: launchers + docs; bin: real executables beside the runtime DLLs they import
Copy-Item "$root\target\release\restream-launch-gui.exe" "$dist\Restream.exe"
Copy-Item "$root\target\release\restream-launch-cli.exe" "$dist\restream-cli.exe"
Copy-Item "$root\target\release\restream.exe" "$dist\bin\"
Copy-Item "$root\target\release\restream-cli.exe" "$dist\bin\"
Copy-Item "$gst\bin\*.dll" "$dist\bin\"
Copy-Item "$gst\bin\gst-inspect-1.0.exe" "$dist\bin\" -ErrorAction SilentlyContinue
Copy-Item "$gst\libexec\gstreamer-1.0\gst-plugin-scanner.exe" "$dist\bin\" -ErrorAction SilentlyContinue

# Plugins we use. Missing ones (e.g. no nvcodec on a non-NVIDIA box) are skipped.
$plugins = @(
  "coreelements","app","typefindfunctions","playback",
  "videoconvertscale","videorate","videotestsrc","audiotestsrc","audioconvert","audioresample","level","volume",
  "videoparsersbad","audioparsers","flv","matroska","isomp4","multifile","jpeg","pango",
  "x264","openh264","fdkaac","voaacenc","libav",
  "mediafoundation","winks","directshow","wasapi2","wasapi","decklink",
  "nvcodec","amfcodec","qsv","d3d11","d3d12","va",
  "srt","rtmp2","dtls","sctp"
)
foreach ($p in $plugins) {
  $f = "$gst\lib\gstreamer-1.0\gst$p.dll"
  if (Test-Path $f) { Copy-Item $f "$dist\bin\gst-plugins" } else { Write-Host "  (no plugin $p)" }
}
# libav needs its own DLLs (already in bin), pango needs fontconfig/freetype (in bin).

# Every element the pipelines name must exist in the bundled plugins, or the app fails at runtime with
# 'no element "x"' (0.2.0 shipped without gstvolume.dll: gain + monitor broke the preview). Encoders and
# capture sources are optional per machine; these are not.
$required = @("queue","tee","fakesink","identity","filesink","appsink","appsrc","typefind",
  "videoconvert","videoscale","videorate","videotestsrc","audiotestsrc","audioconvert","audioresample",
  "volume","level","timeoverlay","h264parse","aacparse","flvmux","flvdemux","matroskamux","matroskademux",
  "qtmux","splitmuxsink","decodebin","uridecodebin3","wasapi2src","wasapi2sink","mfvideosrc")
$inspect = "$dist\bin\gst-inspect-1.0.exe"
if (Test-Path $inspect) {
  $env:GST_PLUGIN_PATH = "$dist\bin\gst-plugins"; $env:GST_PLUGIN_SYSTEM_PATH = "$dist\bin\gst-plugins"
  $env:GST_REGISTRY = "$env:TEMP\restream-bundle-registry.bin"
  Remove-Item $env:GST_REGISTRY -ErrorAction SilentlyContinue
  $missing = @($required | Where-Object { & $inspect --exists $_ 2>$null; $LASTEXITCODE -ne 0 })
  if ($missing.Count) { throw "bundle is missing GStreamer elements: $($missing -join ', ') (add their plugin to `$plugins)" }
  Write-Host "all $($required.Count) required GStreamer elements present"
} else { Write-Host "  (gst-inspect-1.0.exe not bundled: skipped the element check)" }

Copy-Item "$root\docs\USER-GUIDE.md" $dist
$size = (Get-ChildItem $dist -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB
Write-Host ("dist ready: {0:N0} MB  ->  {1}" -f $size, $dist)
Write-Host "Sanity check:  dist\restream-cli.exe encoders"
