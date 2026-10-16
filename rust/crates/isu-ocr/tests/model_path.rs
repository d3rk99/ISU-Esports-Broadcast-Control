//! Installed Windows roots are canonicalized before being passed to Tesseract.
use std::path::Path;

#[test]
fn tesseract_loads_model_from_canonical_path() {
    let models = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../electron/ocr-models")
        .canonicalize().unwrap();
    isu_ocr::tess::Tess::new(&models, "val").unwrap();
}
