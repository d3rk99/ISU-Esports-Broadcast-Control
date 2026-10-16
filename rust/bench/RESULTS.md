# Benchmarks: JS (Electron/Node) vs Rust

## Windows, Derk's home PC (2026-10-15, commit 115d6e2) - the real numbers
Ryzen 9 7900X (12 cores / 24 threads), Node 22.12, Rust 1.99.1, Tesseract 5.5.3 (vcpkg).
Same benchmark programs as below, 5 timed sweeps + 1 discarded start-up sweep per board.

| workers | board | JS | Rust | Rust is |
| --- | --- | --- | --- | --- |
| 4 | val-board-1 | 183 ms | 87 ms | 2.1x faster |
| 4 | val-board-2 | 181 ms | 90 ms | 2.0x faster |
| 8 | val-board-1 | 135 ms | 62 ms | 2.2x faster |
| 8 | val-board-2 | 146 ms | 52 ms | 2.8x faster |

Peak memory of the benchmark process, 4 workers: **JS 695 MiB, Rust 108 MiB (6.5x less).**
Same answers as on Linux: 139/140 cells identical, the same single name difference (see below).
Tests: cargo test all green; the real scoreboard overlay ran against the Rust server in Chrome.

## Linux test box (2026-10-16), first measurement
16-core Linux box.

## VALORANT scoreboard reader, one full sweep (align + all 70 OCR cells)
Input: Derk's real frames `test/fixtures/val-board-1.png` / `-2.png`. Same models both sides
(tesseract.js's `eng`, `electron/ocr-models/val.traineddata`), same cell images, same ladder.
Median of 4-5 sweeps, first sweep (start-up) not counted.

| workers | JS (tesseract.js 7 = Tesseract 5.1 WASM) | Rust (native Tesseract 5.5) |
| --- | --- | --- |
| 1 | – | 209 / 199 ms |
| 2 | – | 137 / 112 ms |
| 4 (default) | 139 / 128 ms | 102 / 91 ms |
| 8 | 114 / 107 ms | 75 / 70 ms |

Peak memory of the reader process tree, 4 workers: **JS 864 MB, Rust 165 MB.**

Same answers: 139 of 140 cells identical to the JS reader. The one difference: board 1 home row 1
name. Both read the text "Sn0wfal" (correct); the JS gave confidence 0.57/0.54/0.55 (below the
0.6 name cut, so blank), native 5.5 gave 0.53/0.59/0.63 (third try passes, so filled in). That is
the Tesseract version (5.1 vs 5.5), not the port. Engine start: 232 ms for 4 workers (eng + val).

Run: `node rust/bench/js-board-sweep.cjs 5 4` then
`cargo run --release -p isu-ocr --example board_bench 5 4` (prints both + the differences).
`js-cell-trace.cjs` / `--example cell_trace` show every OCR attempt of one cell on each side.
