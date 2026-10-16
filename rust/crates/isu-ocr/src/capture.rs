//! Window capture: electron/valorant-native-capture.cjs (Windows Graphics Capture) +
//! electron/valorant-capture.cjs (captureSizeCheck, frameLuminance, frameRgb).
//! A frame is normalised to the 1920x1080 grid every ROI is defined on.
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::board::Frame;

pub const EXPECTED_W: u32 = 1920;
pub const EXPECTED_H: u32 = 1080;
const ASPECT_TOLERANCE: f64 = 0.01;
const MIN_CAPTURE_HEIGHT: u32 = 720;

/// captureSizeCheck(width, height, expected..., tolerance) -> Ok(normalized) | Err(message).
pub fn size_check(w: u32, h: u32, tolerance: u32) -> Result<bool, String> {
    let (dw, dh) = (w.abs_diff(EXPECTED_W), h.abs_diff(EXPECTED_H));
    if dw <= tolerance && dh <= tolerance {
        return Ok(dw != 0 || dh != 0);
    }
    let expected = f64::from(EXPECTED_W) / f64::from(EXPECTED_H);
    let aspect = f64::from(w) / f64::from(h);
    let same = (aspect - expected).abs() / expected <= ASPECT_TOLERANCE;
    if same && h >= MIN_CAPTURE_HEIGHT {
        return Ok(true);
    }
    Err(if same {
        format!("VALORANT capture is {w}×{h}; below {MIN_CAPTURE_HEIGHT}p the HUD text is too small to read")
    } else {
        format!("VALORANT capture is {w}×{h}; use a 16:9 source (1920×1080 recommended)")
    })
}

/// A captured frame on the 1920x1080 grid, BGRA like the JS bitmap.
#[derive(Clone)]
pub struct Bgra {
    pub w: u32,
    pub h: u32,
    pub px: Arc<Vec<u8>>,
    pub source_w: u32,
    pub source_h: u32,
    pub normalized: bool,
    pub source_name: String,
    pub captured_at: Instant,
    pub seq: u64,
}

impl std::fmt::Debug for Bgra {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Bgra({}x{} from {}x{} '{}' #{})", self.w, self.h, self.source_w, self.source_h, self.source_name, self.seq)
    }
}

impl Frame for Bgra {
    /// frameLuminance: Math.round(B*0.114 + G*0.587 + R*0.299), 0 outside.
    fn lum(&self, x: i32, y: i32) -> u8 {
        if x < 0 || y < 0 || x as u32 >= self.w || y as u32 >= self.h {
            return 0;
        }
        let o = (y as usize * self.w as usize + x as usize) * 4;
        let p = &self.px;
        ((f64::from(p[o]) * 0.114 + f64::from(p[o + 1]) * 0.587 + f64::from(p[o + 2]) * 0.299) + 0.5).floor() as u8
    }
    /// frameRgb: [R, G, B], black outside.
    fn rgb(&self, x: i32, y: i32) -> [u8; 3] {
        if x < 0 || y < 0 || x as u32 >= self.w || y as u32 >= self.h {
            return [0, 0, 0];
        }
        let o = (y as usize * self.w as usize + x as usize) * 4;
        [self.px[o + 2], self.px[o + 1], self.px[o]]
    }
}

/// Bilinear resize of a BGRA buffer to 1920x1080 (the JS uses nativeImage.resize quality 'best').
pub fn resize_bgra(src: &[u8], sw: u32, sh: u32) -> Vec<u8> {
    let (dw, dh) = (EXPECTED_W as usize, EXPECTED_H as usize);
    let mut out = vec![0u8; dw * dh * 4];
    let (fx, fy) = (f64::from(sw) / dw as f64, f64::from(sh) / dh as f64);
    for y in 0..dh {
        let sy = ((y as f64 + 0.5) * fy - 0.5).max(0.0);
        let (y0, ty) = (sy.floor() as usize, sy.fract());
        let y1 = (y0 + 1).min(sh as usize - 1);
        for x in 0..dw {
            let sx = ((x as f64 + 0.5) * fx - 0.5).max(0.0);
            let (x0, tx) = (sx.floor() as usize, sx.fract());
            let x1 = (x0 + 1).min(sw as usize - 1);
            for c in 0..4 {
                let p = |xx: usize, yy: usize| f64::from(src[(yy * sw as usize + xx) * 4 + c]);
                let v = p(x0, y0) * (1.0 - tx) * (1.0 - ty) + p(x1, y0) * tx * (1.0 - ty) + p(x0, y1) * (1.0 - tx) * ty + p(x1, y1) * tx * ty;
                out[(y * dw + x) * 4 + c] = (v + 0.5).floor() as u8;
            }
        }
    }
    out
}

/// Turns one raw frame into the normalised frame (packedBgraBuffer + size check + resize).
pub fn normalize(raw: &[u8], w: u32, h: u32, row_pitch: u32, name: &str, seq: u64) -> Result<Bgra, String> {
    if w == 0 || h == 0 {
        return Err(format!("The selected “{name}” window returned an empty native frame"));
    }
    let normalized = size_check(w, h, 2)?;
    let packed_row = (w * 4) as usize;
    let pitch = if row_pitch == 0 { packed_row } else { row_pitch as usize };
    if pitch < packed_row || raw.len() < pitch * h as usize {
        return Err("Windows Graphics Capture returned an invalid bitmap stride".into());
    }
    let mut packed = Vec::with_capacity(packed_row * h as usize);
    for row in 0..h as usize {
        packed.extend_from_slice(&raw[row * pitch..row * pitch + packed_row]);
    }
    let px = if normalized { resize_bgra(&packed, w, h) } else { packed };
    Ok(Bgra { w: EXPECTED_W, h: EXPECTED_H, px: Arc::new(px), source_w: w, source_h: h, normalized, source_name: name.to_string(), captured_at: Instant::now(), seq })
}

/// Latest-frame mailbox shared by the capture thread and the readers (latestFrame + waiters).
#[derive(Default)]
pub struct Mailbox {
    slot: Mutex<(Option<Bgra>, Option<String>)>, // (frame, session error)
    cv: Condvar,
}

impl Mailbox {
    pub fn put(&self, f: Bgra) {
        let mut g = self.slot.lock().unwrap();
        g.0 = Some(f);
        self.cv.notify_all();
    }
    pub fn fail(&self, e: String) {
        let mut g = self.slot.lock().unwrap();
        g.1 = Some(e);
        self.cv.notify_all();
    }
    /// capture(): a frame younger than 1.5 s (and newer than `after`), else wait up to 2 s.
    pub fn take(&self, after: Option<u64>, timeout: Duration, title: &str) -> Result<Bgra, String> {
        let deadline = Instant::now() + timeout;
        let mut g = self.slot.lock().unwrap();
        loop {
            if let Some(e) = &g.1 {
                return Err(e.clone());
            }
            if let Some(f) = &g.0 {
                if Some(f.seq) != after && f.captured_at.elapsed() < Duration::from_millis(1500) {
                    return Ok(f.clone());
                }
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(format!("Windows Graphics Capture timed out waiting for “{title}”"));
            }
            g = self.cv.wait_timeout(g, deadline - now).unwrap().0;
        }
    }
}

/// A capture source the readers pull frames from.
pub trait Source: Send + Sync {
    /// The newest frame of the window whose title contains `window` (case-insensitive).
    fn capture(&self, window: &str, fps: u32, newer_than: Option<u64>) -> Result<Bgra, String>;
    fn stop(&self) {}
}

/// selectWindow: exact title (case-insensitive) first, else the first title containing it.
pub fn select_window<'a>(titles: &'a [(isize, String)], window: &str) -> Option<&'a (isize, String)> {
    let needle = {
        let n = window.trim().to_lowercase();
        if n.is_empty() { "valorant".to_string() } else { n }
    };
    titles.iter().find(|(_, t)| t.to_lowercase() == needle).or_else(|| titles.iter().find(|(_, t)| t.to_lowercase().contains(&needle)))
}

#[cfg(windows)]
pub use wgc::WgcSource;

#[cfg(windows)]
mod wgc {
    //! Windows Graphics Capture session per window (same rules as NativeValorantWindowCapture):
    //! one session per window handle, restarted for a new window or a faster fps, cursor off,
    //! BGRA, minimum update interval = 1000 / fps (>= 16 ms).
    use super::*;
    use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
    use windows_capture::frame::Frame as WFrame;
    use windows_capture::graphics_capture_api::InternalCaptureControl;
    use windows_capture::settings::{ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings};
    use windows_capture::window::Window;

    struct Handler {
        mail: Arc<Mailbox>,
        name: String,
        seq: u64,
    }

    impl GraphicsCaptureApiHandler for Handler {
        type Flags = (Arc<Mailbox>, String);
        type Error = Box<dyn std::error::Error + Send + Sync>;
        fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
            Ok(Self { mail: ctx.flags.0, name: ctx.flags.1, seq: 0 })
        }
        fn on_frame_arrived(&mut self, frame: &mut WFrame, _c: InternalCaptureControl) -> Result<(), Self::Error> {
            let mut buf = frame.buffer()?;
            let (w, h, pitch) = (buf.width(), buf.height(), buf.row_pitch());
            self.seq += 1;
            match normalize(buf.as_raw_buffer(), w, h, pitch, &self.name, self.seq) {
                Ok(f) => self.mail.put(f),
                Err(e) => self.mail.fail(e),
            }
            Ok(())
        }
        fn on_closed(&mut self) -> Result<(), Self::Error> {
            self.mail.fail(format!("Windows Graphics Capture closed for “{}”", self.name));
            Ok(())
        }
    }

    struct Session {
        title: String,
        fps: u32,
        mail: Arc<Mailbox>,
        control: Option<windows_capture::capture::CaptureControl<Handler, Box<dyn std::error::Error + Send + Sync>>>,
    }

    #[derive(Default)]
    pub struct WgcSource {
        session: Mutex<Option<Session>>,
    }

    impl WgcSource {
        fn start(&self, window: &str, fps: u32) -> Result<Arc<Mailbox>, String> {
            let wins = Window::enumerate().map_err(|e| e.to_string())?;
            let titles: Vec<(isize, String)> = wins.iter().enumerate().filter(|(_, w)| w.is_valid()).filter_map(|(i, w)| w.title().ok().filter(|t| !t.is_empty()).map(|t| (i as isize, t))).collect();
            let (idx, title) = select_window(&titles, window).cloned().ok_or_else(|| format!("Window containing “{}” was not found", if window.is_empty() { "VALORANT" } else { window }))?;
            let mut g = self.session.lock().unwrap();
            if let Some(s) = g.as_ref() {
                if s.title == title && s.fps >= fps {
                    return Ok(Arc::clone(&s.mail));
                }
            }
            if let Some(mut old) = g.take() {
                if let Some(c) = old.control.take() {
                    let _ = c.stop();
                }
            }
            let mail = Arc::new(Mailbox::default());
            let interval = Duration::from_millis(u64::from((1000 / fps.max(1)).max(16)));
            let settings = Settings::new(
                wins[idx as usize],
                CursorCaptureSettings::WithoutCursor,
                DrawBorderSettings::WithoutBorder,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Custom(interval),
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                (Arc::clone(&mail), title.clone()),
            );
            let control = Handler::start_free_threaded(settings).map_err(|e| format!("Windows Graphics Capture could not start for “{title}”: {e}"))?;
            *g = Some(Session { title, fps, mail: Arc::clone(&mail), control: Some(control) });
            Ok(mail)
        }
    }

    impl Source for WgcSource {
        fn capture(&self, window: &str, fps: u32, newer_than: Option<u64>) -> Result<Bgra, String> {
            let mail = self.start(window, fps.max(1))?;
            let r = mail.take(newer_than, Duration::from_secs(2), window);
            if r.is_err() {
                // a failed session is started again on the next call (JS sessionError -> new session)
                if let Some(mut s) = self.session.lock().unwrap().take() {
                    if let Some(c) = s.control.take() {
                        let _ = c.stop();
                    }
                }
            }
            r
        }
        fn stop(&self) {
            if let Some(mut s) = self.session.lock().unwrap().take() {
                if let Some(c) = s.control.take() {
                    let _ = c.stop();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_check_like_js() {
        assert_eq!(size_check(1920, 1080, 2), Ok(false));
        assert_eq!(size_check(1921, 1079, 2), Ok(true));
        assert_eq!(size_check(2560, 1440, 2), Ok(true));
        assert_eq!(size_check(1280, 720, 2), Ok(true));
        assert!(size_check(1024, 576, 2).unwrap_err().contains("below 720p"));
        assert!(size_check(1920, 1200, 2).unwrap_err().contains("16:9"));
    }

    #[test]
    fn normalize_strips_row_padding_and_scales() {
        // 2560x1440 with 16 bytes of padding per row, every pixel B=10 G=20 R=30
        let (w, h, pitch) = (2560u32, 1440u32, 2560 * 4 + 16);
        let mut raw = vec![0u8; (pitch * h) as usize];
        for y in 0..h as usize {
            for x in 0..w as usize {
                let o = y * pitch as usize + x * 4;
                raw[o..o + 4].copy_from_slice(&[10, 20, 30, 255]);
            }
        }
        let f = normalize(&raw, w, h, pitch, "VALORANT", 1).unwrap();
        assert!(f.normalized && f.w == 1920 && f.h == 1080 && f.px.len() == 1920 * 1080 * 4);
        assert_eq!(f.rgb(100, 100), [30, 20, 10]);
        assert_eq!(f.lum(5000, 5), 0);
        assert!(normalize(&raw, w, h, 100, "V", 1).unwrap_err().contains("stride"));
    }

    #[test]
    fn select_window_exact_then_contains() {
        let t = vec![(1, "VALORANT - Spectator".to_string()), (2, "valorant".to_string()), (3, "Discord".to_string())];
        assert_eq!(select_window(&t, "VALORANT").unwrap().0, 2);
        assert_eq!(select_window(&t, "spectator").unwrap().0, 1);
        assert_eq!(select_window(&t, "").unwrap().0, 2);
        assert!(select_window(&t, "Overwatch").is_none());
    }

    #[test]
    fn mailbox_waits_for_a_newer_frame() {
        let m = Arc::new(Mailbox::default());
        let raw = vec![0u8; 1920 * 1080 * 4];
        m.put(normalize(&raw, 1920, 1080, 0, "V", 1).unwrap());
        assert_eq!(m.take(None, Duration::from_millis(50), "V").unwrap().seq, 1);
        assert!(m.take(Some(1), Duration::from_millis(50), "V").unwrap_err().contains("timed out"));
        let m2 = Arc::clone(&m);
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            m2.put(normalize(&vec![0u8; 1920 * 1080 * 4], 1920, 1080, 0, "V", 2).unwrap());
        });
        assert_eq!(m.take(Some(1), Duration::from_secs(1), "V").unwrap().seq, 2);
        t.join().unwrap();
    }
}
