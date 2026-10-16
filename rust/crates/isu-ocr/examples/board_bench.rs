//! Rust VALORANT board reader on Derk's real frames, timed and compared cell by cell with the JS
//! reader (rust/bench/out/js-board.json from rust/bench/js-board-sweep.cjs).
//!   cargo run --release -p isu-ocr --example board_bench [runs] [workers]
use std::path::Path;
use std::time::Instant;

use isu_ocr::board::{self, Cell, Frame, Ocr, Value};
use isu_ocr::tess::{Tess, unpack_gz_model};

struct Img { w: i32, h: i32, rgb: Vec<u8> }
// test/valorant-board-fixtures.cjs board(): the crop sits at (500, 280) of the 1080p grid.
impl Frame for Img {
    fn rgb(&self, x: i32, y: i32) -> [u8; 3] {
        let (lx, ly) = (x - 500, y - 280);
        if lx < 0 || ly < 0 || lx >= self.w || ly >= self.h { return [0, 0, 0]; }
        let o = ((ly * self.w + lx) * 3) as usize;
        [self.rgb[o], self.rgb[o + 1], self.rgb[o + 2]]
    }
    fn lum(&self, x: i32, y: i32) -> u8 {
        let p = self.rgb(x, y);
        // fixtures lum: Math.round(r*0.299 + g*0.587 + b*0.114)
        ((f64::from(p[0]) * 0.299 + f64::from(p[1]) * 0.587 + f64::from(p[2]) * 0.114) + 0.5).floor() as u8
    }
}

fn load(p: &Path) -> Img {
    let d = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(p).unwrap()));
    let mut r = d.read_info().unwrap();
    let mut buf = vec![0; r.output_buffer_size().unwrap()];
    let info = r.next_frame(&mut buf).unwrap();
    let ch = info.color_type.samples();
    let rgb = buf[..info.buffer_size()].chunks(ch).flat_map(|c| [c[0], c[1 % ch], c[2 % ch]]).collect();
    Img { w: info.width as i32, h: info.height as i32, rgb }
}

/// One worker: its own eng + val engines (the JS pool gives each grid worker its own).
struct Worker { eng: Tess, val: Tess }
impl Ocr for Worker {
    fn tess(&mut self, lang: Option<&str>) -> &mut Tess { if lang == Some("val") { &mut self.val } else { &mut self.eng } }
}

fn main() -> anyhow::Result<()> {
    let runs: usize = std::env::args().nth(1).and_then(|v| v.parse().ok()).unwrap_or(5);
    let workers: usize = std::env::args().nth(2).and_then(|v| v.parse().ok()).unwrap_or(4);
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    // SAME models as the JS: tesseract.js's eng (unpacked) + electron/ocr-models/val.traineddata
    let eng_dir = unpack_gz_model(&repo.join("node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz"), &repo.join("rust/target/tessdata"), "eng")?;
    let val_dir = repo.join("electron/ocr-models");
    let t_init = Instant::now();
    let mut pool: Vec<Worker> = (0..workers).map(|_| Worker { eng: Tess::new(&eng_dir, "eng").unwrap(), val: Tess::new(&val_dir, "val").unwrap() }).collect();
    eprintln!("{workers} workers ready in {} ms", t_init.elapsed().as_millis());
    let js: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(repo.join("rust/bench/out/js-board.json"))?)?;
    let mut summary = serde_json::Map::new();
    for f in ["val-board-1.png", "val-board-2.png"] {
        let img = load(&repo.join("test/fixtures").join(f));
        let mut times = Vec::new();
        let mut values: Vec<(String, Option<Value>)> = Vec::new();
        for run in 0..=runs {
            let t0 = Instant::now();
            let a = board::align_board(&img);
            let cells: Vec<Cell> = board::cell_rois(&a);
            // cells dealt round-robin to the workers like the JS lanes, read in parallel threads
            let mut out: Vec<Option<Value>> = vec![None; cells.len()];
            std::thread::scope(|s| {
                let hs: Vec<_> = pool.iter_mut().enumerate().map(|(wi, w)| {
                    let cells = &cells; let img = &img;
                    s.spawn(move || cells.iter().enumerate().filter(|(i, _)| i % workers == wi).map(|(i, c)| (i, board::read_cell(w, img, *c))).collect::<Vec<_>>())
                }).collect();
                for h in hs { for (i, v) in h.join().unwrap() { out[i] = v; } }
            });
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            if run > 0 { times.push(ms); }
            values = cells.iter().zip(out).map(|(c, v)| (format!("{}:{}:{}", board::SIDES[c.side], c.row, c.field), v)).collect();
        }
        times.sort_by(f64::total_cmp);
        let med = times[times.len() / 2];
        let jsf = &js["frames"][f];
        let (mut same, mut diff) = (0, Vec::new());
        for (k, v) in &values {
            let rv = v.as_ref().map_or(serde_json::Value::Null, Value::to_json);
            if jsf["values"][k] == rv { same += 1 } else { diff.push(format!("{k}: js {} rust {}", jsf["values"][k], rv)); }
        }
        println!("{f}: rust median {med:.0} ms (min {:.0}) | js median {:.0} ms | {same}/{} cells identical to JS", times[0], jsf["medianMs"].as_f64().unwrap_or(0.0), values.len());
        for d in &diff { println!("   differs: {d}"); }
        summary.insert(f.into(), serde_json::json!({ "rustMedianMs": med, "jsMedianMs": jsf["medianMs"], "identical": same, "cells": values.len(), "diff": diff }));
    }
    std::fs::write(repo.join("rust/bench/out/rust-board.json"), serde_json::to_string_pretty(&summary)?)?;
    Ok(())
}
