//! The controller window (src/app.js render + src/styles.css look) in egui. One module per view.
pub mod control;
pub mod displays;
pub mod maps;
pub mod outputs;
pub mod readers;
pub mod settings;
pub mod roster;
pub mod roster_manager;
pub mod widgets;

use std::sync::Arc;

use eframe::egui::{self, Color32, RichText};
use isu_core::game_config::{config, game_order, js_string};
use serde_json::{Value, json};

use crate::services::Services;

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
    pub const INPUT: Color32 = Color32::from_rgb(0x10, 0x10, 0x12);
    pub const BORDER: Color32 = Color32::from_rgb(0x3a, 0x3a, 0x40);
    pub const BUTTON: Color32 = Color32::from_rgb(0x1b, 0x1b, 0x1e);
    pub const BUTTON_HOVER: Color32 = Color32::from_rgb(0x24, 0x24, 0x28);
    pub const LABEL: Color32 = Color32::from_rgb(0x8a, 0x8a, 0x93);
    pub const DIM: Color32 = Color32::from_rgb(0x6f, 0x6f, 0x77);
}

/// styles.css base look on every egui widget: inputs/selects (#101012, 1px #35353a, 2 px radius,
/// 35 px tall, orange focus), buttons (#1b1b1e, #3a3a40, 37 px), 11 px text, 10 px gaps.
pub fn apply_theme(ctx: &egui::Context) {
    use egui::{CornerRadius, FontFamily, FontId, Stroke, TextStyle};
    ctx.all_styles_mut(|st| {
        st.visuals = egui::Visuals::dark();
        let v = &mut st.visuals;
        v.panel_fill = c::BLACK;
        v.window_fill = c::PANEL;
        v.window_stroke = Stroke::new(1.0, c::LINE);
        v.extreme_bg_color = c::INPUT;
        v.faint_bg_color = c::PANEL_LIGHT;
        v.selection.bg_fill = c::ORANGE.gamma_multiply(0.45);
        v.selection.stroke = Stroke::new(1.0, c::ORANGE);
        v.hyperlink_color = c::ORANGE;
        let r = CornerRadius::same(2);
        let w = &mut v.widgets;
        w.noninteractive.bg_stroke = Stroke::new(1.0, c::LINE);
        w.noninteractive.fg_stroke = Stroke::new(1.0, c::TEXT);
        w.noninteractive.corner_radius = r;
        w.inactive.bg_fill = c::BUTTON;
        w.inactive.weak_bg_fill = c::BUTTON;
        w.inactive.bg_stroke = Stroke::new(1.0, c::BORDER);
        w.inactive.fg_stroke = Stroke::new(1.0, Color32::from_rgb(0xe8, 0xe8, 0xeb));
        w.inactive.corner_radius = r;
        w.hovered.bg_fill = c::BUTTON_HOVER;
        w.hovered.weak_bg_fill = c::BUTTON_HOVER;
        w.hovered.bg_stroke = Stroke::new(1.0, Color32::from_rgb(0x55, 0x55, 0x5d));
        w.hovered.fg_stroke = Stroke::new(1.0, Color32::WHITE);
        w.hovered.corner_radius = r;
        w.hovered.expansion = 0.0;
        w.active.bg_fill = c::BUTTON_HOVER;
        w.active.weak_bg_fill = c::BUTTON_HOVER;
        w.active.bg_stroke = Stroke::new(1.0, c::ORANGE);
        w.active.fg_stroke = Stroke::new(1.0, Color32::WHITE);
        w.active.corner_radius = r;
        w.active.expansion = 0.0;
        w.open = w.active;
        let sp = &mut st.spacing;
        sp.item_spacing = egui::vec2(10.0, 8.0);
        sp.button_padding = egui::vec2(14.0, 6.0);
        sp.interact_size = egui::vec2(36.0, 32.0);
        sp.combo_width = 180.0;
        sp.text_edit_width = 180.0;
        sp.indent = 14.0;
        st.text_styles = [
            (TextStyle::Small, FontId::new(10.0, FontFamily::Proportional)),
            (TextStyle::Body, FontId::new(13.0, FontFamily::Proportional)),
            (TextStyle::Button, FontId::new(12.0, FontFamily::Proportional)),
            (TextStyle::Monospace, FontId::new(12.0, FontFamily::Monospace)),
            (TextStyle::Heading, FontId::new(22.0, FontFamily::Proportional)),
        ].into();
    });
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
    pub obs: displays::Obs,
    pub toast_tx: std::sync::mpsc::Sender<String>,
    toast_rx: std::sync::mpsc::Receiver<String>,
    pub monitors: Option<Vec<Value>>,
    pub monitors_tx: std::sync::mpsc::Sender<Vec<Value>>,
    monitors_rx: std::sync::mpsc::Receiver<Vec<Value>>,
    pub companion_key: Option<String>,
    pub ow_debug: std::sync::Arc<std::sync::Mutex<Option<(Value, Option<readers::DebugTex>)>>>,
}

const NAV: [(&str, &str); 5] = [("control", "Match Control"), ("maps", "Map Pool"), ("roster", "Rosters"), ("outputs", "OBS Outputs"), ("stage", "Displays")];

impl App {
    pub fn new(ctx: &egui::Context, svc: Arc<Services>) -> Self {
        apply_theme(ctx);
        egui_extras::install_image_loaders(ctx);
        let ctx = ctx.clone();
        *svc.core.repaint.lock().unwrap() = Some(Arc::new(move || ctx.request_repaint()));
        let (toast_tx, toast_rx) = std::sync::mpsc::channel();
        let (monitors_tx, monitors_rx) = std::sync::mpsc::channel();
        Self { svc, toast: None, armed: None, addresses: local_addresses(), rm: roster_manager::Ui::default(), obs: displays::Obs::default(), toast_tx, toast_rx, monitors: None, monitors_tx, monitors_rx, companion_key: None, ow_debug: std::sync::Arc::default() }
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
        let now = crate::core::now_ms();
        let mut msg = None;
        self.svc.core.commit("Changes saved", |st| msg = isu_core::controls::apply(st, action, index, winner, now));
        if let Some(m) = msg {
            self.svc.core.lock().save_status = m;
        }
    }

    fn sidebar(&mut self, ui: &mut egui::Ui, st: &Value) {
        let game = st["selectedGame"].as_str().unwrap_or("overwatch").to_string();
        let cfg = config(&game).unwrap();
        let acc = accent(&game);
        ui.add_space(12.0);
        // .brand-lockup
        ui.horizontal(|ui| {
            let (r, _) = ui.allocate_exact_size(egui::vec2(46.0, 42.0), egui::Sense::hover());
            let p = ui.painter();
            p.rect_filled(r, 0.0, Color32::from_rgb(0x17, 0x17, 0x19));
            p.add(egui::Shape::convex_polygon(vec![r.left_top(), egui::pos2(r.left() + r.width() * 0.62, r.top()), egui::pos2(r.left(), r.bottom() - r.height() * 0.1)], c::ORANGE, egui::Stroke::NONE));
            p.rect_stroke(r, 0.0, egui::Stroke::new(1.0, c::ORANGE.gamma_multiply(0.45)), egui::StrokeKind::Inside);
            p.text(r.center(), egui::Align2::CENTER_CENTER, "IS", egui::FontId::proportional(19.0), Color32::WHITE);
            ui.add_space(4.0);
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = 3.0;
                ui.add_space(6.0);
                ui.label(RichText::new("ISU ESPORTS").strong().size(15.0).extra_letter_spacing(1.3).color(c::TEXT));
                ui.label(RichText::new("BROADCAST CONTROL").size(9.5).strong().extra_letter_spacing(1.1).color(Color32::from_rgb(0x79, 0x79, 0x80)));
            });
        });
        ui.add_space(26.0);
        nav_label(ui, "ACTIVE TITLE");
        // .game-picker: chip + select
        egui::Frame::NONE.fill(Color32::from_rgb(0x1c, 0x1c, 0x20)).stroke(egui::Stroke::new(1.0, Color32::from_rgb(0x46, 0x46, 0x4d))).corner_radius(4.0).inner_margin(egui::Margin::symmetric(9, 11)).show(ui, |ui| {
            ui.horizontal(|ui| {
                let chip = js_string(cfg.get("shortName"));
                let (r, _) = ui.allocate_exact_size(egui::vec2(40.0, 32.0), egui::Sense::hover());
                ui.painter().rect(r, 0.0, acc.gamma_multiply(0.32), egui::Stroke::new(1.0, acc.gamma_multiply(0.72)), egui::StrokeKind::Inside);
                ui.painter().text(r.center(), egui::Align2::CENTER_CENTER, chip, egui::FontId::proportional(10.5), Color32::WHITE);
                let mut pick = game.clone();
                egui::ComboBox::from_id_salt("game-select").width(ui.available_width()).selected_text(RichText::new(js_string(cfg.get("name"))).strong()).show_ui(ui, |ui| {
                    for k in game_order() {
                        ui.selectable_value(&mut pick, k.to_string(), js_string(config(k).unwrap().get("name")));
                    }
                });
                if pick != game {
                    // game-select change: state.selectedGame + persistState() (no undo point) + RL connection
                    self.set_and_persist(|s| s["selectedGame"] = json!(pick));
                    self.svc.sync_rl();
                }
            });
        });
        ui.add_space(26.0);
        nav_label(ui, "PRODUCTION");
        let view = st["activeView"].as_str().unwrap_or("control").to_string();
        let nav_item = |ui: &mut egui::Ui, key: &str, label: &str| {
            let active = view == key;
            let (r, resp) = ui.allocate_exact_size(egui::vec2(ui.available_width(), 44.0), egui::Sense::click());
            let p = ui.painter();
            if active {
                p.rect_filled(r, 2.0, c::ORANGE.gamma_multiply(0.10));
                p.rect_filled(egui::Rect::from_min_size(r.min, egui::vec2(2.0, r.height())), 0.0, c::ORANGE);
                p.circle_filled(egui::pos2(r.right() - 13.0, r.center().y), 2.5, c::ORANGE);
            } else if resp.hovered() {
                p.rect_filled(r, 2.0, Color32::from_rgb(0x19, 0x19, 0x1c));
            }
            let col = if active { Color32::WHITE } else if resp.hovered() { Color32::from_rgb(0xdc, 0xdc, 0xe0) } else { Color32::from_rgb(0x85, 0x85, 0x8d) };
            p.text(egui::pos2(r.left() + 16.0, r.center().y), egui::Align2::LEFT_CENTER, label, egui::FontId::proportional(12.5), col);
            resp.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Button, true, label));
            if resp.clicked() && !active {
                let k = key.to_string();
                self.set_and_persist(|s| s["activeView"] = json!(k));
            }
        };
        ui.spacing_mut().item_spacing.y = 3.0;
        for (key, label) in NAV {
            nav_item(ui, key, label);
        }
        // Settings + system state + footer: pinned to the bottom when there is room, otherwise
        // right after the nav (never on top of it: the sidebar scrolls instead).
        let footer_h = 44.0 + 3.0 + 8.0 + 46.0 + 8.0 + 30.0;
        let gap = (ui.available_height() - footer_h).max(16.0);
        ui.add_space(gap);
        nav_item(ui, "settings", "Settings");
        ui.add_space(4.0);
        ui.separator();
        ui.horizontal(|ui| {
            let (r, _) = ui.allocate_exact_size(egui::vec2(8.0, 28.0), egui::Sense::hover());
            ui.painter().circle_filled(r.center(), 3.5, Color32::from_rgb(0x70, 0xcd, 0x6a));
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = 2.0;
                ui.label(RichText::new("LOCAL SYSTEM").size(10.0).strong().extra_letter_spacing(1.2).color(Color32::from_rgb(0x94, 0x94, 0x9b)));
                ui.label(RichText::new("Ready for production").size(11.0).color(Color32::from_rgb(0x5e, 0x5e, 0x65)));
            });
        });
        ui.separator();
        ui.vertical_centered(|ui| ui.label(RichText::new("IDAHO STATE UNIVERSITY • POCATELLO").size(9.0).strong().extra_letter_spacing(1.0).color(Color32::from_rgb(0x45, 0x45, 0x4a))));
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
        egui::Frame::NONE.inner_margin(egui::Margin { left: 36, right: 36, top: 22, bottom: 18 }).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.vertical(|ui| {
                    ui.spacing_mut().item_spacing.y = 4.0;
                    ui.label(RichText::new(format!("{} / CONTROL CENTER", js_string(cfg.get("shortName")))).size(10.0).strong().extra_letter_spacing(1.4).color(accent(game)));
                    ui.label(RichText::new(title).strong().size(24.0).color(c::TEXT));
                    ui.label(RichText::new(sub).size(11.5).color(c::DIM));
                });
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let live = st.pointer(&format!("/games/{game}/match/live")) == Some(&json!(true));
                    let (fg, bd, bg) = if live { (Color32::from_rgb(0xff, 0x6b, 0x63), Color32::from_rgb(0xd9, 0x47, 0x3e), Color32::from_rgb(0x2a, 0x13, 0x12)) } else { (c::MUTED, c::BORDER, c::BUTTON) };
                    egui::Frame::NONE.fill(bg).stroke(egui::Stroke::new(1.0, bd)).corner_radius(2.0).inner_margin(egui::Margin::symmetric(14, 9)).show(ui, |ui| {
                        ui.label(RichText::new(if live { "● LIVE" } else { "● OFF AIR" }).strong().size(11.0).extra_letter_spacing(1.0).color(fg));
                    });
                    let can_undo = !self.svc.core.lock().history.is_empty();
                    if ui.add_enabled(can_undo, egui::Button::new("↶ Undo").min_size(egui::vec2(0.0, 37.0))).on_hover_text("Undo last change (Ctrl+Z)").clicked() && self.svc.core.undo() {
                        self.toast("Last change undone");
                    }
                    let status = self.svc.core.lock().save_status.clone();
                    ui.label(RichText::new(format!("●  {status}")).size(11.0).color(c::DIM));
                });
            });
        });
        let r = ui.max_rect();
        ui.painter().hline(r.x_range(), ui.cursor().top(), egui::Stroke::new(1.0, Color32::from_rgb(0x22, 0x22, 0x25)));
    }
}

fn nav_label(ui: &mut egui::Ui, t: &str) {
    ui.label(RichText::new(t).size(10.5).strong().extra_letter_spacing(2.0).color(Color32::from_rgb(0x69, 0x69, 0x70)));
    ui.add_space(2.0);
}

impl eframe::App for App {
    fn ui(&mut self, root: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = root.ctx().clone();
        if ctx.input(|i| i.modifiers.command && i.key_pressed(egui::Key::Z)) && !ctx.egui_wants_keyboard_input() && self.svc.core.undo() {
            self.toast("Last change undone");
        }
        while let Ok(m) = self.toast_rx.try_recv() {
            self.toast(&m);
        }
        if let Ok(m) = self.monitors_rx.try_recv() {
            self.monitors = Some(m);
        }
        let st = self.state();
        let overlay_err = self.svc.overlay_error.lock().unwrap().clone();
        egui::Panel::left("sidebar").exact_size(256.0).frame(egui::Frame::NONE.fill(Color32::from_rgb(0x0f, 0x0f, 0x11)).stroke(egui::Stroke::new(1.0, Color32::from_rgb(0x28, 0x28, 0x2b))).inner_margin(egui::Margin { left: 20, right: 20, top: 16, bottom: 18 })).show(root, |ui| { egui::ScrollArea::vertical().id_salt("sidebar").auto_shrink([false, false]).show(ui, |ui| self.sidebar(ui, &st)); });
        egui::CentralPanel::default().frame(egui::Frame::NONE.fill(Color32::from_rgb(0x0d, 0x0d, 0x0f))).show(root, |ui| {
            self.topbar(ui, &st);
            if !overlay_err.is_empty() {
                ui.colored_label(c::RED, format!("Overlay server could not start: {overlay_err}"));
            }
            egui::ScrollArea::vertical().id_salt(("view", st["activeView"].as_str().unwrap_or("control").to_string())).auto_shrink([false, false]).show(ui, |ui| {
              // .view-stack: max 1440 px wide, centred, 28/36 px padding
              let w = ui.available_width();
              let inner = (w - 72.0).min(1440.0);
              ui.add_space(20.0);
              ui.horizontal_top(|ui| {
              ui.add_space(((w - inner) / 2.0).max(0.0));
              ui.vertical(|ui| {
              ui.set_width(inner);
              ui.spacing_mut().item_spacing.y = 12.0;
              match st["activeView"].as_str().unwrap_or("control") {
                "control" => control::view(self, ui, &st),
                "maps" => maps::view(self, ui, &st),
                "roster" => roster::view(self, ui, &st),
                "stage" => displays::view(self, ui, &st),
                "outputs" => outputs::view(self, ui, &st),
                "settings" => settings::view(self, ui, &st),
                other => {
                    ui.add_space(30.0);
                    ui.label(RichText::new(format!("The {other} view is next on the port list.")).color(c::MUTED));
                }
              }
              ui.add_space(60.0);
              });
              });
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
