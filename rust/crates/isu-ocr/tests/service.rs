//! The Rust board service on Derk's real frame, through full sweeps (consensus), like the JS test
//! 'VALORANT board service: real board through full sweeps' (test/valorant-board.test.cjs).
use std::path::Path;
use std::sync::{Arc, Mutex};

use isu_ocr::capture::{Bgra, Source};
use isu_ocr::service::{BoardService, dev_models};
use serde_json::{Value, json};

/// A fake window: Derk's 920x480 board crop pasted at (500, 280) of a black 1920x1080 frame.
struct FakeWindow(Bgra);
impl Source for FakeWindow {
    fn capture(&self, _w: &str, _fps: u32, _n: Option<u64>) -> Result<Bgra, String> { let mut f = self.0.clone(); f.captured_at = std::time::Instant::now(); Ok(f) }
}

fn fake(file: &str) -> Bgra {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let d = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(repo.join("test/fixtures").join(file)).unwrap()));
    let mut r = d.read_info().unwrap(); let mut buf = vec![0; r.output_buffer_size().unwrap()]; let info = r.next_frame(&mut buf).unwrap(); let ch = info.color_type.samples();
    let mut px = vec![0u8; 1920 * 1080 * 4];
    for y in 0..info.height as usize { for x in 0..info.width as usize {
        let s = (y * info.width as usize + x) * ch; let o = ((y + 280) * 1920 + x + 500) * 4;
        px[o] = buf[s + 2 % ch]; px[o + 1] = buf[s + 1 % ch]; px[o + 2] = buf[s]; px[o + 3] = 255;
    } }
    Bgra { w: 1920, h: 1080, px: Arc::new(px), source_w: 1920, source_h: 1080, normalized: false, source_name: "VALORANT".into(), captured_at: std::time::Instant::now(), seq: 1 }
}

#[test]
fn real_board_through_full_sweeps() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let models = dev_models(&repo, &repo.join("rust/target/tessdata")).unwrap();
    let states: Arc<Mutex<Vec<Value>>> = Arc::default();
    let s2 = Arc::clone(&states);
    let svc = BoardService::new(Arc::new(FakeWindow(fake("val-board-2.png"))), models, Box::new(move |v| s2.lock().unwrap().push(v)), Box::new(|_| {}));
    svc.configure(&json!({ "enabled": false, "workers": 4 }));
    svc.sweep().unwrap();
    let snap = svc.snapshot();
    assert_eq!(snap["teams"]["home"]["players"][0]["kills"], Value::Null, "one sweep is not enough to show a value");
    svc.sweep().unwrap();
    svc.sweep().unwrap();
    let s = svc.snapshot();
    let p = |side: &str, i: usize| s["teams"][side]["players"][i].clone();
    let agents: Vec<Value> = ["home", "away"].iter().flat_map(|side| (0..5).map(move |i| (side, i))).map(|(side, i)| p(side, i)["agent"].clone()).collect();
    assert_eq!(Value::Array(agents), json!(["viper", "astra", "yoru", "jett", "sova", "neon", "viper", "astra", "tejo", "sova"]));
    assert_eq!((p("home", 0)["kills"].clone(), p("home", 0)["deaths"].clone(), p("home", 0)["assists"].clone()), (json!(3), json!(0), json!(0)));
    assert_eq!(p("away", 1)["weapon"], "guardian"); assert_eq!(p("away", 1)["shield"], "regen");
    assert_eq!(p("home", 2)["shield"], "light"); assert_eq!(p("home", 3)["weapon"], "bucky");
    assert_eq!(svc.status()["state"], "reading");
    assert!(s["align"]["dx"].as_i64().unwrap() <= -12, "found the shifted board: {}", s["align"]);
    assert_eq!(s["colors"], json!({ "home": "teal", "away": "red" }));
    assert!(!states.lock().unwrap().is_empty());
}
