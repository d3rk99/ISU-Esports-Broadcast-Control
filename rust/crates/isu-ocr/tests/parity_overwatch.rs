//! Overwatch parity with the real JS (parity-overwatch.json, rust/scripts/parity-overwatch.cjs):
//! Derk's 3 real boards (normal / perks / player view) -> header, align, every cell box, glyph
//! counts, the exact OCR input image (sha256), ult rings; 20 hero portraits; READY discs; parsing;
//! consensus sweeps.
use std::path::Path;

use isu_ocr::board::Frame;
use isu_ocr::overwatch::{self as ow, Profile};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn repo() -> std::path::PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..") }
fn cases() -> Value { serde_json::from_str(include_str!("parity-overwatch.json")).unwrap() }
fn n(x: f64) -> Value { isu_core::game_config::jnum(x) }

fn decode(p: &Path) -> (i32, i32, usize, Vec<u8>) {
    let mut d = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(p).unwrap()));
    d.set_transformations(png::Transformations::EXPAND);
    let mut r = d.read_info().unwrap(); let mut buf = vec![0; r.output_buffer_size().unwrap()]; let info = r.next_frame(&mut buf).unwrap();
    buf.truncate(info.buffer_size());
    (info.width as i32, info.height as i32, info.color_type.samples(), buf)
}
/// Grey image placed at (ox, oy); test/png.cjs readGray conversion for RGB.
struct G { w: i32, h: i32, px: Vec<u8>, ox: i32, oy: i32 }
impl G { fn open(rel: &str, ox: i32, oy: i32) -> Self { let (w, h, ch, b) = decode(&repo().join(rel)); let px = b.chunks(ch).map(|c| if ch <= 2 { c[0] } else { ((u32::from(c[0]) * 19595 + u32::from(c[1]) * 38470 + u32::from(c[2]) * 7471 + 0x8000) >> 16) as u8 }).collect(); Self { w, h, px, ox, oy } } }
impl Frame for G {
    fn lum(&self, x: i32, y: i32) -> u8 { let (x, y) = (x - self.ox, y - self.oy); if x < 0 || y < 0 || x >= self.w || y >= self.h { 0 } else { self.px[(y * self.w + x) as usize] } }
    fn rgb(&self, x: i32, y: i32) -> [u8; 3] { let l = self.lum(x, y); [l, l, l] }
}

fn header_json(h: &Option<ow::Header>) -> Value {
    h.as_ref().map_or(Value::Null, |h| { let mut m = serde_json::Map::new(); for (k, v) in &h.cols { m.insert(k.clone(), json!(v)); } m.insert("leftDx".into(), json!(h.left_dx)); Value::Object(m) })
}

#[test]
fn overwatch_boards_match_js() {
    let c = cases();
    let p = Profile::load(&repo().join("electron"), "default-1080p").unwrap();
    let mut fails = Vec::new();
    for b in c["boards"].as_array().unwrap() {
        let f = b["file"].as_str().unwrap();
        let g = G::open(f, b["ox"].as_i64().unwrap() as i32, b["oy"].as_i64().unwrap() as i32);
        let h = ow::header_columns(&g, &p);
        if header_json(&h) != b["header"] { fails.push(format!("{f} header rust {} js {}", header_json(&h), b["header"])); }
        let a = ow::align_board(&g, &p, false);
        let ja = &b["align"];
        if json!([a.dx, a.left_dx, a.perks, a.view]) != json!([ja["dx"], ja["leftDx"], ja["perks"], ja["view"]]) { fails.push(format!("{f} align rust {:?} js {}", (a.dx, a.left_dx, a.perks, a.view), json!([ja["dx"], ja["leftDx"], ja["perks"], ja["view"]]))); }
        for (ti, team) in ["home", "away"].iter().enumerate() { for r in 0..5 {
            let ra = &a.rows[ti][r]; let jr = &ja["rows"][format!("{team}:{r}")];
            let got = json!({ "statDy": ra.stat_dy, "nameDy": ra.name_dy, "nameX": ra.name_x, "nameRight": ra.name_right });
            let want = json!({ "statDy": jr["statDy"], "nameDy": jr["nameDy"], "nameX": jr["nameX"], "nameRight": jr["nameRight"] });
            if got != want { fails.push(format!("{f} {team}:{r} row rust {got} js {want}")); }
        } }
        let cells = ow::cell_rois(&p, Some(&a), Some(1.08));
        for (cell, want) in cells.iter().zip(b["cells"].as_array().unwrap()) {
            let label = format!("{f} {}:{}:{}", want["side"], want["row"], want["field"]);
            let roi = json!({ "x": cell.roi.x, "y": cell.roi.y, "w": cell.roi.w, "h": cell.roi.h });
            if roi != want["roi"] || cell.field != want["field"] { fails.push(format!("{label} roi rust {roi} js {}", want["roi"])); continue; }
            if cell.field != "name" && json!(ow::glyph_count(&g, cell.roi)) != want["glyphs"] { fails.push(format!("{label} glyphs rust {} js {}", ow::glyph_count(&g, cell.roi), want["glyphs"])); }
            let img = ow::cell_image(&g, cell.roi, want["scale"].as_i64().unwrap() as i32, want["thr"].as_u64().unwrap() as u8, want["shear"].as_f64().unwrap());
            let hex = Sha256::digest(&img.px).iter().map(|x| format!("{x:02x}")).collect::<String>();
            if hex != want["img"] { fails.push(format!("{label} OCR image differs")); }
        }
        for (i, u) in b["ult"].as_array().unwrap().iter().enumerate() {
            let (ti, r) = (i / 5, i % 5);
            let dy = a.rows[ti][r].stat_dy; let cy = f64::from(p.teams[ti].1[r] + if dy.abs() >= 3 { dy } else { 0 });
            let rcx = p.ring_cx + f64::from(a.left_dx);
            let got = json!({ "ready": ow::is_ready_disc(&g, rcx, cy + p.ring_dy, p.ready_radius), "fill": n(ow::ring_fill(&g, rcx, cy + p.ring_dy, p.ring_radius)) });
            if &got != u { fails.push(format!("{f} ult {i} rust {got} js {u}")); }
        }
    }
    assert!(fails.is_empty(), "{} differences:\n{}", fails.len(), fails.iter().take(30).cloned().collect::<Vec<_>>().join("\n"));
}

struct Strip { w: i32, rgb: Vec<u8>, i: i32 }
impl Frame for Strip {
    fn rgb(&self, x: i32, y: i32) -> [u8; 3] { let (sx, sy) = (x - 580, y - 500 + self.i * 60 + 30); let o = ((sy * self.w + sx) * 3) as usize; [self.rgb[o], self.rgb[o + 1], self.rgb[o + 2]] }
    fn lum(&self, _x: i32, _y: i32) -> u8 { 0 }
}
struct Flat;
impl Frame for Flat { fn rgb(&self, _x: i32, _y: i32) -> [u8; 3] { [40, 40, 40] } fn lum(&self, _x: i32, _y: i32) -> u8 { 40 } }

fn hero_json(m: &ow::HeroMatch) -> Value { json!({ "hero": m.hero, "candidate": m.candidate, "score": n(m.score), "runnerUp": n(m.runner_up), "gap": n(m.gap) }) }

#[test]
fn heroes_rings_parse_consensus_match_js() {
    let c = cases();
    let hm = ow::HeroMatcher::load(&repo().join("electron")).unwrap();
    let (w, _h, ch, buf) = decode(&repo().join("test/fixtures/ow-hero-portraits.png"));
    let rgb: Vec<u8> = buf.chunks(ch).flat_map(|p| [p[0], p[1 % ch], p[2 % ch]]).collect();
    for (i, want) in c["heroes"].as_array().unwrap().iter().enumerate() {
        let m = hm.match_row(&Strip { w, rgb: rgb.clone(), i: i as i32 }, 500, 0);
        assert_eq!(hero_json(&m), *want, "hero row {}", i + 1);
    }
    assert_eq!(hero_json(&hm.match_row(&Flat, 500, 0)), c["heroBlank"], "blank window");
    for r in c["rings"].as_array().unwrap() {
        let g = G::open(&format!("test/fixtures/{}", r["file"].as_str().unwrap()), 0, 0);
        assert_eq!(json!({ "disc": n(ow::disc_fill(&g, 30.0, 30.0, 12.0)), "ready": ow::is_ready_disc(&g, 30.0, 30.0, 12.0), "ring": n(ow::ring_fill(&g, 30.0, 30.0, 16.0)) }), json!({ "disc": r["disc"], "ready": r["ready"], "ring": r["ring"] }), "{}", r["file"]);
    }
    for pc in c["parse"].as_array().unwrap() {
        let v = ow::parse_cell(pc["field"].as_str().unwrap(), pc["text"].as_str().unwrap()).unwrap_or(Value::Null);
        assert_eq!(v, pc["value"], "parseCell {pc}");
    }
    let mut bd = ow::empty_board(); let mut con = ow::Consensus::default();
    for (i, s) in c["consensus"].as_array().unwrap().iter().enumerate() {
        let reads: Vec<ow::Read> = s["sweep"].as_array().unwrap().iter().map(|r| ow::Read { side: r[0].as_str().unwrap().into(), row: r[1].as_u64().unwrap() as usize, field: r[2].as_str().unwrap().into(), value: Some(r[3].clone()) }).collect();
        let ch = ow::apply_sweep(&mut bd, &mut con, &reads, s["now"].as_f64().unwrap());
        assert_eq!(json!(ch), s["changed"], "sweep {i}");
        assert_eq!(bd, s["board"], "sweep {i}");
    }
}
