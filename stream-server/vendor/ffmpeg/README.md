# FFmpeg for the packaged app (not committed)

Put `ffmpeg.exe` (and its DLLs for a shared build) in this folder before `npm run build` /
`npm run package`. electron-builder copies it to `resources/ffmpeg/`, where the app looks first.

Requirements the app checks at startup (Settings shows the result):

- `libx264` and/or `h264_nvenc`, `aac`, `rtmp` + `rtmps` protocols
- for DeckLink SDI capture: an FFmpeg configured with `--enable-decklink` (plus the Blackmagic
  Desktop Video driver installed). Public Windows builds usually do NOT include DeckLink because the
  SDK headers are non-redistributable; build it yourself (e.g. media-autobuild_suite or
  ffmpeg-windows-build-helpers with `--enable-decklink --enable-nonfree`) and keep it in-house.

`--enable-nonfree` / DeckLink builds may not be redistributed. Keep the binary on the Director PC
only. You can also leave this folder empty and set the FFmpeg path in the app's Advanced settings
or the `ISU_FFMPEG` environment variable.
