//! Every OCR attempt of one Overwatch cell in Rust (same output as rust/bench/js-ow-cell-trace.cjs).
//!   cargo run --release -p isu-ocr --example ow_cell_trace away 2 assists
use std::path::Path;
use isu_ocr::board::Frame;
use isu_ocr::overwatch as ow;
struct G { w: i32, h: i32, px: Vec<u8> }
impl Frame for G {
    fn lum(&self, x: i32, y: i32) -> u8 { let (x, y) = (x - 640, y - 190); if x < 0 || y < 0 || x >= self.w || y >= self.h { 0 } else { self.px[(y * self.w + x) as usize] } }
    fn rgb(&self, x: i32, y: i32) -> [u8; 3] { let l = self.lum(x, y); [l, l, l] }
}
fn main() -> anyhow::Result<()> {
    let a: Vec<String> = std::env::args().collect();
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut d = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(repo.join("test/fixtures/ow-board-table.png"))?));
    d.set_transformations(png::Transformations::EXPAND);
    let mut r = d.read_info()?; let mut buf = vec![0; r.output_buffer_size().unwrap()]; let info = r.next_frame(&mut buf)?; buf.truncate(info.buffer_size());
    let g = G { w: info.width as i32, h: info.height as i32, px: buf };
    let p = ow::Profile::load(&repo.join("electron"), "default-1080p")?;
    let al = ow::align_board(&g, &p, false);
    let team = if a[1] == "home" { 0 } else { 1 };
    let cell = ow::cell_rois(&p, Some(&al), Some(1.08)).into_iter().find(|c| c.team == team && c.row == a[2].parse::<usize>().unwrap() && c.field == a[3]).unwrap();
    println!("roi {:?} glyphs {}", cell.roi, ow::glyph_count(&g, cell.roi));
    let eng = isu_ocr::tess::unpack_gz_model(&repo.join("node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz"), &repo.join("rust/target/tessdata"), "eng")?;
    let mut t = isu_ocr::tess::Tess::new(&eng, "eng")?;
    for (scale, single) in [(4, false), (4, true), (6, true)] {
        let r = t.recognize(&ow::cell_image(&g, cell.roi, scale, 120, 0.0), &cell.column.allowed, single);
        println!("scale={scale} {} {{\"text\":{:?},\"conf\":{}}}", if single { "char" } else { "line" }, r.text, r.confidence);
    }
    Ok(())
}
