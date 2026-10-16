//! ISU Esports Game Bridge (Game PC companion) in Rust + egui.
//! Port of electron/bridge-main.cjs (config file, legacy fallback, single window) and
//! bridge/index.html (game picker, Graphics PC address / port / key, Rocket League adapter,
//! spectated-player boxes, capture frame, test feed, status cards).
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod spectator;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use eframe::egui::{self, Color32, RichText};
use isu_ui::c;
use isu_net::bridge::GameBridge;
use serde_json::{Value, json};

/// %APPDATA%\ISU Esports Game Bridge (Electron app.setPath('userData', ...)).
fn user_data() -> PathBuf {
    std::env::var_os("ISU_BRIDGE_USER_DATA").map(PathBuf::from).unwrap_or_else(||
        dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("ISU Esports Game Bridge"))
}
fn config_path() -> PathBuf {
    user_data().join("bridge-config.json")
}

/// readConfigWithLegacyFallback(): bridge-config.json, else the old 'ISU Rocket League Bridge' one.
fn read_config() -> Value {
    if let Some(v) = std::fs::read_to_string(config_path()).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).filter(|v| v.as_object().is_some_and(|o| !o.is_empty())) {
        return v;
    }
    let legacy = dirs::config_dir().unwrap_or_default().join("ISU Rocket League Bridge").join("bridge-config.json");
    if let Some(Value::Object(mut o)) = std::fs::read_to_string(legacy).ok().and_then(|s| serde_json::from_str(&s).ok()) {
        o.entry("game").or_insert(json!("rocketleague"));
        return Value::Object(o);
    }
    json!({})
}

fn save_config(v: &Value) {
    let _ = std::fs::create_dir_all(user_data());
    let _ = std::fs::write(config_path(), serde_json::to_string_pretty(v).unwrap_or_default());
}

/// Where the models / templates are: next to the exe (packaged: resources\), else the repo (dev).
fn data_root() -> PathBuf {
    let exe = std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())).unwrap_or_default();
    for c in [exe.join("resources"), exe.clone()].into_iter().chain(std::env::var_os("ISU_NO_DEV_ROOT").is_none().then(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."))) {
        if c.join("electron").join("valorant-agent-templates.json").exists() {
            return c;
        }
    }
    exe
}

#[derive(Default, Clone)]
struct Form {
    game: String,
    host: String,
    port: String,
    token: String,
    transport: String,
    rl_host: String,
    tcp: String,
    web: String,
    window: String,
    interval: String,
    method: String,
    roi: [String; 4],
    portrait: [String; 3],
}

impl Form {
    /// load(config) in bridge/index.html.
    fn load(c: &Value) -> Self {
        let s = |v: &Value, d: &str| match v {
            Value::Null => d.to_string(),
            other => isu_core::game_config::js_string(Some(other)),
        };
        let rl = if c["rocketLeague"].is_object() { &c["rocketLeague"] } else { c };
        let sp = &c["spectate"];
        let game = c["game"].as_str().filter(|g| !g.is_empty()).unwrap_or("rocketleague").to_string();
        let mut f = Self {
            game,
            host: s(&c["graphicsHost"], ""),
            port: s(&c["bridgePort"], "3175"),
            token: s(&c["bridgeToken"], ""),
            transport: s(&rl["transport"], "auto"),
            rl_host: s(&rl["host"], "127.0.0.1"),
            tcp: s(&rl["tcpPort"], "49123"),
            web: s(&rl["webPort"], "49124"),
            window: sp["windowName"].as_str().filter(|w| !w.is_empty()).unwrap_or("VALORANT").to_string(),
            interval: sp["intervalMs"].as_f64().filter(|v| *v != 0.0).map_or("250".into(), |v| isu_core::game_config::num_to_js(v)),
            method: sp["method"].as_str().unwrap_or("both").to_string(),
            roi: ["113", "816", "213", "41"].map(String::from),
            portrait: ["31", "794", "81"].map(String::from),
        };
        for (i, k) in ["x", "y", "w", "h"].iter().enumerate() {
            if !sp["roi"][k].is_null() {
                f.roi[i] = s(&sp["roi"][k], "");
            }
        }
        for (i, k) in ["x", "y", "s"].iter().enumerate() {
            if !sp["portrait"][k].is_null() {
                f.portrait[i] = s(&sp["portrait"][k], "");
            }
        }
        f.render_mode();
        f
    }

    /// renderMode(): per-game defaults for the name box / window title when still on a default.
    fn render_mode(&mut self) {
        let defaults: [(&str, [&str; 4]); 2] = [("valorant", ["113", "816", "213", "41"]), ("overwatch", ["150", "954", "200", "40"])];
        if let Some((_, d)) = defaults.iter().find(|(g, _)| *g == self.game) {
            if defaults.iter().any(|(_, x)| x.iter().zip(&self.roi).all(|(a, b)| b.trim().parse::<f64>().ok() == a.parse::<f64>().ok())) {
                self.roi = d.map(String::from);
            }
        }
        if self.window == "VALORANT" || self.window == "Overwatch" {
            self.window = if self.game == "overwatch" { "Overwatch".into() } else { "VALORANT".into() };
        }
    }

    /// read() in bridge/index.html (Number('') = 0, like the page).
    fn read(&self) -> Value {
        let n = |s: &str| isu_core::game_config::js_number(s).map_or(Value::Null, isu_core::game_config::jnum);
        json!({
            "game": self.game, "graphicsHost": self.host.trim(), "bridgePort": n(&self.port), "bridgeToken": self.token.trim(),
            "rocketLeague": { "transport": self.transport, "host": self.rl_host.trim(), "tcpPort": n(&self.tcp), "webPort": n(&self.web) },
            "spectate": { "enabled": true, "method": self.method, "windowName": self.window.trim(), "intervalMs": n(&self.interval),
                "roi": { "x": n(&self.roi[0]), "y": n(&self.roi[1]), "w": n(&self.roi[2]), "h": n(&self.roi[3]) },
                "portrait": { "x": n(&self.portrait[0]), "y": n(&self.portrait[1]), "s": n(&self.portrait[2]) } }
        })
    }
}

struct App {
    rt: tokio::runtime::Runtime,
    bridge: Arc<GameBridge>,
    form: Form,
    status: Arc<Mutex<Value>>,
    spectate: Arc<Mutex<Value>>,
    shot: Option<(egui::TextureHandle, String)>,
    source: Arc<dyn isu_ocr::capture::Source>,
}

const ORANGE: Color32 = Color32::from_rgb(0xf4, 0x79, 0x20);

fn game_color(g: &str) -> Color32 {
    match g {
        "valorant" => Color32::from_rgb(0xff, 0x46, 0x55),
        "overwatch" => Color32::from_rgb(0xf0, 0x64, 0x14),
        _ => Color32::from_rgb(0x2d, 0x8c, 0xff),
    }
}

/// show(id, label, status): good / wait / bad colours by state.
fn status_card(ui: &mut egui::Ui, label: &str, st: &Value) {
    let state = st["state"].as_str().unwrap_or("stopped");
    let color = match state {
        "connected" | "reading" | "simulating" => Color32::from_rgb(0x70, 0xcd, 0x6a),
        "connecting" | "waiting" | "starting" | "searching-window" | "recovering" | "calibrating" | "listening" => Color32::from_rgb(0xe8, 0xb3, 0x3c),
        "error" | "stale" | "degraded" => Color32::from_rgb(0xe5, 0x48, 0x4d),
        _ => c::DIM,
    };
    let r = egui::Frame::NONE.fill(c::INPUT).stroke(egui::Stroke::new(1.0, Color32::from_rgb(0x2f, 0x2f, 0x34))).corner_radius(2.0).inner_margin(egui::Margin { left: 14, right: 12, top: 10, bottom: 10 }).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.spacing_mut().item_spacing.y = 4.0;
        ui.horizontal(|ui| {
            ui.label(RichText::new(label).size(9.5).strong().extra_letter_spacing(1.2).color(c::LABEL));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| ui.label(RichText::new(format!("●  {}", state.to_uppercase())).size(10.5).strong().color(color)));
        });
        ui.add(egui::Label::new(RichText::new(st["message"].as_str().unwrap_or("Stopped")).size(12.0).color(c::TEXT)).wrap());
    }).response.rect;
    ui.painter().rect_filled(egui::Rect::from_min_size(r.min, egui::vec2(3.0, r.height())), 0.0, color);
}

/// A plain text box with a label, full cell width (the bridge commits on focus loss itself).
fn edit(ui: &mut egui::Ui, label: &str, v: &mut String, hint: &str) -> egui::Response {
    isu_ui::field_label(ui, label);
    ui.add(egui::TextEdit::singleline(v).hint_text(hint).desired_width(ui.available_width()).margin(egui::vec2(10.0, 9.0)))
}

impl App {
    fn new(cc: &eframe::CreationContext<'_>) -> Self {
        isu_ui::apply_theme(&cc.egui_ctx);
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().worker_threads(4).build().expect("runtime");
        let root = data_root();
        let eng_dir = isu_ocr::tess::unpack_gz_model(&root.join("node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz"), &user_data().join("tessdata"), "eng")
            .or_else(|_| if root.join("tessdata/eng.traineddata").exists() { Ok(root.join("tessdata")) } else { Err(anyhow::anyhow!("no eng model")) })
            .unwrap_or_else(|_| root.join("tessdata"));
        #[cfg(windows)]
        let source: Arc<dyn isu_ocr::capture::Source> = Arc::new(isu_ocr::capture::WgcSource::default());
        #[cfg(not(windows))]
        let source: Arc<dyn isu_ocr::capture::Source> = Arc::new(NoCapture);
        let spectator = Arc::new(spectator::OcrSpectator::new(Arc::clone(&source), spectator::Models { eng_dir, custom_dir: root.join("electron/ocr-models"), data_dir: root.join("electron") }));
        let status: Arc<Mutex<Value>> = Arc::new(Mutex::new(json!({})));
        let spectate: Arc<Mutex<Value>> = Arc::new(Mutex::new(Value::Null));
        let (s2, p2, ctx1, ctx2) = (Arc::clone(&status), Arc::clone(&spectate), cc.egui_ctx.clone(), cc.egui_ctx.clone());
        let bridge = {
            let _g = rt.enter();
            GameBridge::new(Some(spectator), Arc::new(move |s| { *s2.lock().unwrap() = s; ctx1.request_repaint(); }), Arc::new(move |s| { if let Some(sp) = s.get("spectate") { *p2.lock().unwrap() = sp.clone(); } ctx2.request_repaint(); }))
        };
        let form = Form::load(&read_config());
        *status.lock().unwrap() = bridge.status();
        Self { rt, bridge, form, status, spectate, shot: None, source }
    }

    fn run<T>(&self, f: impl FnOnce(&Arc<GameBridge>) -> T) -> T {
        let _g = self.rt.enter();
        f(&self.bridge)
    }

    /// spectateSnapshot(): one frame + the boxes.
    fn capture_frame(&mut self, ctx: &egui::Context) {
        let cfg = self.form.read();
        save_config(&cfg);
        let window = cfg["spectate"]["windowName"].as_str().unwrap_or("VALORANT").to_string();
        match self.source.capture(&window, 8, None) {
            Ok(f) => {
                let rgba: Vec<u8> = f.px.chunks(4).flat_map(|p| [p[2], p[1], p[0], 255]).collect();
                let img = egui::ColorImage::from_rgba_unmultiplied([f.w as usize, f.h as usize], &rgba);
                self.shot = Some((ctx.load_texture("frame", img, egui::TextureOptions::LINEAR), String::new()));
            }
            Err(e) => *self.status.lock().unwrap() = { let mut s = self.bridge.status(); s["source"] = json!({ "state": "error", "message": e }); s },
        }
    }
}

#[cfg(not(windows))]
struct NoCapture;
#[cfg(not(windows))]
impl isu_ocr::capture::Source for NoCapture {
    fn capture(&self, _w: &str, _f: u32, _n: Option<u64>) -> Result<isu_ocr::capture::Bgra, String> {
        Err("Window capture needs Windows (Windows Graphics Capture)".into())
    }
}

impl eframe::App for App {
    fn ui(&mut self, root: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = &root.ctx().clone();
        let status = self.status.lock().unwrap().clone();
        let accent = game_color(&self.form.game);
        egui::CentralPanel::default().frame(egui::Frame::NONE.fill(Color32::from_rgb(0x0d, 0x0d, 0x0f))).show(root, |ui| {
            egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
                egui::Frame::NONE.inner_margin(egui::Margin { left: 28, right: 28, top: 20, bottom: 28 }).show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.spacing_mut().item_spacing.y = 12.0;
                // brand bar
                ui.horizontal(|ui| {
                    let (r, _) = ui.allocate_exact_size(egui::vec2(46.0, 42.0), egui::Sense::hover());
                    let p = ui.painter();
                    p.rect_filled(r, 0.0, Color32::from_rgb(0x17, 0x17, 0x19));
                    p.add(egui::Shape::convex_polygon(vec![r.left_top(), egui::pos2(r.left() + r.width() * 0.62, r.top()), egui::pos2(r.left(), r.bottom() - r.height() * 0.1)], ORANGE, egui::Stroke::NONE));
                    p.rect_stroke(r, 0.0, egui::Stroke::new(1.0, ORANGE.gamma_multiply(0.45)), egui::StrokeKind::Inside);
                    p.text(r.center(), egui::Align2::CENTER_CENTER, "IS", egui::FontId::proportional(19.0), Color32::WHITE);
                    ui.vertical(|ui| {
                        ui.spacing_mut().item_spacing.y = 3.0;
                        ui.add_space(6.0);
                        ui.label(RichText::new("UNIVERSAL ESPORTS BRIDGE").strong().size(15.0).extra_letter_spacing(1.3).color(c::TEXT));
                        ui.label(RichText::new("GAME PC COMPANION").size(9.5).strong().extra_letter_spacing(1.1).color(Color32::from_rgb(0x79, 0x79, 0x80)));
                    });
                });
                // hero + game picker
                isu_ui::panel(ui, |ui| {
                    isu_ui::cols(ui, &[-1.0, 230.0], 16.0, |j, ui| {
                        if j == 0 {
                            ui.spacing_mut().item_spacing.y = 4.0;
                            ui.label(RichText::new("NETWORK TELEMETRY").size(9.5).strong().extra_letter_spacing(1.3).color(accent));
                            ui.label(RichText::new("Send live game data to Broadcast Control").strong().size(19.0).color(c::TEXT));
                            ui.label(RichText::new("One bridge for Rocket League, VALORANT and Overwatch.").size(11.5).color(c::DIM));
                        } else {
                            let before = self.form.game.clone();
                            let opts = [("rocketleague".to_string(), "Rocket League".to_string()), ("valorant".to_string(), "VALORANT".to_string()), ("overwatch".to_string(), "Overwatch 2".to_string())];
                            if let Some(g) = isu_ui::select(ui, "game", "Active game adapter", &self.form.game, &opts) {
                                self.form.game = g;
                            }
                            if before != self.form.game {
                                self.form.render_mode();
                            }
                        }
                    });
                    ui.add_space(4.0);
                    // network: host | port | key
                    isu_ui::cols(ui, &[-1.0, 110.0, -1.6], 10.0, |j, ui| {
                        match j {
                            0 => { edit(ui, "Graphics PC IP address", &mut self.form.host, "192.168.1.50"); }
                            1 => { edit(ui, "Bridge port", &mut self.form.port, ""); }
                            _ => { edit(ui, "Private bridge key", &mut self.form.token, "Paste the key from Broadcast Control"); }
                        }
                    });
                });
                let mut changed = false;
                if self.form.game == "rocketleague" {
                    isu_ui::panel(ui, |ui| {
                        isu_ui::heading(ui, "", "Rocket League adapter", "Local Stats API connection on this PC", |ui| {
                            let sim = status["source"]["state"] == "simulating";
                            let b = if sim { egui::Button::new(RichText::new("STOP TEST FEED").strong().color(Color32::from_rgb(0xff, 0x6b, 0x63))).fill(Color32::from_rgb(0x2a, 0x13, 0x12)).stroke(egui::Stroke::new(1.0, Color32::from_rgb(0xd9, 0x47, 0x3e))).min_size(egui::vec2(0.0, 37.0)) } else { isu_ui::secondary_button("RUN TEST FEED") };
                            if ui.add(b).clicked() {
                                if sim {
                                    self.run(|br| br.stop_simulator());
                                } else {
                                    let cfg = self.form.read();
                                    save_config(&cfg);
                                    self.run(|br| { br.start(&cfg); br.start_simulator(); });
                                }
                            }
                        });
                        isu_ui::cols(ui, &[-1.2, -1.2, -0.8, -0.8], 10.0, |j, ui| match j {
                            0 => {
                                let opts = [("auto".to_string(), "Automatic".to_string()), ("websocket".to_string(), "WebSocket".to_string()), ("tcp".to_string(), "TCP".to_string())];
                                if let Some(t) = isu_ui::select(ui, "transport", "Transport", &self.form.transport, &opts) { self.form.transport = t; }
                            }
                            1 => { edit(ui, "Local game host", &mut self.form.rl_host, ""); }
                            2 => { edit(ui, "TCP port", &mut self.form.tcp, ""); }
                            _ => { edit(ui, "WebSocket port", &mut self.form.web, ""); }
                        });
                    });
                } else {
                    isu_ui::panel(ui, |ui| {
                        isu_ui::title(ui, "", "Spectated player", "Player-POV spectator: who is being watched. The bridge reads the small player name on screen and matches it to the names the controller sends (rosters + scoreboard), so it only ever reports one of your players.");
                        isu_ui::cols(ui, &[-1.2, -0.7, -1.4], 10.0, |j, ui| match j {
                            0 => { changed |= edit(ui, "Window title contains", &mut self.form.window, "").lost_focus(); }
                            1 => { changed |= edit(ui, "Read every (ms)", &mut self.form.interval, "").lost_focus(); }
                            _ => {
                                let opts = [("both".to_string(), "Agent icon, then name (OCR)".to_string()), ("icon".to_string(), "Agent icon only (experiment, no OCR)".to_string())];
                                if let Some(m) = isu_ui::select(ui, "method", "How to find the player", &self.form.method, &opts) { self.form.method = m; changed = true; }
                            }
                        });
                        // box positions: name x/y/w/h | icon x/y/size
                        let n = if self.form.game == "valorant" { 7 } else { 4 };
                        let widths = vec![-1.0; n];
                        isu_ui::cols(ui, &widths, 8.0, |j, ui| {
                            let labels = ["Name box X", "Name box Y", "Name box W", "Name box H", "Icon box X", "Icon box Y", "Icon size"];
                            let r = if j < 4 { edit(ui, labels[j], &mut self.form.roi[j], "") } else { edit(ui, labels[j], &mut self.form.portrait[j - 4], "") };
                            changed |= r.lost_focus();
                        });
                        ui.horizontal(|ui| {
                            if ui.add(isu_ui::secondary_button("CAPTURE FRAME TO PLACE THE BOXES")).clicked() {
                                self.capture_frame(ctx);
                            }
                        });
                        let sp = self.spectate.lock().unwrap().clone();
                        let name = sp["name"].as_str().filter(|n| !n.is_empty()).unwrap_or("—");
                        let mut line = format!("SPECTATING {name}");
                        if let Some(s) = sp["station"].as_f64() {
                            line += &format!(" · STATION {}", isu_core::game_config::num_to_js(s));
                        }
                        if let Some(v) = sp["via"].as_str().filter(|v| !v.is_empty()) {
                            line += &format!(" · BY {}", v.to_uppercase());
                        }
                        line += &format!(" · {} names from the controller", sp["candidates"].as_u64().unwrap_or(0));
                        isu_ui::inset(ui, |ui| {
                            ui.set_width(ui.available_width());
                            ui.label(RichText::new(line).strong().size(13.0).color(c::TEXT));
                            if let Some(p) = sp["last"]["portrait"].as_object() {
                                ui.label(RichText::new(format!("PORTRAIT {} · {} box{}", p.get("agent").and_then(Value::as_str).or(p.get("candidate").and_then(Value::as_str)).unwrap_or("?"), p.get("color").and_then(Value::as_str).filter(|c| !c.is_empty()).unwrap_or("?"), p.get("player").and_then(|x| x["name"].as_str()).map(|n| format!(" → {n}")).unwrap_or_default())).size(10.5).color(c::DIM));
                            }
                        });
                        if let Some((tex, _)) = &self.shot {
                            let w = ui.available_width();
                            let size = egui::vec2(w, w * 1080.0 / 1920.0);
                            let (rect, _) = ui.allocate_exact_size(size, egui::Sense::hover());
                            ui.painter().image(tex.id(), rect, egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)), Color32::WHITE);
                            let k = w / 1920.0;
                            let num = |s: &str| s.trim().parse::<f32>().unwrap_or(0.0);
                            let r = &self.form.roi;
                            let name_box = egui::Rect::from_min_size(rect.min + egui::vec2(num(&r[0]) * k, num(&r[1]) * k), egui::vec2(num(&r[2]) * k, num(&r[3]) * k));
                            ui.painter().rect_stroke(name_box, 0.0, egui::Stroke::new(2.0, Color32::from_rgb(0xff, 0x46, 0x55)), egui::StrokeKind::Outside);
                            ui.painter().text(name_box.left_top(), egui::Align2::LEFT_BOTTOM, "PLAYER NAME", egui::FontId::proportional(11.0), Color32::from_rgb(0xff, 0x46, 0x55));
                            if self.form.game == "valorant" {
                                let p = &self.form.portrait;
                                let ib = egui::Rect::from_min_size(rect.min + egui::vec2(num(&p[0]) * k, num(&p[1]) * k), egui::vec2(num(&p[2]) * k, num(&p[2]) * k));
                                ui.painter().rect_stroke(ib, 0.0, egui::Stroke::new(2.0, Color32::from_rgb(0x12, 0xd8, 0xc8)), egui::StrokeKind::Outside);
                                ui.painter().text(ib.left_top(), egui::Align2::LEFT_BOTTOM, "AGENT ICON", egui::FontId::proportional(11.0), Color32::from_rgb(0x12, 0xd8, 0xc8));
                            }
                        }
                    });
                }
                if changed {
                    let cfg = self.form.read();
                    save_config(&cfg);
                    let st = self.run(|b| b.update_config(&cfg));
                    *self.status.lock().unwrap() = st;
                }
                // start / stop + status cards
                ui.horizontal(|ui| {
                    if ui.add(isu_ui::primary_button("START BRIDGE").min_size(egui::vec2(160.0, 40.0))).clicked() {
                        let cfg = self.form.read();
                        save_config(&cfg);
                        let st = self.run(|b| b.start(&cfg));
                        *self.status.lock().unwrap() = st;
                    }
                    if ui.add(isu_ui::secondary_button("STOP").min_size(egui::vec2(90.0, 40.0))).clicked() {
                        self.run(|b| b.stop());
                        *self.status.lock().unwrap() = self.bridge.status();
                    }
                });
                isu_ui::cols(ui, &[-1.0, -1.0], 10.0, |j, ui| {
                    if j == 0 {
                        status_card(ui, "GRAPHICS PC", if status["remote"].is_object() { &status["remote"] } else { &Value::Null });
                    } else {
                        status_card(ui, if self.form.game == "rocketleague" { "ROCKET LEAGUE" } else { "SPECTATED PLAYER" }, if status["source"].is_object() { &status["source"] } else { &Value::Null });
                    }
                });
                ui.add(egui::Label::new(RichText::new(if self.form.game != "rocketleague" {
                    "SETUP: On the Graphics PC (Broadcast Control → Settings → Spectated player receiver), turn the receiver on, generate a bridge key, and use the same port and key here. Place the name box on the spectated player's name."
                } else {
                    "SETUP: On the Graphics PC, choose Rocket League, set Data Source to Game PC Bridge, and use the same port and key. The spectated player comes from the Rocket League API; no name box needed."
                }).size(10.5).color(c::DIM)).wrap());
                });
            });
        });
    }

    fn on_exit(&mut self) {
        self.run(|b| b.stop());
        self.source.stop();
    }
}

fn main() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default().with_inner_size([920.0, 900.0]).with_min_inner_size([760.0, 700.0]).with_title("ISU Esports Game Bridge"),
        ..Default::default()
    };
    eframe::run_native("ISU Esports Game Bridge", options, Box::new(|cc| Ok(Box::new(App::new(cc)))))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn form_loads_and_reads_like_the_page() {
        let f = Form::load(&json!({ "game": "valorant", "graphicsHost": "127.0.0.1", "bridgePort": 3175, "bridgeToken": "test-key-123" }));
        assert_eq!(f.game, "valorant");
        assert_eq!(f.host, "127.0.0.1");
        assert_eq!(f.port, "3175");
        let r = f.read();
        assert_eq!(r["game"], "valorant");
        assert_eq!(r["bridgePort"], 3175);
        assert_eq!(r["spectate"]["roi"], json!({ "x": 113, "y": 816, "w": 213, "h": 41 }));
        // switching to Overwatch moves a default name box to the Overwatch default (renderMode)
        let mut o = f.clone(); o.game = "overwatch".into(); o.render_mode();
        assert_eq!(o.roi, ["150", "954", "200", "40"].map(String::from)); assert_eq!(o.window, "Overwatch");
        // a custom box stays
        let mut c = f.clone(); c.roi[0] = "120".into(); c.game = "overwatch".into(); c.render_mode(); assert_eq!(c.roi[0], "120");
    }
    #[test]
    fn config_read_from_user_data() {
        let d = std::env::temp_dir().join(format!("isu-bridge-cfg-{}", std::process::id()));
        std::fs::create_dir_all(d.join("ISU Esports Game Bridge")).unwrap();
        std::fs::write(d.join("ISU Esports Game Bridge/bridge-config.json"), r#"{"game":"overwatch"}"#).unwrap();
        // SAFETY: test-only, single thread at this point
        let user_dir = d.join("ISU Esports Game Bridge");
        let previous = std::env::var_os("ISU_BRIDGE_USER_DATA");
        unsafe { std::env::set_var("ISU_BRIDGE_USER_DATA", &user_dir); }
        assert_eq!(user_data(), user_dir);
        assert_eq!(read_config()["game"], "overwatch");
        unsafe {
            match previous {
                Some(value) => std::env::set_var("ISU_BRIDGE_USER_DATA", value),
                None => std::env::remove_var("ISU_BRIDGE_USER_DATA"),
            }
        }
    }
}
