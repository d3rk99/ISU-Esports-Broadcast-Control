//! NDI receiver: electron/displays/ndi-receiver.cjs. Finds a source by name (mDNS + extra IPs),
//! receives RGBX/RGBA, keeps the newest frame; source gone = retry every 2 s; 10 s without a
//! frame = reconnect. The NDI runtime is loaded at run time (Processing.NDI.Lib.x64.dll /
//! libndi.so), like the JS bundle: a missing runtime is a status, not a crash.
use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// matches(sourceName, wanted): exact, or "MACHINE (wanted)".
pub fn matches(source: &str, wanted: &str) -> bool {
    source == wanted || source.ends_with(&format!("({wanted})"))
}

#[repr(C)]
struct FindCreate {
    show_local_sources: bool,
    p_groups: *const c_char,
    p_extra_ips: *const c_char,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct Source {
    p_ndi_name: *const c_char,
    p_url_address: *const c_char,
}
#[repr(C)]
struct RecvCreateV3 {
    source: Source,
    color_format: c_int,
    bandwidth: c_int,
    allow_video_fields: bool,
    p_ndi_recv_name: *const c_char,
}
#[repr(C)]
struct VideoFrameV2 {
    xres: c_int,
    yres: c_int,
    fourcc: u32,
    frame_rate_n: c_int,
    frame_rate_d: c_int,
    picture_aspect_ratio: f32,
    frame_format_type: c_int,
    timecode: i64,
    p_data: *mut u8,
    line_stride_in_bytes: c_int,
    p_metadata: *const c_char,
    timestamp: i64,
}

const COLOR_RGBX_RGBA: c_int = 2;
const BANDWIDTH_HIGHEST: c_int = 100;
const FRAME_VIDEO: c_int = 1;
const FRAME_ERROR: c_int = 4;

struct Lib {
    _lib: libloading::Library,
    initialize: unsafe extern "C" fn() -> bool,
    find_create: unsafe extern "C" fn(*const FindCreate) -> *mut c_void,
    find_destroy: unsafe extern "C" fn(*mut c_void),
    find_wait: unsafe extern "C" fn(*mut c_void, u32) -> bool,
    find_current: unsafe extern "C" fn(*mut c_void, *mut u32) -> *const Source,
    recv_create: unsafe extern "C" fn(*const RecvCreateV3) -> *mut c_void,
    recv_destroy: unsafe extern "C" fn(*mut c_void),
    recv_capture: unsafe extern "C" fn(*mut c_void, *mut VideoFrameV2, *mut c_void, *mut c_void, u32) -> c_int,
    recv_free_video: unsafe extern "C" fn(*mut c_void, *const VideoFrameV2),
}

/// Where the runtime is looked for: next to the exe, NDI_RUNTIME_DIR_V6/V5, then the system path.
fn load() -> Result<Lib, String> {
    let name = if cfg!(windows) { "Processing.NDI.Lib.x64.dll" } else if cfg!(target_os = "macos") { "libndi.dylib" } else { "libndi.so.6" };
    let mut tries: Vec<std::path::PathBuf> = Vec::new();
    if let Some(d) = std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())) {
        tries.push(d.join(name));
    }
    for v in ["NDI_RUNTIME_DIR_V6", "NDI_RUNTIME_DIR_V5"] {
        if let Some(d) = std::env::var_os(v) {
            tries.push(std::path::PathBuf::from(d).join(name));
        }
    }
    tries.push(name.into());
    if !cfg!(windows) {
        tries.push("libndi.so".into());
    }
    let mut last = String::new();
    for p in tries {
        match unsafe { libloading::Library::new(&p) } {
            Ok(lib) => unsafe {
                let sym = |n: &[u8]| -> Result<*const c_void, String> { lib.get::<*const c_void>(n).map(|s| *s).map_err(|e| e.to_string()) };
                let l = Lib {
                    initialize: std::mem::transmute(sym(b"NDIlib_initialize\0")?),
                    find_create: std::mem::transmute(sym(b"NDIlib_find_create_v2\0")?),
                    find_destroy: std::mem::transmute(sym(b"NDIlib_find_destroy\0")?),
                    find_wait: std::mem::transmute(sym(b"NDIlib_find_wait_for_sources\0")?),
                    find_current: std::mem::transmute(sym(b"NDIlib_find_get_current_sources\0")?),
                    recv_create: std::mem::transmute(sym(b"NDIlib_recv_create_v3\0")?),
                    recv_destroy: std::mem::transmute(sym(b"NDIlib_recv_destroy\0")?),
                    recv_capture: std::mem::transmute(sym(b"NDIlib_recv_capture_v2\0")?),
                    recv_free_video: std::mem::transmute(sym(b"NDIlib_recv_free_video_v2\0")?),
                    _lib: lib,
                };
                if !(l.initialize)() {
                    return Err("NDI runtime could not initialise (unsupported CPU?)".into());
                }
                return Ok(l);
            },
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("NDI library could not load ({last}). This build is missing the bundled NDI runtime: put {name} next to the exe, or install the NDI Runtime from ndi.video."))
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Status {
    pub state: String,
    pub error: String,
    pub source: String,
    pub fps: u32,
}

/// Newest frame: RGBA, tightly packed.
#[derive(Clone)]
pub struct Frame {
    pub width: usize,
    pub height: usize,
    pub rgba: Arc<Vec<u8>>,
    pub seq: u64,
}

pub struct Receiver {
    epoch: Arc<AtomicU64>,
    pub frame: Arc<Mutex<Option<Frame>>>,
    on_status: Arc<dyn Fn(Status) + Send + Sync>,
}

impl Receiver {
    pub fn new(on_status: Arc<dyn Fn(Status) + Send + Sync>) -> Self {
        Self { epoch: Arc::new(AtomicU64::new(0)), frame: Arc::new(Mutex::new(None)), on_status }
    }

    /// start({ source, hosts }): stops the old receiver first.
    pub fn start(&self, wanted: &str, hosts: &[String]) {
        let epoch = self.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        let (ep, frame, st) = (Arc::clone(&self.epoch), Arc::clone(&self.frame), Arc::clone(&self.on_status));
        let wanted = wanted.to_string();
        let hosts = hosts.iter().filter(|h| !h.is_empty()).cloned().collect::<Vec<_>>().join(",");
        std::thread::spawn(move || {
            let lib = match load() {
                Ok(l) => l,
                Err(e) => return st(Status { state: "error".into(), error: e, source: wanted, fps: 0 }),
            };
            let live = || ep.load(Ordering::Acquire) == epoch;
            let name = CString::new("ISU Display Client").unwrap();
            let extra = CString::new(hosts).unwrap();
            while live() {
                st(Status { state: "searching".into(), error: String::new(), source: wanted.clone(), fps: 0 });
                let fc = FindCreate { show_local_sources: true, p_groups: std::ptr::null(), p_extra_ips: if extra.as_bytes().is_empty() { std::ptr::null() } else { extra.as_ptr() } };
                let finder = unsafe { (lib.find_create)(&fc) };
                let mut found: Option<(CString, Option<CString>, String)> = None;
                for _ in 0..10 {
                    if found.is_some() || !live() || finder.is_null() {
                        break;
                    }
                    unsafe { (lib.find_wait)(finder, 500) };
                    let mut n = 0u32;
                    let list = unsafe { (lib.find_current)(finder, &mut n) };
                    for i in 0..n as usize {
                        let s = unsafe { *list.add(i) };
                        if s.p_ndi_name.is_null() {
                            continue;
                        }
                        let nm = unsafe { CStr::from_ptr(s.p_ndi_name) }.to_string_lossy().into_owned();
                        if matches(&nm, &wanted) {
                            let url = (!s.p_url_address.is_null()).then(|| unsafe { CStr::from_ptr(s.p_url_address) }.to_owned());
                            found = Some((CString::new(nm.clone()).unwrap(), url, nm));
                            break;
                        }
                    }
                }
                // copy the source before the finder (which owns its strings) is destroyed
                if !finder.is_null() {
                    unsafe { (lib.find_destroy)(finder) };
                }
                if !live() {
                    return;
                }
                let Some((cname, curl, shown)) = found else {
                    st(Status { state: "error".into(), error: format!("NDI source \"{wanted}\" not found"), source: wanted.clone(), fps: 0 });
                    std::thread::sleep(Duration::from_secs(2));
                    continue;
                };
                let rc = RecvCreateV3 { source: Source { p_ndi_name: cname.as_ptr(), p_url_address: curl.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()) }, color_format: COLOR_RGBX_RGBA, bandwidth: BANDWIDTH_HIGHEST, allow_video_fields: false, p_ndi_recv_name: name.as_ptr() };
                let recv = unsafe { (lib.recv_create)(&rc) };
                if recv.is_null() {
                    st(Status { state: "error".into(), error: "NDI receiver could not be created".into(), source: wanted.clone(), fps: 0 });
                    std::thread::sleep(Duration::from_secs(2));
                    continue;
                }
                st(Status { state: "receiving".into(), error: String::new(), source: shown.clone(), fps: 0 });
                let (mut frames, mut since, mut idle, mut seq) = (0u32, Instant::now(), 0, 0u64);
                while live() {
                    let mut vf: VideoFrameV2 = unsafe { std::mem::zeroed() };
                    let t = unsafe { (lib.recv_capture)(recv, &mut vf, std::ptr::null_mut(), std::ptr::null_mut(), 1000) };
                    if t == FRAME_ERROR {
                        break; // connection lost
                    }
                    if t != FRAME_VIDEO || vf.p_data.is_null() {
                        idle += 1;
                        if idle >= 10 {
                            break; // graphics that don't change send few frames; give up after 10 s
                        }
                        continue;
                    }
                    idle = 0;
                    frames += 1;
                    seq += 1;
                    let (w, h, stride) = (vf.xres as usize, vf.yres as usize, vf.line_stride_in_bytes as usize);
                    let mut rgba = Vec::with_capacity(w * h * 4);
                    for y in 0..h {
                        let row = unsafe { std::slice::from_raw_parts(vf.p_data.add(y * stride), w * 4) };
                        rgba.extend_from_slice(row);
                    }
                    unsafe { (lib.recv_free_video)(recv, &vf) };
                    // RGBX: X is not alpha; show it opaque
                    for px in rgba.chunks_mut(4) {
                        px[3] = 255;
                    }
                    *frame.lock().unwrap() = Some(Frame { width: w, height: h, rgba: Arc::new(rgba), seq });
                    if since.elapsed() >= Duration::from_secs(2) {
                        let fps = (f64::from(frames) * 1000.0 / since.elapsed().as_millis() as f64).round() as u32;
                        st(Status { state: "receiving".into(), error: String::new(), source: shown.clone(), fps });
                        frames = 0;
                        since = Instant::now();
                    }
                }
                unsafe { (lib.recv_destroy)(recv) };
                if live() {
                    st(Status { state: "searching".into(), error: "NDI feed lost, reconnecting".into(), source: wanted.clone(), fps: 0 });
                }
            }
        });
    }

    pub fn stop(&self) {
        self.epoch.fetch_add(1, Ordering::AcqRel);
    }
}
