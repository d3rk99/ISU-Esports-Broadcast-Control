//! HUD reader parity with the real JS on 154 real images (parity-hud.json, rust/scripts/parity-hud.cjs).
use std::path::Path;
use isu_ocr::board::Frame;
use isu_ocr::hud::HudReader;
use serde_json::{Value, json};

struct G { w: i32, h: i32, px: Vec<u8>, ox: i32, oy: i32 }
impl Frame for G {
    fn lum(&self, x: i32, y: i32) -> u8 { let (x, y) = (x - self.ox, y - self.oy); if x < 0 || y < 0 || x >= self.w || y >= self.h { 0 } else { self.px[(y * self.w + x) as usize] } }
    fn rgb(&self, x: i32, y: i32) -> [u8; 3] { let l = self.lum(x, y); [l, l, l] }
}

/// test/png.cjs readGray: grey stays, RGB -> PIL L ((R*19595 + G*38470 + B*7471 + 0x8000) >> 16).
fn gray(p: &Path) -> (i32, i32, Vec<u8>) {
    let mut d = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(p).unwrap()));
    d.set_transformations(png::Transformations::EXPAND);
    let mut r = d.read_info().unwrap(); let mut buf = vec![0; r.output_buffer_size().unwrap()]; let info = r.next_frame(&mut buf).unwrap();
    let ch = info.color_type.samples();
    let px = buf[..info.buffer_size()].chunks(ch).map(|c| if ch <= 2 { c[0] } else { ((u32::from(c[0]) * 19595 + u32::from(c[1]) * 38470 + u32::from(c[2]) * 7471 + 0x8000) >> 16) as u8 }).collect();
    (info.width as i32, info.height as i32, px)
}

#[test]
fn hud_matches_js_on_154_real_images() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let reader = HudReader::load(&repo.join("electron")).unwrap();
    let cases: Value = serde_json::from_str(include_str!("parity-hud.json")).unwrap();
    let mut fails = Vec::new();
    for c in cases.as_array().unwrap() {
        let (w, h, px) = gray(&repo.join(c["file"].as_str().unwrap()));
        let g = G { w, h, px, ox: c["ox"].as_i64().unwrap() as i32, oy: c["oy"].as_i64().unwrap() as i32 };
        let r = reader.read(&g, 0, 0);
        let timer = r.timer.map_or(Value::Null, |t| json!({ "seconds": isu_core::game_config::jnum(t.seconds), "display": t.display, "lowTime": t.low_time }));
        let got = json!({ "homeScore": r.home_score, "awayScore": r.away_score, "timer": timer });
        if got != c["result"] { fails.push(format!("{}: rust {got} js {}", c["file"], c["result"])); }
    }
    assert!(fails.is_empty(), "{} of {} differ:\n{}", fails.len(), cases.as_array().unwrap().len(), fails.join("\n"));
}
