//! Thread-owned Windows hotkeys, like Electron's globalShortcut registrations.
#[derive(Clone, Copy)]
#[cfg_attr(not(windows), allow(dead_code))]
pub enum Action { Settings, CursorLock }

pub struct Hotkeys {
    pub events: std::sync::mpsc::Receiver<Action>,
    #[cfg(windows)]
    thread: u32,
    #[cfg(windows)]
    worker: Option<std::thread::JoinHandle<()>>,
}

impl Hotkeys {
    pub fn new(ctx: egui::Context) -> Self {
        let (tx, events) = std::sync::mpsc::channel();
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::Threading::GetCurrentThreadId;
            use windows_sys::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT};
            use windows_sys::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};
            let (ready_tx, ready) = std::sync::mpsc::sync_channel(1);
            let worker = std::thread::spawn(move || unsafe {
                let modifiers = MOD_ALT | MOD_CONTROL | MOD_NOREPEAT;
                let settings = RegisterHotKey(std::ptr::null_mut(), 1, modifiers, u32::from(b'S')) != 0;
                let cursor = RegisterHotKey(std::ptr::null_mut(), 2, modifiers, u32::from(b'L')) != 0;
                if !settings { super::log_line("Ctrl+Alt+S is taken by another app"); }
                if !cursor { super::log_line("Ctrl+Alt+L is taken by another app"); }
                // RegisterHotKey creates this thread's message queue before publishing its id.
                let _ = ready_tx.send(GetCurrentThreadId());
                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                    if msg.message == WM_HOTKEY {
                        let action = match msg.wParam { 1 => Action::Settings, 2 => Action::CursorLock, _ => continue };
                        if tx.send(action).is_err() { break; }
                        ctx.request_repaint();
                    }
                }
                if settings { UnregisterHotKey(std::ptr::null_mut(), 1); }
                if cursor { UnregisterHotKey(std::ptr::null_mut(), 2); }
            });
            Self { events, thread: ready.recv().unwrap_or(0), worker: Some(worker) }
        }
        #[cfg(not(windows))]
        { let _ = (tx, ctx); Self { events } }
    }
}

#[cfg(windows)]
impl Drop for Hotkeys {
    fn drop(&mut self) {
        use windows_sys::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_QUIT};
        if self.thread != 0 {
            unsafe { PostThreadMessageW(self.thread, WM_QUIT, 0, 0); }
            if let Some(worker) = self.worker.take() { let _ = worker.join(); }
        }
    }
}
