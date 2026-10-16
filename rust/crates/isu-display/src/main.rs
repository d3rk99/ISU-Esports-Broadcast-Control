//! ISU Display Client (station PC) in Rust + egui: electron/displays/display-client-main.cjs +
//! client/index.html/display.js (full-screen output) + client/settings.html/settings.js.
//! Modes from the controller: mirror (show this PC's player monitor) / ndi (show an NDI source).
//! Ctrl+Alt+S opens settings, Ctrl+Alt+L toggles the cursor lock. Crash log: display-client.log.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod cursor;
mod hotkeys;
mod mirror;
mod monitors;
mod ndi;
mod noise;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use eframe::egui::{self, Color32, RichText};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

const VERSION: &str = env!("CARGO_PKG_VERSION");

// ---- config ------------------------------------------------------------------------------

fn user_data() -> PathBuf {
    std::env::var_os("DISPLAY_CLIENT_USER_DATA").map(PathBuf::from).unwrap_or_else(|| dirs::config_dir().unwrap_or_default().join("ISU Display Client"))
}
fn config_path() -> PathBuf {
    std::env::var_os("DISPLAY_CLIENT_CONFIG").map(PathBuf::from).unwrap_or_else(|| user_data().join("display-client.json"))
}
fn log_line(text: &str) {
    use std::io::Write;
    let _ = std::fs::create_dir_all(user_data());
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(user_data().join("display-client.log")) {
        let _ = writeln!(f, "[{}] {text}", iso_now());
    }
}
fn iso_now() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let (secs, msec) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let (days, tod) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{msec:03}Z", tod / 3600, tod % 3600 / 60, tod % 60)
}

/// normalize(raw): display-client-main.cjs.
pub fn normalize(raw: &Value) -> Value {
    use isu_core::game_config::{js_round, js_string, to_number, truthy};
    let s = |k: &str| raw.get(k).filter(|v| truthy(Some(v))).map(|v| js_string(Some(v))).unwrap_or_default();
    let num = |k: &str, d: f64| to_number(raw.get(k)).filter(|x| *x != 0.0).unwrap_or(d);
    let cut = |x: String, n: usize| String::from_utf16_lossy(&x.encode_utf16().take(n).collect::<Vec<u16>>());
    let mut controller = s("controller").trim().to_string();
    // .replace(/^https?:\/\//, '') is case-sensitive in the JS (no i flag)
    for p in ["https://", "http://"] {
        if let Some(rest) = controller.strip_prefix(p) {
            controller = rest.to_string();
            break;
        }
    }
    if let Some(i) = controller.find('/') {
        controller.truncate(i);
    }
    let controller = cut(controller, 255);
    let max_vol = match raw.get("noiseMaxVolume") {
        None | Some(Value::Null) => 60.0,
        v => to_number(v).unwrap_or(f64::NAN),
    };
    json!({
        "station": js_round(num("station", 1.0)).clamp(1.0, 10.0) as i64,
        "controller": if controller.is_empty() { "127.0.0.1".to_string() } else { controller },
        "port": js_round(num("port", 3178.0)).clamp(1.0, 65535.0) as i64,
        "key": cut(s("key").trim().to_string(), 200),
        "ndiHost": cut(s("ndiHost").trim().to_string(), 255),
        "playerDisplay": js_round(num("playerDisplay", 1.0)).max(1.0) as i64,
        "stageDisplay": js_round(num("stageDisplay", 2.0)).max(1.0) as i64,
        "cursorLock": raw.get("cursorLock") == Some(&json!(true)),
        "startWithWindows": raw.get("startWithWindows") != Some(&json!(false)),
        "noiseDevice": cut(s("noiseDevice"), 300),
        "noiseDeviceLabel": cut(s("noiseDeviceLabel"), 200),
        "noiseMaxVolume": if max_vol.is_nan() { Value::Null } else { json!(js_round(max_vol).clamp(0.0, 100.0) as i64) }
    })
}

/// loadConfig(): saved file + --key=value command line args.
fn load_config() -> Value {
    let mut saved: Value = std::fs::read_to_string(config_path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}));
    if !saved.is_object() {
        saved = json!({});
    }
    for arg in std::env::args().skip(1) {
        if let Some(rest) = arg.strip_prefix("--") {
            if let Some((k, v)) = rest.split_once('=') {
                if !k.is_empty() && k.chars().all(|c| c.is_ascii_alphabetic()) {
                    saved[k] = json!(v);
                }
            }
        }
    }
    normalize(&saved)
}

fn save_config(cfg: &Value) {
    let _ = std::fs::create_dir_all(config_path().parent().unwrap());
    let tmp = config_path().with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_string_pretty(cfg).unwrap()).is_ok() {
        let _ = std::fs::rename(tmp, config_path());
    }
    apply_start_with_windows(cfg);
}

/// Start with Windows (HKCU Run key, --startup), like app.setLoginItemSettings.
fn apply_start_with_windows(cfg: &Value) {
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
        let on = cfg["startWithWindows"].as_bool().unwrap_or(true);
        let args: Vec<String> = if on {
            vec!["add".into(), r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run".into(), "/v".into(), "ISU Display Client".into(), "/t".into(), "REG_SZ".into(), "/d".into(), format!("\"{exe}\" --startup"), "/f".into()]
        } else {
            vec!["delete".into(), r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run".into(), "/v".into(), "ISU Display Client".into(), "/f".into()]
        };
        let ok = std::process::Command::new("reg").args(&args).output().map(|o| o.status.success()).unwrap_or(false);
        log_line(&format!("start with Windows: {} ({exe}){}", if on { "on" } else { "off" }, if ok || !on { "" } else { " failed" }));
    }
    #[cfg(not(windows))]
    let _ = cfg;
}

// ---- shared state ------------------------------------------------------------------------

#[derive(Default)]
struct Live {
    cfg: Value,
    mode: (String, String),
    link: (String, String),
    ndi: ndi::Status,
    noise: (bool, f64),
    noise_status: Option<noise::Status>,
    out_tx: Option<tokio::sync::mpsc::UnboundedSender<String>>,
}

struct Shared {
    live: Mutex<Live>,
    ndi: ndi::Receiver,
    noise: noise::Noise,
    mirror: mirror::Mirror,
    cursor: cursor::CursorLock,
    reconnect: tokio::sync::Notify,
    ctx: Mutex<Option<egui::Context>>,
}

impl Shared {
    fn repaint(&self) {
        if let Some(c) = self.ctx.lock().unwrap().as_ref() {
            c.request_repaint();
        }
    }

    /// reportStatus(): status to the controller.
    fn report(&self) {
        let l = self.live.lock().unwrap();
        let Some(tx) = l.out_tx.as_ref() else { return };
        let state = if l.mode.0 == "mirror" { "mirror".to_string() } else { l.ndi.state.clone() };
        let ns = l.noise_status.clone().unwrap_or(noise::Status { state: "off".into(), device: String::new(), error: String::new() });
        let _ = tx.send(json!({ "type": "status", "mode": l.mode.0, "source": l.mode.1, "state": state, "error": l.ndi.error, "fps": l.ndi.fps, "noise": { "state": ns.state, "device": ns.device, "error": ns.error } }).to_string());
    }

    /// applyMode(next).
    fn apply_mode(&self, mode: &str, source: &str) {
        let mode = if mode == "mirror" { "mirror" } else { "ndi" };
        let cfg = self.live.lock().unwrap().cfg.clone();
        self.live.lock().unwrap().mode = (mode.to_string(), source.to_string());
        if mode == "ndi" {
            self.mirror.stop();
            let src = if source.is_empty() { format!("ISU Stage {:02}", cfg["station"].as_i64().unwrap_or(1)) } else { source.to_string() };
            let hosts: Vec<String> = [cfg["ndiHost"].as_str().unwrap_or(""), cfg["controller"].as_str().unwrap_or("")].iter().filter(|h| !h.is_empty()).map(|h| h.to_string()).collect();
            self.ndi.start(&src, &hosts);
        } else {
            self.ndi.stop();
            self.live.lock().unwrap().ndi = ndi::Status { state: "idle".into(), ..Default::default() };
            self.mirror.start(cfg["playerDisplay"].as_i64().unwrap_or(1) as usize);
        }
        self.report();
        self.repaint();
    }

    /// applyNoise(next).
    fn apply_noise(&self, msg: &Value) {
        let cur = self.live.lock().unwrap().noise.1;
        let on = isu_core::game_config::truthy(msg.get("on"));
        let vol = match msg.get("volume") {
            None | Some(Value::Null) => cur,
            v => isu_core::game_config::to_number(v).filter(|x| *x != 0.0).map_or(0.0, isu_core::game_config::js_round).clamp(0.0, 100.0),
        };
        self.live.lock().unwrap().noise = (on, vol);
        log_line(&if on { format!("pink noise on {vol}%") } else { "pink noise off".into() });
        self.noise.set(on, Some(vol));
        self.repaint();
    }

    fn apply_noise_device(&self) {
        let cfg = self.live.lock().unwrap().cfg.clone();
        self.noise.set_device(cfg["noiseDevice"].as_str().unwrap_or(""), cfg["noiseDeviceLabel"].as_str().unwrap_or(""), cfg["noiseMaxVolume"].as_f64().unwrap_or(60.0));
    }

    fn apply_cursor_lock(&self) {
        let cfg = self.live.lock().unwrap().cfg.clone();
        if cfg["cursorLock"] == true {
            self.cursor.lock_display(cfg["playerDisplay"].as_i64().unwrap_or(1) as usize);
        } else {
            self.cursor.unlock();
        }
    }
}

/// connect(): ws://controller:port/display, hello, reconnect 1 s doubling to 10 s.
async fn link_loop(sh: Arc<Shared>) {
    let mut delay = Duration::from_secs(1);
    loop {
        let cfg = sh.live.lock().unwrap().cfg.clone();
        let url = format!("ws://{}:{}/display", cfg["controller"].as_str().unwrap_or("127.0.0.1"), cfg["port"]);
        sh.live.lock().unwrap().link = ("connecting".into(), String::new());
        sh.repaint();
        let mut why = String::new();
        let conn = tokio::time::timeout(Duration::from_secs(5), tokio_tungstenite::connect_async(&url)).await;
        if let Ok(Ok((ws, _))) = conn {
            delay = Duration::from_secs(1);
            let (mut wtx, mut wrx) = ws.split();
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
            let hostname = hostname();
            let mode = sh.live.lock().unwrap().mode.clone();
            let _ = wtx.send(Message::Text(json!({ "type": "hello", "station": cfg["station"], "hostname": hostname, "version": VERSION, "key": cfg["key"], "mode": mode.0, "source": mode.1 }).to_string().into())).await;
            sh.live.lock().unwrap().out_tx = Some(tx);
            let mut status = tokio::time::interval(Duration::from_secs(2));
            loop {
                tokio::select! {
                    m = wrx.next() => match m {
                        Some(Ok(Message::Text(t))) => {
                            let Ok(msg) = serde_json::from_str::<Value>(&t) else { continue };
                            match msg["type"].as_str() {
                                Some("welcome") => { sh.live.lock().unwrap().link = ("connected".into(), String::new()); sh.repaint(); }
                                Some("mode") => sh.apply_mode(msg["mode"].as_str().unwrap_or("ndi"), &isu_core::game_config::js_string(Some(&msg["source"])).replace("null", "")),
                                Some("noise") => sh.apply_noise(&msg),
                                _ => {}
                            }
                        }
                        Some(Ok(Message::Close(f))) => {
                            if let Some(f) = f {
                                let code = u16::from(f.code);
                                why = if code == 4003 { "Display key rejected: check the key in settings".into() } else if code == 4009 { f.reason.to_string() } else { String::new() };
                            }
                            break;
                        }
                        None | Some(Err(_)) => break,
                        _ => {}
                    },
                    out = rx.recv() => match out { Some(t) => { if wtx.send(Message::Text(t.into())).await.is_err() { break; } } None => break },
                    _ = status.tick() => sh.report(),
                    _ = sh.reconnect.notified() => break,
                }
            }
            sh.live.lock().unwrap().out_tx = None;
        }
        sh.live.lock().unwrap().link = ("disconnected".into(), why);
        sh.repaint();
        // keep showing whatever we had (an NDI feed keeps running without the controller)
        tokio::select! { _ = tokio::time::sleep(delay) => {}, _ = sh.reconnect.notified() => {} }
        delay = (delay * 2).min(Duration::from_secs(10));
    }
}

/// os.hostname(): COMPUTERNAME on Windows, else gethostname(2).
fn hostname() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMPUTERNAME").unwrap_or_default()
    }
    #[cfg(unix)]
    {
        unsafe extern "C" {
            fn gethostname(name: *mut std::ffi::c_char, len: usize) -> std::ffi::c_int;
        }
        let mut buf = [0 as std::ffi::c_char; 256];
        if unsafe { gethostname(buf.as_mut_ptr(), buf.len()) } != 0 {
            return String::new();
        }
        unsafe { std::ffi::CStr::from_ptr(buf.as_ptr()) }.to_string_lossy().into_owned()
    }
}

// ---- UI ------------------------------------------------------------------------------------

struct App {
    sh: Arc<Shared>,
    _rt: tokio::runtime::Runtime,
    tex: Option<(egui::TextureHandle, u64)>,
    settings: bool,
    form: Value,
    saved_at: Option<std::time::Instant>,
    devices: Vec<String>,
    hotkeys: hotkeys::Hotkeys,
    placed: bool,
}

impl App {
    fn new(cc: &eframe::CreationContext<'_>) -> Self {
        cc.egui_ctx.set_visuals(egui::Visuals::dark());
        let cfg = load_config();
        log_line(&format!("config {} ", { let mut c = cfg.clone(); if c["key"] != "" { c["key"] = json!("(set)"); } c }));
        let sh: Arc<Shared> = Arc::new_cyclic(|w: &std::sync::Weak<Shared>| {
            let w2 = w.clone();
            Shared {
                live: Mutex::new(Live { cfg: cfg.clone(), mode: ("ndi".into(), String::new()), link: ("disconnected".into(), String::new()), noise: (false, 30.0), ..Default::default() }),
                ndi: ndi::Receiver::new(Arc::new(move |st: ndi::Status| {
                    if let Some(s) = w2.upgrade() {
                        let prev = s.live.lock().unwrap().ndi.error.clone();
                        if !st.error.is_empty() && st.error != prev { log_line(&format!("ndi: {}", st.error)); }
                        s.live.lock().unwrap().ndi = st;
                        s.report();
                        s.repaint();
                    }
                })),
                noise: noise::Noise::new(),
                mirror: mirror::Mirror::default(),
                cursor: cursor::CursorLock::default(),
                reconnect: tokio::sync::Notify::new(),
                ctx: Mutex::new(Some(cc.egui_ctx.clone())),
            }
        });
        let w = Arc::downgrade(&sh);
        sh.noise.on_status(move |st| {
            if let Some(s) = w.upgrade() {
                if !st.error.is_empty() { log_line(&format!("pink noise: {}", st.error)); }
                s.live.lock().unwrap().noise_status = Some(st);
                s.report();
            }
        });
        sh.apply_noise_device();
        sh.apply_cursor_lock();
        apply_start_with_windows(&cfg);
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().worker_threads(2).build().expect("runtime");
        sh.apply_mode("ndi", ""); // NDI by default, before the controller answers
        rt.spawn(link_loop(Arc::clone(&sh)));
        log_line("ready");
        Self { sh, _rt: rt, tex: None, settings: false, form: cfg, saved_at: None, devices: noise::Noise::devices(), hotkeys: hotkeys::Hotkeys::new(cc.egui_ctx.clone()), placed: false }
    }

    fn output(&mut self, ui: &mut egui::Ui) {
        let (mode, link, ndi_st, cfg) = { let l = self.sh.live.lock().unwrap(); (l.mode.clone(), l.link.clone(), l.ndi.clone(), l.cfg.clone()) };
        let frame = if mode.0 == "ndi" { self.sh.ndi.frame.lock().unwrap().clone() } else { self.sh.mirror.frame() };
        let rect = ui.max_rect();
        ui.painter().rect_filled(rect, 0.0, Color32::BLACK);
        let live = frame.is_some();
        if let Some(f) = frame {
            if self.tex.as_ref().is_none_or(|(_, s)| *s != f.seq) {
                let img = egui::ColorImage::from_rgba_unmultiplied([f.width, f.height], &f.rgba);
                match &mut self.tex {
                    Some((t, s)) => { t.set(img, egui::TextureOptions::LINEAR); *s = f.seq; }
                    None => self.tex = Some((ui.ctx().load_texture("out", img, egui::TextureOptions::LINEAR), f.seq)),
                }
            }
            if let Some((t, _)) = &self.tex {
                // contain: keep aspect, centred
                let (fw, fh) = (f.width as f32, f.height as f32);
                let k = (rect.width() / fw).min(rect.height() / fh);
                let size = egui::vec2(fw * k, fh * k);
                let r = egui::Rect::from_center_size(rect.center(), size);
                ui.painter().image(t.id(), r, egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)), Color32::WHITE);
            }
        }
        // paint(): station title + the first problem
        let mut problems = Vec::new();
        if link.0 != "connected" { problems.push(if link.1.is_empty() { "Controller not connected".to_string() } else { link.1.clone() }); }
        if mode.0 == "ndi" && ndi_st.state != "receiving" {
            problems.push(if ndi_st.error.is_empty() { format!("Looking for {}…", if !ndi_st.source.is_empty() { &ndi_st.source } else if !mode.1.is_empty() { &mode.1 } else { "NDI feed" }) } else { ndi_st.error.clone() });
        }
        if !live {
            let station = format!("STATION {:02}", cfg["station"].as_i64().unwrap_or(1));
            let detail = problems.first().cloned().unwrap_or_else(|| if mode.0 == "mirror" { "Game mirror".into() } else { format!("NDI · {}", if ndi_st.source.is_empty() { &mode.1 } else { &ndi_st.source }) });
            ui.painter().text(rect.center() - egui::vec2(0.0, 30.0), egui::Align2::CENTER_CENTER, station, egui::FontId::proportional(72.0), Color32::from_rgb(0xf4, 0x79, 0x20));
            ui.painter().text(rect.center() + egui::vec2(0.0, 40.0), egui::Align2::CENTER_CENTER, detail, egui::FontId::proportional(22.0), Color32::from_gray(200));
        } else if !problems.is_empty() {
            let t = problems.join(" · ");
            let pos = rect.right_bottom() - egui::vec2(16.0, 16.0);
            let g = ui.painter().layout_no_wrap(t, egui::FontId::proportional(14.0), Color32::WHITE);
            let bg = egui::Rect::from_min_size(pos - g.size() - egui::vec2(10.0, 6.0), g.size() + egui::vec2(20.0, 12.0));
            ui.painter().rect_filled(bg, 4.0, Color32::from_rgba_unmultiplied(120, 20, 20, 210));
            ui.painter().galley(bg.min + egui::vec2(10.0, 6.0), g, Color32::WHITE);
        }
    }

    fn settings_window(&mut self, ctx: &egui::Context) {
        let mut open = self.settings;
        egui::Window::new("ISU Display Client - Settings").open(&mut open).default_size([520.0, 640.0]).collapsible(false).show(ctx, |ui| {
            ui.label(RichText::new("ISU DISPLAY CLIENT").small());
            ui.heading("Station setup");
            ui.label(RichText::new(format!("{} · v{VERSION}", hostname())).small());
            let mut f = std::mem::take(&mut self.form);
            fn text(ui: &mut egui::Ui, f: &mut Value, label: &str, key: &str) {
                ui.label(label);
                let mut s = if f[key].is_null() { String::new() } else { isu_core::game_config::js_string(Some(&f[key])) };
                if ui.text_edit_singleline(&mut s).changed() { f[key] = json!(s); }
                ui.end_row();
            }
            egui::Grid::new("set").num_columns(2).spacing([10.0, 6.0]).show(ui, |ui| {
                ui.label("Station");
                let mut st = f["station"].as_i64().unwrap_or(1);
                egui::ComboBox::from_id_salt("st").selected_text(format!("{st:02}")).show_ui(ui, |ui| { for n in 1..=10 { ui.selectable_value(&mut st, n, format!("{n:02}")); } });
                f["station"] = json!(st);
                ui.end_row();
                text(ui, &mut f, "Controller PC (IP or name)", "controller");
                text(ui, &mut f, "Port", "port");
                text(ui, &mut f, "Display key", "key");
                text(ui, &mut f, "OBS PC for NDI (optional)", "ndiHost");
                text(ui, &mut f, "Player monitor (game mirror)", "playerDisplay");
                text(ui, &mut f, "Audience monitor (this window)", "stageDisplay");
                ui.label("Headset output");
                let cur = f["noiseDevice"].as_str().unwrap_or("").to_string();
                let mut pick = cur.clone();
                egui::ComboBox::from_id_salt("dev").selected_text(if cur.is_empty() { "Default output".to_string() } else if self.devices.contains(&cur) { cur.clone() } else { format!("{cur} (not plugged in)") }).show_ui(ui, |ui| {
                    ui.selectable_value(&mut pick, String::new(), "Default output");
                    for d in &self.devices { ui.selectable_value(&mut pick, d.clone(), d); }
                });
                if pick != cur { f["noiseDevice"] = json!(pick.clone()); f["noiseDeviceLabel"] = json!(pick); }
                ui.end_row();
                text(ui, &mut f, "Max volume on this PC (%)", "noiseMaxVolume");
            });
            let mut lock = f["cursorLock"] == true;
            if ui.checkbox(&mut lock, "Keep the mouse on the player monitor (Ctrl+Alt+L)").changed() { f["cursorLock"] = json!(lock); }
            let mut sww = f["startWithWindows"] != false;
            if ui.checkbox(&mut sww, "Start with Windows (on by default)").changed() { f["startWithWindows"] = json!(sww); }
            let mut save = false;
            ui.horizontal(|ui| {
                if ui.button("TEST 3 SECONDS").clicked() {
                    let sh = Arc::clone(&self.sh);
                    let was = sh.live.lock().unwrap().noise;
                    sh.noise.set(true, Some(100.0));
                    std::thread::spawn(move || { std::thread::sleep(Duration::from_secs(3)); sh.noise.set(was.0, Some(was.1)); });
                }
                if self.saved_at.is_some_and(|t| t.elapsed() < Duration::from_millis(2500)) { ui.label("Saved · reconnecting"); }
                if ui.button("SAVE").clicked() { save = true; }
            });
            if save {
                let before = self.sh.live.lock().unwrap().cfg.clone();
                let mut merged = before.clone();
                for (k, v) in f.as_object().unwrap().clone() { merged[k] = v; }
                let cfg = normalize(&merged);
                save_config(&cfg);
                self.sh.live.lock().unwrap().cfg = cfg.clone();
                f = cfg.clone();
                self.sh.apply_cursor_lock();
                self.sh.apply_noise_device();
                if before["stageDisplay"] != cfg["stageDisplay"] { place_window(&ctx, &cfg); }
                if before["playerDisplay"] != cfg["playerDisplay"] && self.sh.live.lock().unwrap().mode.0 == "mirror" { self.sh.apply_mode("mirror", ""); }
                if ["controller", "port", "key", "station"].iter().any(|k| before[*k] != cfg[*k]) { self.sh.reconnect.notify_waiters(); }
                else { let m = self.sh.live.lock().unwrap().mode.clone(); if m.0 == "ndi" { self.sh.apply_mode("ndi", &m.1); } }
                self.saved_at = Some(std::time::Instant::now());
            }
            self.form = f;
        });
        self.settings = open;
    }
}

impl eframe::App for App {
    fn ui(&mut self, root: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = root.ctx().clone();
        let mut open_settings = false;
        let mut toggle_cursor = false;
        for action in self.hotkeys.events.try_iter() {
            match action { hotkeys::Action::Settings => open_settings = true, hotkeys::Action::CursorLock => toggle_cursor = !toggle_cursor }
        }
        // Windows delivers global hotkeys through WM_HOTKEY, avoiding a second focused-window toggle.
        #[cfg(not(windows))]
        {
            open_settings |= ctx.input(|i| i.modifiers.ctrl && i.modifiers.alt && i.key_pressed(egui::Key::S));
            toggle_cursor ^= ctx.input(|i| i.modifiers.ctrl && i.modifiers.alt && i.key_pressed(egui::Key::L));
        }
        if open_settings { self.settings = true; self.form = self.sh.live.lock().unwrap().cfg.clone(); self.devices = noise::Noise::devices(); }
        if toggle_cursor {
            let mut cfg = self.sh.live.lock().unwrap().cfg.clone();
            cfg["cursorLock"] = json!(cfg["cursorLock"] != true);
            let cfg = normalize(&cfg);
            save_config(&cfg);
            self.sh.live.lock().unwrap().cfg = cfg;
            self.sh.apply_cursor_lock();
        }
        if !self.placed {
            self.placed = true;
            let cfg = self.sh.live.lock().unwrap().cfg.clone();
            place_window(&ctx, &cfg);
        }
        egui::CentralPanel::default().frame(egui::Frame::NONE).show(root, |ui| self.output(ui));
        if self.settings { self.settings_window(&ctx); }
        ctx.request_repaint_after(Duration::from_millis(16));
    }

    fn on_exit(&mut self) {
        self.sh.cursor.unlock();
        self.sh.ndi.stop();
        self.sh.mirror.stop();
    }
}

/// createWindow(): the audience window on displayAt(stageDisplay, more than one screen ? 1 : 0),
/// full screen. egui works in points, so the physical rect is divided by the scale factor.
fn place_window(ctx: &egui::Context, cfg: &Value) {
    let list = monitors::all();
    let Some(m) = monitors::at(&list, cfg["stageDisplay"].as_u64().unwrap_or(2) as usize, if list.len() > 1 { 1 } else { 0 }) else { return };
    let ppp = ctx.pixels_per_point().max(0.1);
    let [l, t, r, b] = m.rect;
    ctx.send_viewport_cmd(egui::ViewportCommand::Fullscreen(false));
    ctx.send_viewport_cmd(egui::ViewportCommand::OuterPosition(egui::pos2(l as f32 / ppp, t as f32 / ppp)));
    ctx.send_viewport_cmd(egui::ViewportCommand::InnerSize(egui::vec2((r - l) as f32 / ppp, (b - t) as f32 / ppp)));
    ctx.send_viewport_cmd(egui::ViewportCommand::Fullscreen(true));
}

fn main() -> eframe::Result<()> {
    std::panic::set_hook(Box::new(|p| log_line(&format!("CRASH {p}"))));
    log_line(&format!("start v{VERSION} {}", std::env::consts::OS));
    // single instance: a lock file next to the config
    let lock = user_data().join("display-client.lock");
    let _ = std::fs::create_dir_all(user_data());
    let opts = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default().with_title("ISU Display Client").with_fullscreen(true).with_decorations(false).with_taskbar(false),
        ..Default::default()
    };
    let _ = lock;
    eframe::run_native("ISU Display Client", opts, Box::new(|cc| Ok(Box::new(App::new(cc)))))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalize_like_js() {
        assert_eq!(normalize(&json!({})), json!({ "station": 1, "controller": "127.0.0.1", "port": 3178, "key": "", "ndiHost": "", "playerDisplay": 1, "stageDisplay": 2, "cursorLock": false, "startWithWindows": true, "noiseDevice": "", "noiseDeviceLabel": "", "noiseMaxVolume": 60 }));
        // expected values printed by the real JS normalize() (display-client-main.cjs)
        let n = normalize(&json!({ "station": "12", "controller": " http://10.0.0.4/x ", "port": 0, "noiseMaxVolume": 150, "cursorLock": "true", "startWithWindows": false }));
        assert_eq!(n["station"], 10); assert_eq!(n["controller"], "10.0.0.4"); assert_eq!(n["port"], 3178); assert_eq!(n["noiseMaxVolume"], 100); assert_eq!(n["cursorLock"], false); assert_eq!(n["startWithWindows"], false);
        assert_eq!(normalize(&json!({ "noiseMaxVolume": "abc" }))["noiseMaxVolume"], Value::Null);
        assert_eq!(normalize(&json!({ "noiseMaxVolume": null }))["noiseMaxVolume"], 60);
        assert_eq!(normalize(&json!({ "controller": "HTTPS://Host:9/y" }))["controller"], "HTTPS:");
        let m = normalize(&json!({ "station": -3, "playerDisplay": 0 }));
        assert_eq!((m["station"].clone(), m["playerDisplay"].clone()), (json!(1), json!(1)));
    }
}
