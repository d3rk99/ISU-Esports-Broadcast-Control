//! Game mirror: show this PC's player monitor (display.js startMirror: desktop capture of the
//! player display at up to 60 fps). Windows: Windows Graphics Capture of monitor `index`.
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::ndi::Frame;

#[derive(Default)]
pub struct Mirror {
    frame: Arc<Mutex<Option<Frame>>>,
    epoch: Arc<AtomicU64>,
    pub error: Arc<Mutex<String>>,
}

impl Mirror {
    pub fn frame(&self) -> Option<Frame> {
        self.frame.lock().unwrap().clone()
    }

    pub fn start(&self, index: usize) {
        let epoch = self.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        *self.frame.lock().unwrap() = None;
        #[cfg(windows)]
        win::start(index, epoch, Arc::clone(&self.epoch), Arc::clone(&self.frame), Arc::clone(&self.error));
        #[cfg(not(windows))]
        {
            let _ = (index, epoch);
            *self.error.lock().unwrap() = "Game mirror needs Windows (Windows Graphics Capture)".into();
        }
    }

    pub fn stop(&self) {
        self.epoch.fetch_add(1, Ordering::AcqRel);
        *self.frame.lock().unwrap() = None;
    }
}

#[cfg(windows)]
mod win {
    use super::*;
    use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
    use windows_capture::frame::Frame as WFrame;
    use windows_capture::graphics_capture_api::InternalCaptureControl;
    use windows_capture::monitor::Monitor;
    use windows_capture::settings::{ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings};

    type Flags = (u64, Arc<AtomicU64>, Arc<Mutex<Option<Frame>>>);
    struct H { epoch: u64, live: Arc<AtomicU64>, out: Arc<Mutex<Option<Frame>>>, seq: u64 }
    impl GraphicsCaptureApiHandler for H {
        type Flags = Flags;
        type Error = Box<dyn std::error::Error + Send + Sync>;
        fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> { Ok(Self { epoch: ctx.flags.0, live: ctx.flags.1, out: ctx.flags.2, seq: 0 }) }
        fn on_frame_arrived(&mut self, frame: &mut WFrame, c: InternalCaptureControl) -> Result<(), Self::Error> {
            if self.live.load(Ordering::Acquire) != self.epoch { c.stop(); return Ok(()); }
            let mut b = frame.buffer()?;
            let (w, h) = (b.width() as usize, b.height() as usize);
            let mut tmp = Vec::new();
            let px = b.as_nopadding_buffer(&mut tmp).to_vec();
            self.seq += 1;
            *self.out.lock().unwrap() = Some(Frame { width: w, height: h, rgba: Arc::new(px), seq: self.seq });
            Ok(())
        }
    }
    pub fn start(index: usize, epoch: u64, live: Arc<AtomicU64>, out: Arc<Mutex<Option<Frame>>>, err: Arc<Mutex<String>>) {
        let mons = Monitor::enumerate().unwrap_or_default();
        let Some(m) = mons.get(index.saturating_sub(1)).or_else(|| mons.first()).copied() else { *err.lock().unwrap() = "Player monitor not found".into(); return };
        let s = Settings::new(m, CursorCaptureSettings::WithCursor, DrawBorderSettings::WithoutBorder, SecondaryWindowSettings::Default, MinimumUpdateIntervalSettings::Custom(std::time::Duration::from_millis(16)), DirtyRegionSettings::Default, ColorFormat::Rgba8, (epoch, live, out));
        if let Err(e) = H::start_free_threaded(s) { *err.lock().unwrap() = e.to_string(); }
    }
}
