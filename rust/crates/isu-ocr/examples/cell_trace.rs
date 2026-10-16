//! Every OCR attempt of one cell in the Rust reader (same output as rust/bench/js-cell-trace.cjs).
//!   cargo run --release -p isu-ocr --example cell_trace val-board-1.png home 0 name
use std::path::Path;
use isu_ocr::board::{self, Frame};
use isu_ocr::tess::{Tess, unpack_gz_model};
struct Img { w: i32, h: i32, rgb: Vec<u8> }
impl Frame for Img {
    fn rgb(&self, x: i32, y: i32) -> [u8; 3] { let (lx, ly) = (x - 500, y - 280); if lx < 0 || ly < 0 || lx >= self.w || ly >= self.h { return [0, 0, 0]; } let o = ((ly * self.w + lx) * 3) as usize; [self.rgb[o], self.rgb[o + 1], self.rgb[o + 2]] }
    fn lum(&self, x: i32, y: i32) -> u8 { let p = self.rgb(x, y); ((f64::from(p[0]) * 0.299 + f64::from(p[1]) * 0.587 + f64::from(p[2]) * 0.114) + 0.5).floor() as u8 }
}
fn main() -> anyhow::Result<()> {
    let a: Vec<String> = std::env::args().collect();
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let d = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(repo.join("test/fixtures").join(&a[1]))?));
    let mut r = d.read_info()?; let mut buf = vec![0; r.output_buffer_size().unwrap()]; let info = r.next_frame(&mut buf)?; let ch = info.color_type.samples();
    let img = Img { w: info.width as i32, h: info.height as i32, rgb: buf[..info.buffer_size()].chunks(ch).flat_map(|c| [c[0], c[1 % ch], c[2 % ch]]).collect() };
    let side = if a[2] == "home" { 0 } else { 1 }; let row: usize = a[3].parse()?;
    let al = board::align_board(&img);
    let cell = board::cell_rois(&al).into_iter().find(|c| c.side == side && c.row == row && c.field == a[4]).unwrap();
    println!("roi {:?}", cell.roi);
    let eng = unpack_gz_model(&repo.join("node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz"), &repo.join("rust/target/tessdata"), "eng")?;
    let mut t = if cell.column.lang == Some("val") { Tess::new(&repo.join("electron/ocr-models"), "val")? } else { Tess::new(&eng, "eng")? };
    for (thr, scale) in [(175u8, 4), (150, 4), (130, 4)] {
        let r = t.recognize(&board::cell_image(&img, cell.roi, scale, thr), cell.column.allowed, false);
        println!("try thr={thr} scale={scale} {{\"text\":{:?},\"conf\":{}}}", r.text, r.confidence);
    }
    Ok(())
}
