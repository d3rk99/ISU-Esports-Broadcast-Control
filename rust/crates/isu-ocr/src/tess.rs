//! Native Tesseract through its C API (tesseract/capi.h). One `Tess` = one TessBaseAPI = one
//! tesseract.js worker in the JS engine. Engine mode LSTM only (JS: OEM.LSTM_ONLY).
use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::path::Path;

#[allow(non_camel_case_types)]
type TessBaseAPI = c_void;

unsafe extern "C" {
    fn TessBaseAPICreate() -> *mut TessBaseAPI;
    fn TessBaseAPIDelete(h: *mut TessBaseAPI);
    fn TessBaseAPIInit2(h: *mut TessBaseAPI, datapath: *const c_char, language: *const c_char, oem: c_int) -> c_int;
    fn TessBaseAPISetVariable(h: *mut TessBaseAPI, name: *const c_char, value: *const c_char) -> c_int;
    fn TessBaseAPISetPageSegMode(h: *mut TessBaseAPI, mode: c_int);
    fn TessBaseAPISetImage(h: *mut TessBaseAPI, data: *const u8, w: c_int, h_: c_int, bpp: c_int, bpl: c_int);
    fn TessBaseAPISetSourceResolution(h: *mut TessBaseAPI, ppi: c_int);
    fn TessBaseAPIGetUTF8Text(h: *mut TessBaseAPI) -> *mut c_char;
    fn TessBaseAPIMeanTextConf(h: *mut TessBaseAPI) -> c_int;
    fn TessBaseAPIClear(h: *mut TessBaseAPI);
    fn TessDeleteText(t: *const c_char);
}

const OEM_LSTM_ONLY: c_int = 1;
pub const PSM_SINGLE_LINE: c_int = 7;
pub const PSM_SINGLE_CHAR: c_int = 10;

/// An 8-bit grayscale image (black text on white), like the JS P5 / PNG inputs.
pub struct Gray {
    pub w: usize,
    pub h: usize,
    pub px: Vec<u8>,
}

pub struct Tess {
    h: *mut TessBaseAPI,
    whitelist: String,
    psm: c_int,
}

// A TessBaseAPI is used by one thread at a time (each worker owns its own).
unsafe impl Send for Tess {}

#[derive(Debug, Clone)]
pub struct Read {
    pub text: String,
    /// 0..1 like the JS engine (MeanTextConf / 100)
    pub confidence: f64,
}

impl Tess {
    /// `datapath` = folder with `<lang>.traineddata`.
    pub fn new(datapath: &Path, lang: &str) -> anyhow::Result<Self> {
        let dp = CString::new(datapath.to_string_lossy().as_bytes())?;
        let lg = CString::new(lang)?;
        unsafe {
            let h = TessBaseAPICreate();
            if h.is_null() {
                anyhow::bail!("TessBaseAPICreate failed");
            }
            if TessBaseAPIInit2(h, dp.as_ptr(), lg.as_ptr(), OEM_LSTM_ONLY) != 0 {
                TessBaseAPIDelete(h);
                anyhow::bail!("Tesseract could not load '{lang}' from {}", datapath.display());
            }
            let me = Self { h, whitelist: String::new(), psm: -1 };
            // JS recognizeNow: preserve_interword_spaces '0'
            me.var("preserve_interword_spaces", "0");
            // tesseract.js's defaults that differ from the CLI defaults and change results
            me.var("debug_file", if cfg!(windows) { "NUL" } else { "/dev/null" });
            Ok(me)
        }
    }

    fn var(&self, k: &str, v: &str) {
        let (k, v) = (CString::new(k).unwrap(), CString::new(v).unwrap());
        unsafe {
            TessBaseAPISetVariable(self.h, k.as_ptr(), v.as_ptr());
        }
    }

    /// recognizeNow(image, { allowedChars, pageMode }): one line or one char.
    pub fn recognize(&mut self, img: &Gray, allowed: &str, single_char: bool) -> Read {
        if self.whitelist != allowed {
            self.var("tessedit_char_whitelist", allowed);
            self.whitelist = allowed.to_string();
        }
        let psm = if single_char { PSM_SINGLE_CHAR } else { PSM_SINGLE_LINE };
        unsafe {
            if self.psm != psm {
                TessBaseAPISetPageSegMode(self.h, psm);
                self.psm = psm;
            }
            TessBaseAPISetImage(self.h, img.px.as_ptr(), img.w as c_int, img.h as c_int, 1, img.w as c_int);
            // tesseract.js passes PNG/PNM without a resolution, so tesseract assumes 70 ppi
            TessBaseAPISetSourceResolution(self.h, 70);
            let t = TessBaseAPIGetUTF8Text(self.h);
            let text = if t.is_null() { String::new() } else { CStr::from_ptr(t).to_string_lossy().into_owned() };
            if !t.is_null() {
                TessDeleteText(t);
            }
            let conf = TessBaseAPIMeanTextConf(self.h);
            TessBaseAPIClear(self.h);
            Read { text: text.trim().to_string(), confidence: (f64::from(conf) / 100.0).clamp(0.0, 1.0) }
        }
    }
}

impl Drop for Tess {
    fn drop(&mut self) {
        unsafe { TessBaseAPIDelete(self.h) }
    }
}

/// tesseract.js ships eng as eng.traineddata.gz: unpack it once into `cache` and return the folder.
pub fn unpack_gz_model(gz: &Path, cache: &Path, lang: &str) -> anyhow::Result<std::path::PathBuf> {
    let out = cache.join(format!("{lang}.traineddata"));
    if !out.exists() {
        std::fs::create_dir_all(cache)?;
        let mut d = flate2::read::GzDecoder::new(std::fs::File::open(gz)?);
        let tmp = cache.join(format!("{lang}.traineddata.part"));
        std::io::copy(&mut d, &mut std::fs::File::create(&tmp)?)?;
        std::fs::rename(tmp, &out)?;
    }
    Ok(cache.to_path_buf())
}
