//! Rust Overwatch service sweep on Derk's real board (same as rust/bench/js-ow-sweep.cjs).
//!   cargo run --release -p isu-ocr --example ow_bench [runs] [workers]
use std::path::Path;
use std::sync::Arc;
use isu_ocr::capture::{Bgra, Source};
struct Fake(Bgra);
impl Source for Fake { fn capture(&self, _w: &str, _f: u32, _n: Option<u64>) -> Result<Bgra, String> { let mut f = self.0.clone(); f.captured_at = std::time::Instant::now(); Ok(f) } }
fn main() -> anyhow::Result<()> {
    let runs: usize = std::env::args().nth(1).and_then(|v| v.parse().ok()).unwrap_or(5);
    let workers: usize = std::env::args().nth(2).and_then(|v| v.parse().ok()).unwrap_or(4);
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut d = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(repo.join("test/fixtures/ow-board-table.png"))?));
    d.set_transformations(png::Transformations::EXPAND);
    let mut r = d.read_info()?; let mut buf = vec![0; r.output_buffer_size().unwrap()]; let info = r.next_frame(&mut buf)?; let ch = info.color_type.samples();
    let mut px = vec![0u8; 1920 * 1080 * 4];
    for y in 0..info.height as usize { for x in 0..info.width as usize { let g = buf[(y * info.width as usize + x) * ch]; let o = ((y + 190) * 1920 + x + 640) * 4; px[o..o + 4].copy_from_slice(&[g, g, g, 255]); } }
    let frame = Bgra { w: 1920, h: 1080, px: Arc::new(px), source_w: 1920, source_h: 1080, normalized: false, source_name: "Overwatch".into(), captured_at: std::time::Instant::now(), seq: 1 };
    let eng = isu_ocr::tess::unpack_gz_model(&repo.join("node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz"), &repo.join("rust/target/tessdata"), "eng")?;
    let models = isu_ocr::ow_service::Models { eng_dir: eng, ow_dir: repo.join("electron/ocr-models"), data_dir: repo.join("electron") };
    let svc = isu_ocr::ow_service::OverwatchService::new(Arc::new(Fake(frame)), models, Box::new(|_| {}), Box::new(|_| {}))?;
    svc.configure(&serde_json::json!({ "enabled": false, "workers": workers }));
    let mut times = Vec::new();
    for i in 0..=runs {
        let t0 = std::time::Instant::now();
        svc.sweep().map_err(anyhow::Error::msg)?;
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        if i > 0 { times.push(ms); }
        std::thread::sleep(std::time::Duration::from_millis(950)); // heroes are read every 900 ms in both
    }
    times.sort_by(f64::total_cmp);
    println!("Rust Overwatch sweep ({workers} workers): median {:.0} ms (min {:.0})", times[times.len() / 2], times[0]);
    Ok(())
}
