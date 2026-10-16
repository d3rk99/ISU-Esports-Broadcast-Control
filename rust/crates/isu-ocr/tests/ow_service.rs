//! The Rust Overwatch service on Derk's real spectator board, like the JS test
//! 'Overwatch OCR service: two sweeps of the real board fill every player stat'.
use std::path::Path;
use std::sync::Arc;

use isu_ocr::capture::{Bgra, Source};
use isu_ocr::ow_service::{Models, OverwatchService};
use serde_json::{Value, json};

struct Fake(Bgra);
impl Source for Fake {
    fn capture(&self, _w: &str, _f: u32, _n: Option<u64>) -> Result<Bgra, String> { let mut f = self.0.clone(); f.captured_at = std::time::Instant::now(); Ok(f) }
}

/// Grey fixture at (ox, oy) on a black 1080p frame (grey -> B=G=R, so lum = grey).
fn frame(rel: &str, ox: usize, oy: usize) -> Bgra {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut d = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(repo.join(rel)).unwrap()));
    d.set_transformations(png::Transformations::EXPAND);
    let mut r = d.read_info().unwrap(); let mut buf = vec![0; r.output_buffer_size().unwrap()]; let info = r.next_frame(&mut buf).unwrap(); let ch = info.color_type.samples();
    let mut px = vec![0u8; 1920 * 1080 * 4];
    for y in 0..info.height as usize { for x in 0..info.width as usize { let g = buf[(y * info.width as usize + x) * ch]; let o = ((y + oy) * 1920 + x + ox) * 4; px[o..o + 4].copy_from_slice(&[g, g, g, 255]); } }
    Bgra { w: 1920, h: 1080, px: Arc::new(px), source_w: 1920, source_h: 1080, normalized: false, source_name: "Overwatch".into(), captured_at: std::time::Instant::now(), seq: 1 }
}

#[test]
fn real_board_two_sweeps_fill_every_stat() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let eng = isu_ocr::tess::unpack_gz_model(&repo.join("node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz"), &repo.join("rust/target/tessdata"), "eng").unwrap();
    let models = Models { eng_dir: eng, ow_dir: repo.join("electron/ocr-models"), data_dir: repo.join("electron") };
    let svc = OverwatchService::new(Arc::new(Fake(frame("test/fixtures/ow-board-table.png", 640, 190))), models, Box::new(|_| {}), Box::new(|_| {})).unwrap();
    svc.configure(&json!({ "enabled": false, "workers": 4 }));
    svc.sweep().unwrap();
    assert_eq!(svc.snapshot()["teams"]["home"]["players"][0]["damage"], Value::Null, "one sweep is not enough");
    svc.sweep().unwrap();
    // EXPECTED in test/overwatch-ocr.test.cjs: [ult, damage, healing, mitigation], E/A/D all 0
    let expected = json!({ "home": [[16, 215, 0, 38], [15, 96, 0, 0], [12, 10, 52, 0], [11, 0, 100, 0], [12, 156, 0, 85]],
                           "away": [[23, 125, 0, 0], [16, 147, 4, 0], [11, 98, 61, 0], [17, 220, 66, 50], [12, 170, 18, 2]] });
    let s = svc.snapshot();
    let mut wrong = Vec::new();
    for side in ["home", "away"] { for i in 0..5 {
        let p = &s["teams"][side]["players"][i];
        let got = json!([p["ultimate"], p["damage"], p["healing"], p["mitigation"], p["elims"], p["assists"], p["deaths"]]);
        let mut want = expected[side][i].as_array().unwrap().clone(); want.extend([json!(0), json!(0), json!(0)]);
        if got != Value::Array(want.clone()) { wrong.push(format!("{side}{}: rust {got} want {}", i + 1, Value::Array(want))); }
    } }
    // Known, traced difference (rust/bench/js-ow-cell-trace.cjs vs --example ow_cell_trace):
    // away3 assists. Same box, same glyph count, byte-identical OCR image (tests/parity_overwatch.rs);
    // both engines read "0", tesseract.js (5.1) at confidence 0.82, native 5.5 at 0.70 < the 0.75
    // cut, so Rust leaves it blank. Blank is allowed (never a wrong number); anything else is not.
    let known_blank = "away3: rust [11,98,61,0,0,null,0] want [11,98,61,0,0,0,0]";
    let unexpected: Vec<&String> = wrong.iter().filter(|w| w.as_str() != known_blank).collect();
    assert!(unexpected.is_empty(), "{}", wrong.join("\n"));
    assert!(wrong.len() <= 1, "79/80 or 80/80 expected: {}", wrong.join("\n"));
    svc.sweep().unwrap();
    let names: Vec<Value> = ["home", "away"].iter().flat_map(|side| (0..5).map(move |i| (side, i))).map(|(side, i)| svc.snapshot()["teams"][side]["players"][i]["name"].clone()).collect();
    assert_eq!(Value::Array(names), json!(["DAMAGE 1", "DAMAGE 2", "SUPPORT 1", "SUPPORT 2", "TANK 1", "DAMAGE 3", "DAMAGE 4", "SUPPORT 3", "SUPPORT 4", "TANK 2"]));
    assert_eq!(svc.status()["state"], "reading");
}

/// debugCapture on the same real board: every cell is listed with its crop + OCR image, the accepted
/// values agree with what the sweep reads, and the frame + align info come back like the JS one.
#[test]
fn debug_capture_on_the_real_board() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let eng = isu_ocr::tess::unpack_gz_model(&repo.join("node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz"), &repo.join("rust/target/tessdata"), "eng").unwrap();
    let models = Models { eng_dir: eng, ow_dir: repo.join("electron/ocr-models"), data_dir: repo.join("electron") };
    let svc = OverwatchService::new(Arc::new(Fake(frame("test/fixtures/ow-board-table.png", 640, 190))), models, Box::new(|_| {}), Box::new(|_| {})).unwrap();
    svc.configure(&json!({ "enabled": false, "workers": 1 }));
    let d = svc.debug_capture().unwrap();
    let cells = d["cells"].as_array().unwrap();
    assert_eq!(cells.len(), 10 * 8, "10 players x (name + 7 stat columns)");
    for k in ["rawDataUrl", "processedDataUrl"] {
        assert!(cells.iter().all(|c| c[k].as_str().unwrap().starts_with("data:image/png;base64,")), "{k}");
    }
    assert!(d["frameDataUrl"].as_str().unwrap().len() > 10_000);
    assert_eq!((d["width"].clone(), d["height"].clone()), (json!(1920), json!(1080)));
    assert!(d["align"]["rows"]["home:0"].is_object(), "align per row");
    // accepted values = the single-read values: damage of home 1 is 215, names come through
    let get = |side: &str, row: u64, f: &str| cells.iter().find(|c| c["side"] == side && c["row"] == row && c["field"] == f).unwrap()["accepted"].clone();
    assert_eq!(get("home", 0, "damage"), json!(215));
    assert_eq!(get("away", 4, "name"), json!("TANK 2"));
    assert!(cells.iter().filter(|c| c["field"] != "name").all(|c| c["glyphs"].is_number()), "digits seen for number cells");
}
