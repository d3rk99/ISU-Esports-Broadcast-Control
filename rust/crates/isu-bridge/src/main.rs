//! ISU Esports Game Bridge (Game PC companion) in Rust + egui.
//! Port of electron/bridge-main.cjs (config file, legacy fallback, single window) and
//! bridge/index.html (game picker, Graphics PC address / port / key, Rocket League adapter,
//! spectated-player boxes, capture frame, test feed, status cards).
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod spectator;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use eframe::egui::{self, Color32, RichText};
use isu_net::bridge::GameBridge;
use serde_json::{Value, json};

/// %APPDATA%\ISU Esports Game Bridge (Electron app.setPath('userData', ...)).
fn user_data() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("ISU Esports Game Bridge")
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
    for c in [exe.join("resources"), exe.clone(), PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")] {
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
        "connected" | "reading" | "simulating" => Color32::from_rgb(0x3c, 0xc8, 0x6e),
        "connecting" | "waiting" | "starting" | "searching-window" | "recovering" | "calibrating" | "listening" => Color32::from_rgb(0xe6, 0xb4, 0x2a),
        "error" | "stale" | "degraded" => Color32::from_rgb(0xe0, 0x46, 0x46),
        _ => Color32::GRAY,
    };
    egui::Frame::group(ui.style()).stroke(egui::Stroke::new(1.0, color)).show(ui, |ui| {
        ui.set_min_width(330.0);
        ui.label(RichText::new(format!("{label} · {}", state.to_uppercase())).strong().color(color));
        ui.label(st["message"].as_str().unwrap_or("Stopped"));
    });
}

impl App {
    fn new(cc: &eframe::CreationContext<'_>) -> Self {
        cc.egui_ctx.set_visuals(egui::Visuals::dark());
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
        egui::CentralPanel::default().show(root, |ui| {
            egui::ScrollArea::vertical().show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(RichText::new(" ISU ").strong().background_color(ORANGE).color(Color32::BLACK));
                    ui.vertical(|ui| {
                        ui.label(RichText::new("GAME PC COMPANION").small().color(Color32::GRAY));
                        ui.label(RichText::new("UNIVERSAL ESPORTS BRIDGE").strong());
                    });
                });
                ui.separator();
                ui.horizontal(|ui| {
                    ui.vertical(|ui| {
                        ui.label(RichText::new("NETWORK TELEMETRY").small().color(accent));
                        ui.heading("Send live game data to Broadcast Control");
                        ui.label("One bridge for Rocket League, VALORANT and Overwatch.");
                    });
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::TOP), |ui| {
                        let before = self.form.game.clone();
                        egui::ComboBox::from_id_salt("game").selected_text(match self.form.game.as_str() { "valorant" => "VALORANT", "overwatch" => "Overwatch 2", _ => "Rocket League" }).show_ui(ui, |ui| {
                            ui.selectable_value(&mut self.form.game, "rocketleague".into(), "Rocket League");
                            ui.selectable_value(&mut self.form.game, "valorant".into(), "VALORANT");
                            ui.selectable_value(&mut self.form.game, "overwatch".into(), "Overwatch 2");
                        });
                        ui.label(RichText::new("ACTIVE GAME ADAPTER").small());
                        if before != self.form.game {
                            self.form.render_mode();
                        }
                    });
                });
                egui::Grid::new("net").num_columns(2).spacing([10.0, 6.0]).show(ui, |ui| {
                    ui.label("GRAPHICS PC IP ADDRESS");
                    ui.add(egui::TextEdit::singleline(&mut self.form.host).hint_text("192.168.1.50"));
                    ui.end_row();
                    ui.label("BRIDGE PORT");
                    ui.text_edit_singleline(&mut self.form.port);
                    ui.end_row();
                    ui.label("PRIVATE BRIDGE KEY");
                    ui.add(egui::TextEdit::singleline(&mut self.form.token).hint_text("Paste the key from Broadcast Control").desired_width(380.0));
                    ui.end_row();
                });
                ui.add_space(8.0);
                let mut changed = false;
                if self.form.game == "rocketleague" {
                    ui.group(|ui| {
                        ui.label(RichText::new("ROCKET LEAGUE ADAPTER · Local Stats API connection").strong().color(accent));
                        egui::Grid::new("rl").num_columns(2).spacing([10.0, 6.0]).show(ui, |ui| {
                            ui.label("TRANSPORT");
                            egui::ComboBox::from_id_salt("transport").selected_text(match self.form.transport.as_str() { "websocket" => "WebSocket", "tcp" => "TCP", _ => "Automatic" }).show_ui(ui, |ui| {
                                ui.selectable_value(&mut self.form.transport, "auto".into(), "Automatic");
                                ui.selectable_value(&mut self.form.transport, "websocket".into(), "WebSocket");
                                ui.selectable_value(&mut self.form.transport, "tcp".into(), "TCP");
                            });
                            ui.end_row();
                            ui.label("LOCAL GAME HOST");
                            ui.text_edit_singleline(&mut self.form.rl_host);
                            ui.end_row();
                            ui.label("TCP PORT");
                            ui.text_edit_singleline(&mut self.form.tcp);
                            ui.end_row();
                            ui.label("WEBSOCKET PORT");
                            ui.text_edit_singleline(&mut self.form.web);
                            ui.end_row();
                        });
                        let sim = status["source"]["state"] == "simulating";
                        let b = egui::Button::new(if sim { "STOP TEST FEED" } else { "RUN TEST FEED" });
                        if ui.add(if sim { b.fill(Color32::from_rgb(120, 30, 30)) } else { b }).clicked() {
                            if sim {
                                self.run(|br| br.stop_simulator());
                            } else {
                                let cfg = self.form.read();
                                save_config(&cfg);
                                self.run(|br| { br.start(&cfg); br.start_simulator(); });
                            }
                        }
                    });
                } else {
                    ui.group(|ui| {
                        ui.label(RichText::new("SPECTATED PLAYER · Player-POV spectator: who is being watched").strong().color(accent));
                        ui.label(RichText::new("For a spectator PC that follows the players' views. The bridge reads the small player name on screen and matches it to the names the controller sends (rosters + scoreboard), so it only ever reports one of your players.").small());
                        egui::Grid::new("sp").num_columns(2).spacing([10.0, 6.0]).show(ui, |ui| {
                            ui.label("WINDOW TITLE CONTAINS");
                            changed |= ui.text_edit_singleline(&mut self.form.window).lost_focus();
                            ui.end_row();
                            ui.label("READ EVERY (MS)");
                            changed |= ui.text_edit_singleline(&mut self.form.interval).lost_focus();
                            ui.end_row();
                            ui.label("HOW TO FIND THE PLAYER");
                            let m0 = self.form.method.clone();
                            egui::ComboBox::from_id_salt("method").selected_text(if self.form.method == "icon" { "Agent icon only (experiment, no OCR)" } else { "Agent icon, then name (OCR)" }).show_ui(ui, |ui| {
                                ui.selectable_value(&mut self.form.method, "both".into(), "Agent icon, then name (OCR)");
                                ui.selectable_value(&mut self.form.method, "icon".into(), "Agent icon only (experiment, no OCR)");
                            });
                            changed |= m0 != self.form.method;
                            ui.end_row();
                            for (i, l) in ["NAME BOX X", "NAME BOX Y", "NAME BOX W", "NAME BOX H"].iter().enumerate() {
                                ui.label(*l);
                                changed |= ui.text_edit_singleline(&mut self.form.roi[i]).lost_focus();
                                ui.end_row();
                            }
                            if self.form.game == "valorant" {
                                for (i, l) in ["ICON BOX X", "ICON BOX Y", "ICON BOX SIZE"].iter().enumerate() {
                                    ui.label(*l);
                                    changed |= ui.text_edit_singleline(&mut self.form.portrait[i]).lost_focus();
                                    ui.end_row();
                                }
                            }
                        });
                        if ui.button("CAPTURE FRAME TO PLACE THE BOXES").clicked() {
                            self.capture_frame(ctx);
                        }
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
                        ui.label(RichText::new(line).strong());
                        if let Some(p) = sp["last"]["portrait"].as_object() {
                            ui.label(RichText::new(format!("PORTRAIT {} · {} box{}", p.get("agent").and_then(Value::as_str).or(p.get("candidate").and_then(Value::as_str)).unwrap_or("?"), p.get("color").and_then(Value::as_str).filter(|c| !c.is_empty()).unwrap_or("?"), p.get("player").and_then(|x| x["name"].as_str()).map(|n| format!(" → {n}")).unwrap_or_default())).small());
                        }
                        if let Some((tex, _)) = &self.shot {
                            let w = ui.available_width().min(860.0);
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
                ui.add_space(8.0);
                ui.horizontal(|ui| {
                    if ui.add(egui::Button::new(RichText::new("START BRIDGE").strong()).fill(ORANGE)).clicked() {
                        let cfg = self.form.read();
                        save_config(&cfg);
                        let st = self.run(|b| b.start(&cfg));
                        *self.status.lock().unwrap() = st;
                    }
                    if ui.button("STOP").clicked() {
                        self.run(|b| b.stop());
                        *self.status.lock().unwrap() = self.bridge.status();
                    }
                });
                ui.horizontal_wrapped(|ui| {
                    if status["remote"].is_object() {
                        status_card(ui, "GRAPHICS PC", &status["remote"]);
                    }
                    if status["source"].is_object() {
                        status_card(ui, if self.form.game == "rocketleague" { "ROCKET LEAGUE" } else { "SPECTATED PLAYER" }, &status["source"]);
                    }
                });
                ui.label(RichText::new(if self.form.game != "rocketleague" {
                    "SETUP: On the Graphics PC (Broadcast Control → Settings → Spectated player receiver), turn the receiver on, generate a bridge key, and use the same port and key here. Place the name box on the spectated player's name."
                } else {
                    "SETUP: On the Graphics PC, choose Rocket League, set Data Source to Game PC Bridge, and use the same port and key. The spectated player comes from the Rocket League API; no name box needed."
                }).small());
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
    fn config_read_from_xdg() {
        let d = std::env::temp_dir().join(format!("isu-bridge-cfg-{}", std::process::id()));
        std::fs::create_dir_all(d.join("ISU Esports Game Bridge")).unwrap();
        std::fs::write(d.join("ISU Esports Game Bridge/bridge-config.json"), r#"{"game":"overwatch"}"#).unwrap();
        // SAFETY: test-only, single thread at this point
        unsafe { std::env::set_var("XDG_CONFIG_HOME", &d); }
        assert_eq!(dirs::config_dir().unwrap(), d);
        assert_eq!(read_config()["game"], "overwatch");
    }
}
