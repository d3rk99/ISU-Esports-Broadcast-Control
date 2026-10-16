//! The controller window (src/app.js render + src/styles.css look) in egui. One module per view.
pub mod control;
pub mod maps;
pub mod roster;
pub mod roster_manager;
pub mod widgets;

use std::sync::Arc;

use eframe::egui::{self, Color32, RichText};
use isu_core::game_config::{config, game_order, js_string};
use serde_json::{Value, json};

use isu_control::services::Services;

/// styles.css :root colours.
pub mod c {
    use eframe::egui::Color32;
    pub const ORANGE: Color32 = Color32::from_rgb(0xf4, 0x79, 0x20);
    pub const BLACK: Color32 = Color32::from_rgb(0x09, 0x09, 0x0a);
    pub const PANEL: Color32 = Color32::from_rgb(0x15, 0x15, 0x17);
    pub const PANEL_LIGHT: Color32 = Color32::from_rgb(0x1c, 0x1c, 0x1f);
    pub const LINE: Color32 = Color32::from_rgb(0x2a, 0x2a, 0x2e);
    pub const MUTED: Color32 = Color32::from_rgb(0x8d, 0x8d, 0x96);
    pub const TEXT: Color32 = Color32::from_rgb(0xf7, 0xf7, 0xf8);
    pub const RED: Color32 = Color32::from_rgb(0xe5, 0x48, 0x4d);
}

pub fn hex(s: &str) -> Color32 {
    let h = s.trim_start_matches('#');
    if h.len() == 6 {
        if let Ok(v) = u32::from_str_radix(h, 16) {
            return Color32::from_rgb((v >> 16) as u8, (v >> 8) as u8, v as u8);
        }
    }
    c::ORANGE
}

pub fn accent(game: &str) -> Color32 {
    hex(config(game).and_then(|c| c["accent"].as_str()).unwrap_or("#f47920"))
}

pub struct App {
    pub svc: Arc<Services>,
    pub toast: Option<(String, std::time::Instant)>,
    /// destructive button waiting for its second click (app.js armedConfirm)
    pub armed: Option<(String, std::time::Instant)>,
    pub addresses: Vec<String>,
    pub rm: roster_manager::Ui,
}

const NAV: [(&str, &str); 5] = [("control", "Match Control"), ("maps", "Map Pool"), ("roster", "Rosters"), ("outputs", "OBS Outputs"), ("stage", "Displays")];

impl App {
    pub fn new(cc: &eframe::CreationContext<'_>, svc: Arc<Services>) -> Self {
        let mut v = egui::Visuals::dark();
        v.panel_fill = c::BLACK;
        v.window_fill = c::PANEL;
        v.extreme_bg_color = c::BLACK;
        v.widgets.noninteractive.bg_stroke = egui::Stroke::new(1.0, c::LINE);
        v.selection.bg_fill = c::ORANGE.gamma_multiply(0.6);
        cc.egui_ctx.set_visuals(v);
        let ctx = cc.egui_ctx.clone();
        *svc.core.repaint.lock().unwrap() = Some(Box::new(move || ctx.request_repaint()));
        Self { svc, toast: None, armed: None, addresses: local_addresses(), rm: roster_manager::Ui::default() }
    }

    pub fn state(&self) -> Value {
        self.svc.core.state()
    }

    /// commit(mutator, message) on the core.
    pub fn commit(&self, msg: &str, f: impl FnOnce(&mut Value)) {
        self.svc.core.commit(msg, f);
    }

    /// persistState() for view-only changes (activeView, selectedGame...).
    pub fn set_and_persist(&self, f: impl FnOnce(&mut Value)) {
        f(&mut self.svc.core.lock().state);
        self.svc.core.persist();
    }

    pub fn toast(&mut self, m: &str) {
        self.toast = Some((m.to_string(), std::time::Instant::now()));
    }

    /// A button that needs two clicks (data-confirm). Returns true on the confirming click.
    pub fn confirm_button(&mut self, ui: &mut egui::Ui, id: &str, label: &str, confirm: &str) -> bool {
        let armed = self.armed.as_ref().is_some_and(|(a, t)| a == id && t.elapsed().as_secs() < 4);
        let b = egui::Button::new(RichText::new(if armed { confirm } else { label }).strong()).fill(if armed { c::RED } else { c::PANEL_LIGHT });
        if ui.add(b).clicked() {
            if armed {
                self.armed = None;
                return true;
            }
            self.armed = Some((id.to_string(), std::time::Instant::now()));
        }
        false
    }

    /// One control button through isu_core::controls (same as the app.js handler).
    pub fn control(&self, action: &str, index: usize, winner: Option<f64>) {
        let now = isu_control::core::now_ms();
        let mut msg = None;
        self.svc.core.commit("Changes saved", |st| msg = isu_core::controls::apply(st, action, index, winner, now));
        if let Some(m) = msg {
            self.svc.core.lock().save_status = m;
        }
    }

    fn sidebar(&mut self, ui: &mut egui::Ui, st: &Value) {
        let game = st["selectedGame"].as_str().unwrap_or("overwatch").to_string();
        let cfg = config(&game).unwrap();
        ui.add_space(14.0);
        ui.horizontal(|ui| {
            let (r, _) = ui.allocate_exact_size(egui::vec2(36.0, 36.0), egui::Sense::hover());
            ui.painter().rect_filled(r, 6.0, c::ORANGE);
            ui.painter().text(r.center(), egui::Align2::CENTER_CENTER, "IS", egui::FontId::proportional(16.0), Color32::BLACK);
            ui.vertical(|ui| {
                ui.label(RichText::new("ISU ESPORTS").strong().color(c::TEXT));
                ui.label(RichText::new("Broadcast Control").small().color(c::MUTED));
            });
        });
        ui.add_space(18.0);
        ui.label(RichText::new("ACTIVE TITLE").small().color(c::MUTED));
        let mut pick = game.clone();
        egui::ComboBox::from_id_salt("game-select").width(ui.available_width()).selected_text(format!("{}  {}", js_string(cfg.get("shortName")), js_string(cfg.get("name")))).show_ui(ui, |ui| {
            for k in game_order() {
                ui.selectable_value(&mut pick, k.to_string(), js_string(config(k).unwrap().get("name")));
            }
        });
        if pick != game {
            // game-select change: selectedGame + RL connection follow
            self.svc.core.commit("Active title changed", |s| s["selectedGame"] = json!(pick));
            self.svc.sync_rl();
        }
        ui.add_space(18.0);
        ui.label(RichText::new("PRODUCTION").small().color(c::MUTED));
        let view = st["activeView"].as_str().unwrap_or("control").to_string();
        for (key, label) in NAV.iter().chain([("settings", "Settings")].iter()) {
            if *key == "settings" {
                ui.add_space(24.0);
            }
            let active = view == *key;
            let b = egui::Button::new(RichText::new(*label).color(if active { c::TEXT } else { c::MUTED })).fill(if active { c::PANEL_LIGHT } else { Color32::TRANSPARENT }).min_size(egui::vec2(ui.available_width(), 30.0));
            if ui.add(b).clicked() && !active {
                let k = key.to_string();
                self.set_and_persist(|s| s["activeView"] = json!(k));
            }
        }
        ui.with_layout(egui::Layout::bottom_up(egui::Align::LEFT), |ui| {
            ui.add_space(10.0);
            ui.label(RichText::new("IDAHO STATE UNIVERSITY • POCATELLO").small().color(c::MUTED));
            ui.label(RichText::new("LOCAL SYSTEM · Ready for production").small().color(c::MUTED));
        });
    }

    fn topbar(&mut self, ui: &mut egui::Ui, st: &Value) {
        let game = st["selectedGame"].as_str().unwrap_or("overwatch");
        let cfg = config(game).unwrap();
        let name = js_string(cfg.get("name"));
        let (title, sub) = match st["activeView"].as_str().unwrap_or("control") {
            "maps" => ("Map Pool".to_string(), format!("Plan and record the {name} series")),
            "roster" => ("Team Rosters".into(), "Manage Home and Away Varsity/JV lineups".into()),
            "outputs" => ("OBS Outputs".into(), "Browser-source graphics and live asset status".into()),
            "stage" => ("Displays".into(), "Audience displays: game mirror or NDI presets from OBS".into()),
            "settings" => ("Workspace Settings".into(), "Defaults, data, and application information".into()),
            _ => ("Match Control".into(), "Run the live score and match state".into()),
        };
        ui.horizontal(|ui| {
            ui.vertical(|ui| {
                ui.label(RichText::new(format!("{} / CONTROL CENTER", js_string(cfg.get("shortName")))).small().color(accent(game)));
                ui.heading(RichText::new(title).strong().color(c::TEXT));
                ui.label(RichText::new(sub).color(c::MUTED));
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let live = st.pointer(&format!("/games/{game}/match/live")) == Some(&json!(true));
                let pill = egui::Button::new(RichText::new(if live { "● LIVE" } else { "● OFF AIR" }).strong().color(if live { Color32::WHITE } else { c::MUTED })).fill(if live { c::RED } else { c::PANEL_LIGHT });
                ui.add_enabled(false, pill);
                let can_undo = !self.svc.core.lock().history.is_empty();
                if ui.add_enabled(can_undo, egui::Button::new("↶ Undo")).on_hover_text("Undo last change (Ctrl+Z)").clicked() && self.svc.core.undo() {
                    self.toast("Last change undone");
                }
                let status = self.svc.core.lock().save_status.clone();
                ui.label(RichText::new(format!("● {status}")).small().color(c::MUTED));
            });
        });
    }
}

impl eframe::App for App {
    fn ui(&mut self, root: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = root.ctx().clone();
        if ctx.input(|i| i.modifiers.command && i.key_pressed(egui::Key::Z)) && !ctx.egui_wants_keyboard_input() && self.svc.core.undo() {
            self.toast("Last change undone");
        }
        let st = self.state();
        let overlay_err = self.svc.overlay_error.lock().unwrap().clone();
        egui::Panel::left("sidebar").exact_size(232.0).frame(egui::Frame::NONE.fill(c::PANEL).inner_margin(14.0)).show(root, |ui| self.sidebar(ui, &st));
        egui::CentralPanel::default().frame(egui::Frame::NONE.fill(c::BLACK).inner_margin(egui::Margin::symmetric(26, 16))).show(root, |ui| {
            self.topbar(ui, &st);
            if !overlay_err.is_empty() {
                ui.colored_label(c::RED, format!("Overlay server could not start: {overlay_err}"));
            }
            ui.separator();
            egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| match st["activeView"].as_str().unwrap_or("control") {
                "control" => control::view(self, ui, &st),
                "maps" => maps::view(self, ui, &st),
                "roster" => roster::view(self, ui, &st),
                other => {
                    ui.add_space(30.0);
                    ui.label(RichText::new(format!("The {other} view is next on the port list.")).color(c::MUTED));
                }
            });
        });
        if let Some((m, t)) = &self.toast {
            if t.elapsed().as_millis() < 2200 {
                egui::Area::new("toast".into()).anchor(egui::Align2::CENTER_BOTTOM, [0.0, -24.0]).show(&ctx, |ui| {
                    egui::Frame::NONE.fill(c::PANEL_LIGHT).stroke(egui::Stroke::new(1.0, c::ORANGE)).corner_radius(6.0).inner_margin(10.0).show(ui, |ui| ui.label(RichText::new(m).color(c::TEXT)));
                });
                ctx.request_repaint_after(std::time::Duration::from_millis(100));
            } else {
                self.toast = None;
            }
        }
    }

    fn on_exit(&mut self) {
        if self.svc.core.lock().save_at.is_some() {
            self.svc.core.persist();
        }
        self.svc.shutdown();
    }
}

/// network:get-addresses (IPv4, not internal).
pub fn local_addresses() -> Vec<String> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok();
    s.and_then(|s| s.connect("10.255.255.255:1").ok().and_then(|_| s.local_addr().ok())).map(|a| vec![a.ip().to_string()]).unwrap_or_default()
}

/// overlayOutputUrl(details): only the known overlay pages, query values that are set.
pub fn overlay_url(name: &str, query: &[(&str, &str)]) -> Option<String> {
    if !["scoreboard", "map-pool", "roster", "program", "clean"].contains(&name) {
        return None;
    }
    let q: Vec<String> = query.iter().filter(|(_, v)| !v.is_empty()).map(|(k, v)| format!("{k}={}", v.replace(' ', "+"))).collect();
    Some(format!("http://127.0.0.1:3174/overlays/{name}.html{}", if q.is_empty() { String::new() } else { format!("?{}", q.join("&")) }))
}

/// Open a page in the default browser (the Electron app opened its own preview window).
pub fn open_url(url: &str) {
    if url.is_empty() {
        return;
    }
    #[cfg(windows)]
    let _ = std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
}
