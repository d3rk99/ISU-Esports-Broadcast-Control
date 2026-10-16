//! Displays view (src/displays-view.js renderDisplaysView + app.js display-* handlers) and the OBS
//! part of main.cjs (obs-displays.json, save / setup / status).
use eframe::egui::{self, Color32, RichText};
use isu_core::game_config::{js_string, num_or_zero, truthy};
use serde_json::{Value, json};

use super::widgets::{cols, field_label, heading, panel, secondary_button, select, title};
use super::{App, c};

/// DISPLAY_PRESETS (id, label, description), src/display-presets.js.
pub const PRESETS: [(&str, &str, &str); 6] = [
    ("idle", "Idle", "Station number on a moving background"),
    ("intro", "Team intro", "Both teams with VS, on every station"),
    ("player", "Player cards", "Each station shows the roster player sitting at it"),
    ("banner", "Team banners", "Stations 1-5 = home banner, 6-10 = away, one canvas across 5 screens"),
    ("score", "Series score", "Series score with both logos"),
    ("black", "Black", "All black"),
];

fn s(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        x => js_string(x),
    }
}

/// obsDisplays (window state): saved config (publicObs), draft fields, status, message / error.
#[derive(Default)]
pub struct Obs {
    pub host: String,
    pub port: String,
    pub password: String,
    pub format: String,
    pub controller_url: String,
    pub loaded: bool,
    pub has_password: bool,
    pub status: Option<Value>,
    pub message: String,
    pub error: String,
    pub busy: Option<std::sync::mpsc::Receiver<(Option<Value>, String, String)>>,
    pub key: String,
}

fn or(v: String, d: &str) -> String {
    if v.is_empty() { d.to_string() } else { v }
}

fn or_n(v: f64, d: f64) -> f64 {
    if v == 0.0 || v.is_nan() { d } else { v }
}

/// publicObs(c).
pub fn public_obs(c: &Value) -> Value {
    let host = or(s(c.get("host")), "127.0.0.1");
    let port = or_n(num_or_zero(c.get("port")), 4455.0);
    let res = or(s(c.get("resolution")), "1280x720");
    let fps = or_n(num_or_zero(c.get("fps")), 30.0);
    json!({ "host": host, "port": port, "hasPassword": truthy(c.get("password")), "resolution": res, "fps": fps, "controllerUrl": s(c.get("controllerUrl")) })
}

/// obs-displays:save(d).
pub fn save_obs(app: &App, d: &Value) -> Value {
    let prev = app.svc.core.files.read("obs-displays.json").unwrap_or(json!({}));
    let port = isu_core::game_config::to_number(d.get("port")).filter(|x| *x != 0.0 && !x.is_nan()).unwrap_or(4455.0).round().clamp(1.0, 65535.0);
    let pw = s(d.get("password"));
    let host = or(s(d.get("host")).trim().chars().take(255).collect(), "127.0.0.1");
    let password = if truthy(d.get("clearPassword")) { String::new() } else if !pw.is_empty() { pw } else { s(prev.get("password")) };
    let res = s(d.get("resolution"));
    let resolution = if res == "1280x720" || res == "1920x1080" { res } else { "1280x720".to_string() };
    let f = num_or_zero(d.get("fps"));
    let fps = if f == 30.0 || f == 60.0 { f } else { 30.0 };
    let url: String = s(d.get("controllerUrl")).trim().chars().take(255).collect();
    let next = json!({ "host": host, "port": port, "password": password, "resolution": resolution, "fps": fps, "controllerUrl": url });
    app.svc.core.files.write("obs-displays.json", &next);
    public_obs(&next)
}

pub fn view(app: &mut App, ui: &mut egui::Ui, st: &Value) {
    let ds = app.svc.core.lock().display_status.clone();
    if !app.obs.loaded {
        let p = public_obs(&app.svc.core.files.read("obs-displays.json").unwrap_or(json!({})));
        app.obs.host = s(p.get("host"));
        app.obs.port = s(p.get("port"));
        app.obs.format = format!("{}@{}", s(p.get("resolution")), s(p.get("fps")));
        app.obs.controller_url = s(p.get("controllerUrl"));
        app.obs.has_password = p["hasPassword"] == true;
        app.obs.loaded = true;
    }
    if let Some(rx) = &app.obs.busy {
        if let Ok((status, msg, err)) = rx.try_recv() {
            if status.is_some() {
                app.obs.status = status;
            }
            app.obs.message = msg;
            app.obs.error = err;
            app.obs.busy = None;
        } else {
            ui.ctx().request_repaint_after(std::time::Duration::from_millis(200));
        }
    }
    let stations = ds["stations"].as_array().cloned().unwrap_or_default();
    let row = |n: usize| stations.iter().find(|x| x["station"].as_u64() == Some(n as u64)).cloned().unwrap_or(json!({ "station": n, "online": false, "mode": "ndi", "source": format!("ISU Stage {n:02}") }));
    let preset_of = |n: usize| st.pointer(&format!("/displays/stations/{n}/preset")).and_then(Value::as_str).unwrap_or("idle").to_string();
    let header = format!("{} of 10 display clients online · port {}{}", num_or_zero(ds.get("onlineCount")), { let p = num_or_zero(ds.get("port")); if p == 0.0 { 3178.0 } else { p } }, if truthy(ds.get("error")) { format!(" · {}", s(ds.get("error"))) } else { String::new() });
    heading(ui, "01", "Stations", &header, |ui| {
        if ui.add(secondary_button("ALL: NDI")).clicked() {
            mode(app, "all", "ndi");
        }
        if ui.add(secondary_button("ALL: GAME MIRROR")).clicked() {
            mode(app, "all", "mirror");
        }
    });
    for (key, list) in [("1-5", [1usize, 2, 3, 4, 5]), ("6-10", [6, 7, 8, 9, 10])] {
        panel(ui, |ui| {
            let all_noise = |v: bool| list.iter().all(|n| truthy(row(*n).get("noise")) == v);
            let all_mode = |m: &str| list.iter().all(|n| row(*n)["mode"] == m);
            heading(ui, "", &format!("Stations {key}"), "Game mirror or NDI preset for these five only", |ui| {
                if pill(ui, "OFF", all_noise(false), BLUE).clicked() { noise(app, key, false); }
                if pill(ui, "ON", all_noise(true), PINK).clicked() { noise(app, key, true); }
                ui.label(RichText::new("PINK NOISE").size(9.5).strong().extra_letter_spacing(1.3).color(PINK));
                ui.add_space(12.0);
                if pill(ui, &format!("{key}: NDI"), all_mode("ndi"), BLUE).clicked() { mode(app, key, "ndi"); }
                if pill(ui, &format!("{key}: GAME MIRROR"), all_mode("mirror"), BLUE).clicked() { mode(app, key, "mirror"); }
            });
            // .disp-grid: 5 equal cards
            cols(ui, &[-1.0; 5], 10.0, |j, ui| station_card(app, ui, &row(list[j]), &preset_of(list[j]), list[j]));
            ui.add_space(4.0);
            preset_buttons(app, ui, key, &list.iter().map(|n| preset_of(*n)).collect::<Vec<_>>(), false);
        });
    }
    // 02 pink noise all
    panel(ui, |ui| {
        title(ui, "02", "Pink noise (player headsets)", "Players hear game + comms in their IEMs; the headset on top plays pink noise so they can't hear the room. Each display client plays it on the headset output picked in its settings (Ctrl+Alt+S), capped by that PC's max volume.");
        ui.horizontal(|ui| {
            let all_noise = |v: bool| (1..=10).all(|n| truthy(row(n).get("noise")) == v);
            ui.label(RichText::new("PINK NOISE · ALL 10").size(9.5).strong().extra_letter_spacing(1.3).color(PINK));
            if pill(ui, "ON", all_noise(true), PINK).clicked() { noise(app, "all", true); }
            if pill(ui, "OFF", all_noise(false), BLUE).clicked() { noise(app, "all", false); }
            ui.add_space(18.0);
            field_label(ui, "Volume (%)");
            let mut vol = stations.first().and_then(|x| x.get("noiseVolume")).and_then(Value::as_f64).unwrap_or(30.0).round() as i64;
            ui.spacing_mut().slider_width = 260.0;
            let r = ui.add(egui::Slider::new(&mut vol, 0..=100).step_by(5.0).suffix("%"));
            if r.drag_stopped() || (r.changed() && !r.dragged()) {
                // volume only: every station keeps its own on/off
                app.svc.displays.set_noise("all", &json!("keep"), Some(&json!(vol)));
                app.toast(&format!("Pink noise volume {vol}%"));
            }
            let playing = stations.iter().filter(|x| x["online"] == true && x["noise"] == true && x["noiseState"] == "playing").count();
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| ui.label(RichText::new(format!("{playing} of 10 playing")).size(11.0).color(c::DIM)));
        });
    });
    // 03 presets all
    panel(ui, |ui| {
        title(ui, "03", "NDI presets (all 10 stations)", "What OBS draws on every ISU Stage NN feed. Changes are instant: the pages update live, OBS never reloads.");
        preset_buttons(app, ui, "all", &(1..=10).map(preset_of).collect::<Vec<_>>(), true);
        ui.add_space(6.0);
        ui.horizontal(|ui| {
            ui.label(RichText::new("Team banners:").size(11.0).color(GREY));
            for (t, l) in [("", "AUTO (1-5 home · 6-10 away)"), ("home", "ALL HOME"), ("away", "ALL AWAY")] {
                if pill(ui, l, false, BLUE).clicked() {
                    preset(app, "all", "banner", t);
                }
            }
        });
    });
    obs_panel(app, ui);
    ui.label(RichText::new("The station key (optional password for the screen PCs) is in Settings → Network & keys.").size(10.5).color(c::DIM));
}

/// The key every Display Client must enter (Settings → Network & keys).
pub fn display_key_row(app: &mut App, ui: &mut egui::Ui) {
    let ds = app.svc.core.lock().display_status.clone();
    cols(ui, &[-1.0, 120.0], 8.0, |j, ui| match j {
        0 => {
            let hint = if ds["keyRequired"] == true { "a key is set · type a new one, or leave empty and save to remove it" } else { "no key: any station PC can connect" };
            ui.add(egui::TextEdit::singleline(&mut app.obs.key).password(true).hint_text(hint).desired_width(ui.available_width()).margin(egui::vec2(10.0, 9.0)));
        }
        _ => {
            if ui.add(secondary_button("SAVE").min_size(egui::vec2(ui.available_width(), 35.0))).clicked() {
                let k = app.obs.key.clone();
                app.svc.core.files.save_display_key(&k);
                app.svc.displays.set_key(&k);
                app.obs.key.clear();
                app.toast(if k.is_empty() { "Station key removed" } else { "Station key saved: every station PC must use it" });
            }
        }
    });
}

/// displays-view colours (its own blue/pink accent set in styles.css).
const BLUE: Color32 = Color32::from_rgb(0x2d, 0x8c, 0xff);
const PINK: Color32 = Color32::from_rgb(0xe0, 0x5a, 0xa8);
const GREY: Color32 = Color32::from_rgb(0x8a, 0x94, 0xa3);

/// .disp-modes button / .disp-noise-row button: 6 px radius, active = blue (or pink for noise).
fn pill(ui: &mut egui::Ui, label: &str, on: bool, accent: Color32) -> egui::Response {
    let (bg, bd, fg) = if on { (accent.gamma_multiply(0.3), accent, Color32::WHITE) } else { (Color32::from_rgb(0x18, 0x1b, 0x21), Color32::from_rgb(0x2c, 0x32, 0x3b), Color32::from_rgb(0xcf, 0xd6, 0xdf)) };
    ui.add(egui::Button::new(RichText::new(label).size(11.0).strong().color(fg)).fill(bg).stroke(egui::Stroke::new(1.0, bd)).corner_radius(6.0).min_size(egui::vec2(0.0, 30.0)))
}

fn mode(app: &mut App, station: &str, m: &str) {
    let r = app.svc.displays.set_mode(station, m, "");
    if r["ok"] != true {
        app.toast(&s(r.get("error")));
    }
}

fn noise(app: &mut App, station: &str, on: bool) {
    let r = app.svc.displays.set_noise(station, &json!(on), None);
    if r["ok"] != true {
        app.toast(&s(r.get("error")));
    } else {
        app.toast(&format!("Pink noise {station}: {}", if on { "on" } else { "off" }));
    }
}

fn preset(app: &mut App, station: &str, p: &str, team: &str) {
    let label = if station.chars().all(|c| c.is_ascii_digit()) { format!("{:0>2}", station) } else { station.to_string() };
    let (st2, p2, t2) = (station.to_string(), p.to_string(), team.to_string());
    app.commit(&format!("Displays {label}: {p}"), |st| { let _ = isu_core::display_presets::apply_display_preset(st, &st2, &p2, &t2); });
}

/// .disp-preset-grid: 6 equal preset cards (label + description on the big grid, label only per group).
fn preset_buttons(app: &mut App, ui: &mut egui::Ui, group: &str, current: &[String], with_desc: bool) {
    cols(ui, &[-1.0; 6], 8.0, |j, ui| {
        let (id, label, desc) = PRESETS[j];
        let on = current.iter().all(|p| p == id);
        let h = if with_desc { 64.0 } else { 38.0 };
        let (r, resp) = ui.allocate_exact_size(egui::vec2(ui.available_width(), h), egui::Sense::click());
        let p = ui.painter();
        let (bg, bd) = if on { (Color32::from_rgb(0x2a, 0x17, 0x08), c::ORANGE) } else if resp.hovered() { (Color32::from_rgb(0x1b, 0x1f, 0x25), Color32::from_rgb(0x3b, 0x42, 0x4d)) } else { (Color32::from_rgb(0x15, 0x18, 0x1d), Color32::from_rgb(0x2c, 0x32, 0x3b)) };
        p.rect(r, 8.0, bg, egui::Stroke::new(1.0, bd), egui::StrokeKind::Inside);
        if with_desc {
            p.text(egui::pos2(r.left() + 12.0, r.top() + 17.0), egui::Align2::LEFT_CENTER, label, egui::FontId::proportional(13.0), Color32::from_rgb(0xe9, 0xee, 0xf4));
            let g = p.layout(desc.to_string(), egui::FontId::proportional(10.0), GREY, r.width() - 24.0);
            p.galley(egui::pos2(r.left() + 12.0, r.top() + 29.0), g, GREY);
        } else {
            p.text(r.center(), egui::Align2::CENTER_CENTER, label, egui::FontId::proportional(12.0), Color32::from_rgb(0xe9, 0xee, 0xf4));
        }
        let resp = resp.on_hover_text(desc);
        resp.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Button, true, label));
        if resp.clicked() {
            preset(app, group, id, "");
        }
    });
}

fn station_card(app: &mut App, ui: &mut egui::Ui, row: &Value, preset_now: &str, n: usize) {
    let online = row["online"] == true;
    let m = s(row.get("mode"));
    let health = if !online { "offline".to_string() } else if truthy(row.get("error")) { s(row.get("error")) } else if m == "mirror" { "mirroring".into() } else if row["state"] == "receiving" { format!("NDI {} fps", s(row.get("fps"))).trim().to_string() } else { let x = s(row.get("state")); if x.is_empty() { "connecting".into() } else { x } };
    let (dot, txt) = if !online { (Color32::from_rgb(0x44, 0x44, 0x44), GREY) } else if truthy(row.get("error")) { (Color32::from_rgb(0xff, 0x5a, 0x5a), Color32::from_rgb(0xff, 0x8a, 0x8a)) } else if m == "mirror" || row["state"] == "receiving" { (Color32::from_rgb(0x2f, 0xd2, 0x7a), Color32::from_rgb(0x6e, 0xe7, 0xa8)) } else { (Color32::from_rgb(0xff, 0xce, 0x47), Color32::from_rgb(0xff, 0xdf, 0x7a)) };
    egui::Frame::NONE.fill(Color32::from_rgb(0x11, 0x13, 0x17)).stroke(egui::Stroke::new(1.0, Color32::from_rgb(0x26, 0x2a, 0x31))).corner_radius(8.0).inner_margin(12.0).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.spacing_mut().item_spacing.y = 7.0;
        ui.horizontal(|ui| {
            ui.label(RichText::new(format!("{n:02}")).strong().italics().size(20.0).color(c::TEXT));
            ui.add(egui::Label::new(RichText::new({ let h = s(row.get("hostname")); if h.is_empty() { "no client".into() } else { h } }).size(11.0).color(GREY)).truncate());
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let (r, resp) = ui.allocate_exact_size(egui::vec2(10.0, 10.0), egui::Sense::hover());
                ui.painter().circle_filled(r.center(), 5.0, dot);
                resp.on_hover_text(&health);
            });
        });
        ui.add(egui::Label::new(RichText::new(&health).size(11.0).color(txt)).truncate());
        cols(ui, &[-1.0, -1.0], 6.0, |j, ui| {
            let (lbl, md) = if j == 0 { ("GAME MIRROR", "mirror") } else { ("NDI", "ndi") };
            if ui.add(pill_btn(lbl, m == md, BLUE).min_size(egui::vec2(ui.available_width(), 30.0))).clicked() {
                mode(app, &n.to_string(), md);
            }
        });
        let on = truthy(row.get("noise"));
        let warn = on && online && row["noiseState"] != "playing";
        let title_txt = if !online { "Station offline: it starts as soon as the client connects".to_string() } else if truthy(row.get("noiseError")) { s(row.get("noiseError")) } else { format!("{}{} · {}%", { let x = s(row.get("noiseState")); if x.is_empty() { "off".into() } else { x } }, if truthy(row.get("noiseDevice")) { format!(" · {}", s(row.get("noiseDevice"))) } else { String::new() }, row.get("noiseVolume").and_then(Value::as_f64).unwrap_or(30.0)) };
        let lbl = format!("{}{}", if on { "PINK NOISE ON" } else { "PINK NOISE OFF" }, if warn { " · !" } else { "" });
        if ui.add(pill_btn(&lbl, on, PINK).min_size(egui::vec2(ui.available_width(), 28.0))).on_hover_text(title_txt).clicked() {
            noise(app, &n.to_string(), !on);
        }
        let options: Vec<(String, String)> = PRESETS.iter().map(|p| (p.0.to_string(), p.1.to_string())).collect();
        if let Some(pick) = select(ui, &format!("dp{n}"), "NDI preset", &preset_now.to_string(), &options) {
            // data-display-preset change: keeps the station's team
            let p2 = pick.clone();
            app.commit(&format!("Display {n:02}: {pick}"), |st| {
                let team = st.pointer(&format!("/displays/stations/{n}/team")).and_then(Value::as_str).unwrap_or("").to_string();
                let _ = isu_core::display_presets::apply_display_preset(st, &n.to_string(), &p2, &team);
            });
        }
        let feed = app.obs.status.as_ref().and_then(|o| o["stations"].as_array().and_then(|a| a.iter().find(|x| x["station"].as_u64() == Some(n as u64)).cloned()));
        let src = { let x = s(row.get("source")); if x.is_empty() { format!("ISU Stage {n:02}") } else { x } };
        let (tail, col) = feed.as_ref().map_or((String::new(), Color32::from_rgb(0x6b, 0x76, 0x86)), |f| if f["active"] == true && f["ndiOn"] == true { (" · OBS sending".into(), Color32::from_rgb(0x6e, 0xe7, 0xa8)) } else { (" · OBS not sending".into(), Color32::from_rgb(0xff, 0x8a, 0x8a)) });
        ui.add(egui::Label::new(RichText::new(format!("{src}{tail}")).size(10.0).color(col)).truncate());
    });
}

fn pill_btn(label: &str, on: bool, accent: Color32) -> egui::Button<'static> {
    let (bg, bd, fg) = if on { (accent.gamma_multiply(0.3), accent, Color32::WHITE) } else { (Color32::from_rgb(0x18, 0x1b, 0x21), Color32::from_rgb(0x2c, 0x32, 0x3b), Color32::from_rgb(0xcf, 0xd6, 0xdf)) };
    egui::Button::new(RichText::new(label.to_string()).size(10.5).strong().color(fg)).fill(bg).stroke(egui::Stroke::new(1.0, bd)).corner_radius(6.0)
}

fn obs_panel(app: &mut App, ui: &mut egui::Ui) {
    panel(ui, |ui| {
        title(ui, "04", "OBS (draws + sends the NDI feeds)", "Needs OBS 31.1+ with DistroAV and Tools → WebSocket Server on. SET UP OBS makes 10 scenes with a browser page each and a DistroAV NDI filter named ISU Stage 01-10. Run it again any time; it only adds what's missing.");
        let edit = |ui: &mut egui::Ui, label: &str, v: &mut String, hint: &str, pw: bool| {
            field_label(ui, label);
            ui.add(egui::TextEdit::singleline(v).password(pw).hint_text(hint).desired_width(ui.available_width()).margin(egui::vec2(10.0, 9.0)));
        };
        cols(ui, &[-1.0, 90.0, -1.0, 170.0, -1.3], 10.0, |j, ui| match j {
            0 => edit(ui, "OBS PC", &mut app.obs.host, "", false),
            1 => edit(ui, "Port", &mut app.obs.port, "", false),
            2 => {
                let hint = if app.obs.has_password { "saved · blank keeps it" } else { "from OBS WebSocket settings" };
                edit(ui, "Password", &mut app.obs.password, hint, true);
            }
            3 => {
                let options: Vec<(String, String)> = ["1280x720@30", "1280x720@60", "1920x1080@30", "1920x1080@60"].iter().map(|f| (f.to_string(), f.replace('x', "×").replace('@', " @ "))).collect();
                if let Some(v) = select(ui, "obs-format", "Output", &app.obs.format, &options) {
                    app.obs.format = v;
                }
            }
            _ => edit(ui, "Controller URL for OBS", &mut app.obs.controller_url, "blank = this PC's LAN IP :3174", false),
        });
        ui.add_space(4.0);
        ui.horizontal(|ui| {
            let busy = app.obs.busy.is_some();
            for (action, label) in [("save", "SAVE"), ("setup", "SET UP OBS"), ("check", "CHECK OBS")] {
                let b = if action == "setup" { super::widgets::primary_button(label) } else { secondary_button(label) };
                if ui.add_enabled(!busy, b).clicked() {
                    obs_action(app, action);
                }
            }
            if busy {
                ui.spinner();
            }
        });
        let obs = app.obs.status.clone();
        let summary = obs.as_ref().map_or("OBS not checked yet".to_string(), |o| format!("OBS {} · {}/{} fps · CPU {}% · render {} ms · skipped {}/{} · {}/10 feeds live", s(o.get("resolution")), s(o.get("fps")), s(o.get("targetFps")), s(o.get("cpu")), s(o.get("renderMs")), s(o.get("skippedRender")), s(o.get("skippedOutput")), o["stations"].as_array().map_or(0, |a| a.iter().filter(|x| x["active"] == true && x["ndiOn"] == true).count())));
        let (txt, bad) = if !app.obs.error.is_empty() { (app.obs.error.clone(), true) } else if !app.obs.message.is_empty() { (app.obs.message.clone(), false) } else { (summary, false) };
        ui.add(egui::Label::new(RichText::new(txt).size(11.0).color(if bad { c::RED } else { c::DIM })).wrap());
    });
}

/// obs-displays-save / setup / check: save first, then talk to OBS on the runtime (no UI freeze).
fn obs_action(app: &mut App, action: &str) {
    let (res, fps) = app.obs.format.split_once('@').map(|(r, f)| (r.to_string(), f.to_string())).unwrap_or(("1280x720".into(), "30".into()));
    app.obs.error.clear();
    app.obs.message = match action { "setup" => "Setting up OBS…".into(), "check" => "Checking OBS…".into(), _ => String::new() };
    let saved = save_obs(app, &json!({ "host": app.obs.host, "port": app.obs.port, "password": app.obs.password, "resolution": res, "fps": isu_core::game_config::js_number(&fps).unwrap_or(30.0), "controllerUrl": app.obs.controller_url }));
    app.obs.has_password = saved["hasPassword"] == true;
    app.obs.password.clear();
    if action == "save" {
        app.obs.message = "Saved".into();
        return;
    }
    let cfg = app.svc.core.files.read("obs-displays.json").unwrap_or(json!({}));
    let lan = app.addresses.first().cloned().unwrap_or_else(|| "127.0.0.1".into());
    let (tx, rx) = std::sync::mpsc::channel();
    app.obs.busy = Some(rx);
    let action = action.to_string();
    app.svc.rt.spawn(async move {
        let mut c = isu_net::obs::ObsClient::default();
        let host = { let h = s(cfg.get("host")); if h.is_empty() { "127.0.0.1".to_string() } else { h } };
        let port = { let p = num_or_zero(cfg.get("port")); if p == 0.0 { 4455 } else { p as u16 } };
        let r: Result<(Option<Value>, String), isu_net::obs::ObsError> = async {
            c.connect(&host, port, &s(cfg.get("password"))).await?;
            let mut msg = String::new();
            if action == "setup" {
                let (w, h) = s(cfg.get("resolution")).split_once('x').map(|(a, b)| (a.parse().unwrap_or(1280), b.parse().unwrap_or(720))).unwrap_or((1280, 720));
                let url = { let u = s(cfg.get("controllerUrl")); if u.is_empty() { format!("http://{lan}:3174") } else { u } };
                let mut set = isu_net::obs::Setup::new(&url);
                set.width = w;
                set.height = h;
                set.fps = { let f = num_or_zero(cfg.get("fps")); if f == 0.0 { 30 } else { f as u32 } };
                let r = isu_net::obs::setup_stage_scenes(&mut c, &set).await?;
                let names = r["ndiNames"].as_array().cloned().unwrap_or_default();
                let added = r["log"].as_array().map_or(0, Vec::len);
                msg = format!("OBS {}: {} NDI feeds ({} … {}){}", s(r.get("obsVersion")), names.len(), s(names.first()), s(names.last()), if added > 0 { format!(" · added {added}") } else { " · nothing missing".into() });
            }
            let st = isu_net::obs::stage_status(&mut c, 10).await?;
            Ok((Some(st), msg))
        }.await;
        c.close();
        let _ = tx.send(match r { Ok((st, msg)) => (st, msg, String::new()), Err(e) => (None, String::new(), e.message) });
    });
}
