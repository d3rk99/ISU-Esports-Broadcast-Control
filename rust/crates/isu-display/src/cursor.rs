//! Keep the mouse on the player monitor: electron/displays/cursor-lock.cjs (Windows ClipCursor,
//! re-applied every 200 ms because games and Windows clear it). Other platforms: no-op.
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Default)]
pub struct CursorLock {
    run: std::sync::Mutex<Option<Arc<AtomicBool>>>,
}

impl CursorLock {
    /// Lock to monitor `index` (1-based, sorted top-to-bottom then left-to-right like the JS),
    /// inset 2 px.
    pub fn lock_display(&self, index: usize) {
        #[cfg(windows)]
        {
            let Some(r) = win::monitor_rect(index) else { return };
            self.lock(r);
        }
        #[cfg(not(windows))]
        let _ = index;
    }

    #[allow(dead_code)]
    pub fn lock(&self, rect: [i32; 4]) {
        self.unlock();
        let flag = Arc::new(AtomicBool::new(true));
        *self.run.lock().unwrap() = Some(Arc::clone(&flag));
        std::thread::spawn(move || {
            while flag.load(Ordering::Acquire) {
                #[cfg(windows)]
                win::clip(Some(rect));
                #[cfg(not(windows))]
                let _ = rect;
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        });
    }

    pub fn unlock(&self) {
        if let Some(f) = self.run.lock().unwrap().take() {
            f.store(false, Ordering::Release);
        }
        #[cfg(windows)]
        win::clip(None);
    }
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct Rect { left: i32, top: i32, right: i32, bottom: i32 }
    #[link(name = "user32")]
    unsafe extern "system" {
        fn ClipCursor(r: *const Rect) -> i32;
        fn EnumDisplayMonitors(hdc: *mut c_void, clip: *const Rect, cb: extern "system" fn(*mut c_void, *mut c_void, *mut Rect, isize) -> i32, data: isize) -> i32;
    }
    pub fn clip(r: Option<[i32; 4]>) {
        unsafe {
            match r {
                Some([l, t, rr, b]) => { ClipCursor(&Rect { left: l, top: t, right: rr, bottom: b }); }
                None => { ClipCursor(std::ptr::null()); }
            }
        }
    }
    extern "system" fn cb(_m: *mut c_void, _dc: *mut c_void, r: *mut Rect, data: isize) -> i32 {
        let v = unsafe { &mut *(data as *mut Vec<[i32; 4]>) };
        let r = unsafe { *r };
        v.push([r.left, r.top, r.right, r.bottom]);
        1
    }
    /// Physical-pixel rect of monitor `index` (1-based), sorted by y then x, inset 2 px.
    pub fn monitor_rect(index: usize) -> Option<[i32; 4]> {
        let mut v: Vec<[i32; 4]> = Vec::new();
        unsafe { EnumDisplayMonitors(std::ptr::null_mut(), std::ptr::null(), cb, &mut v as *mut _ as isize) };
        v.sort_by_key(|r| (r[1], r[0]));
        let r = v.get(index - 1).or_else(|| v.first())?;
        Some([r[0] + 2, r[1] + 2, r[2] - 2, r[3] - 2])
    }
}
