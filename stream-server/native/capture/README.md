# isu-capture (OBS-grade capture helper)

Small Windows program that opens a capture device (Blackmagic Web Presenter, capture cards, webcams,
OBS Virtual Camera) with **OBS's own capture library, libdshowcapture**, the same way OBS's
"Video Capture Device" source does:

- video and audio in one DirectShow graph (one clock)
- every sample keeps its own capture timestamp
- 10 ms audio buffers (DirectShow's default is ~500 ms, which made audio late)

It sends raw video + PCM audio with those timestamps to stdout as a live Matroska stream.
Stream Server's single FFmpeg encoder reads it (`-f matroska -i pipe:0`) and encodes once with NVENC.
Nothing is encoded or changed here.

## Build (Windows)

GitHub builds it on every push (Actions → "isu-capture (Windows)" → artifact `isu-capture-win-x64`).
Or by hand with Visual Studio 2022 + CMake:

    cmake -S stream-server/native/capture -B build -A x64
    cmake --build build --config Release

Copy `isu-capture.exe` **and** `libdshowcapture.dll` into `stream-server/vendor/capture/`.

First build: GitHub Actions run 37046779248 (windows-latest, MSVC) on commit 714e273, `--list` smoke test passed.

## Licenses

- libdshowcapture: LGPL-2.1 (OBS Project). Fetched at build time at a pinned commit, unmodified, built
  as its own DLL that ships next to the exe and can be replaced. Its license text ships with it.
- capture-device-support (inside libdshowcapture): MIT (Corsair/Elgato).
- This helper and the Stream Server: MIT, like the rest of the repo. No OBS GPL code is used.
