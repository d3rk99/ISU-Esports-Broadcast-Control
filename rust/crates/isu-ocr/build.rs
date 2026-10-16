// Links native Tesseract 5 (C API, tesseract/capi.h).
// Linux: system libtesseract (pkg-config name 'tesseract').
// Windows: set TESSERACT_LIB_DIR to the folder with tesseract55.lib / tesseract.lib (e.g. the
// vcpkg 'tesseract:x64-windows' install, lib/), and put the DLLs next to the exe.
fn main() {
    println!("cargo:rerun-if-env-changed=TESSERACT_LIB_DIR");
    println!("cargo:rerun-if-env-changed=TESSERACT_LIB_NAME");
    if let Ok(dir) = std::env::var("TESSERACT_LIB_DIR") {
        println!("cargo:rustc-link-search=native={dir}");
    }
    let name = std::env::var("TESSERACT_LIB_NAME").unwrap_or_else(|_| if cfg!(windows) { "tesseract55".into() } else { "tesseract".into() });
    println!("cargo:rustc-link-lib=dylib={name}");
}
