//! Displays view (src/displays-view.js renderDisplaysView + app.js display-* handlers) and the OBS
//! part of main.cjs (obs-displays.json, save / setup / status).
use eframe::egui::{self, Color32, RichText};
use isu_core::game_config::{js_string, num_or_zero, truthy};
use serde_json::{Value, json};

use super::widgets::{panel, title};
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
    ui.horizontal(|ui| {
        title(ui, "01", "Stations", &header);
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if ui.button("ALL: NDI").clicked() {
                mode(app, "all", "ndi");
            }
            if ui.button("ALL: GAME MIRROR").clicked() {
                mode(app, "all", "mirror");
            }
        });
    });
    for (key, list) in [("1-5", [1usize, 2, 3, 4, 5]), ("6-10", [6, 7, 8, 9, 10])] {
        panel(ui, |ui| {
            ui.horizontal(|ui| {
                title(ui, "", &format!("Stations {key}"), "Game mirror or NDI preset for these five only");
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let all_noise = |v: bool| list.iter().all(|n| truthy(row(*n).get("noise")) == v);
                    if sel_button(ui, "OFF", all_noise(false)).clicked() { noise(app, key, false); }
                    if sel_button(ui, "ON", all_noise(true)).clicked() { noise(app, key, true); }
                    ui.label(RichText::new("PINK NOISE").small().color(c::MUTED));
                    let all_mode = |m: &str| list.iter().all(|n| row(*n)["mode"] == m);
                    if sel_button(ui, &format!("{key}: NDI"), all_mode("ndi")).clicked() { mode(app, key, "ndi"); }
                    if sel_button(ui, &format!("{key}: GAME MIRROR"), all_mode("mirror")).clicked() { mode(app, key, "mirror"); }
                });
            });
            ui.horizontal_wrapped(|ui| {
                for n in list {
                    station_card(app, ui, &row(n), &preset_of(n), n);
                }
            });
            preset_buttons(app, ui, key, &list.iter().map(|n| preset_of(*n)).collect::<Vec<_>>());
        });
        ui.add_space(8.0);
    }
    // 02 pink noise all
    panel(ui, |ui| {
        title(ui, "02", "Pink noise (player headsets)", "Players hear game + comms in their IEMs; the headset on top plays pink noise so they can't hear the room. Each display client plays it on the headset output picked in its settings (Ctrl+Alt+S), capped by that PC's max volume.");
        ui.horizontal(|ui| {
            let all_noise = |v: bool| (1..=10).all(|n| truthy(row(n).get("noise")) == v);
            ui.label(RichText::new("PINK NOISE · ALL 10").small().color(c::MUTED));
            if sel_button(ui, "ON", all_noise(true)).clicked() { noise(app, "all", true); }
            if sel_button(ui, "OFF", all_noise(false)).clicked() { noise(app, "all", false); }
            let mut vol = stations.first().and_then(|x| x.get("noiseVolume")).and_then(Value::as_f64).unwrap_or(30.0).round() as i64;
            let r = ui.add(egui::Slider::new(&mut vol, 0..=100).step_by(5.0).text("VOLUME (%)"));
            if r.drag_stopped() || (r.changed() && !r.dragged()) {
                // volume only: every station keeps its own on/off
                app.svc.displays.set_noise("all", &json!("keep"), Some(&json!(vol)));
                app.toast(&format!("Pink noise volume {vol}%"));
            }
            let playing = stations.iter().filter(|x| x["online"] == true && x["noise"] == true && x["noiseState"] == "playing").count();
            ui.label(RichText::new(format!("{playing} of 10 playing")).small().color(c::MUTED));
        });
    });
    ui.add_space(8.0);
    // 03 presets all
    panel(ui, |ui| {
        title(ui, "03", "NDI presets (all 10 stations)", "What OBS draws on every ISU Stage NN feed. Changes are instant: the pages update live, OBS never reloads.");
        preset_buttons(app, ui, "all", &(1..=10).map(preset_of).collect::<Vec<_>>());
        ui.horizontal(|ui| {
            ui.label("Team banners:");
            for (t, l) in [("", "AUTO (1-5 home · 6-10 away)"), ("home", "ALL HOME"), ("away", "ALL AWAY")] {
                if ui.button(l).clicked() {
                    preset(app, "all", "banner", t);
                }
            }
        });
    });
    ui.add_space(8.0);
    obs_panel(app, ui);
    ui.add_space(8.0);
    panel(ui, |ui| {
        title(ui, "", "Display key", "Optional. If set, every display client must enter the same key in its settings (Ctrl+Alt+S on the station).");
        ui.horizontal(|ui| {
            let hint = if ds["keyRequired"] == true { "key set · type a new one or leave blank to clear" } else { "no key (open)" };
            ui.add(egui::TextEdit::singleline(&mut app.obs.key).password(true).hint_text(hint).desired_width(320.0));
            if ui.button("SAVE KEY").clicked() {
                let k = app.obs.key.clone();
                app.svc.core.files.save_display_key(&k);
                app.svc.displays.set_key(&k);
                app.obs.key.clear();
                app.toast(if k.is_empty() { "Display key cleared" } else { "Display key saved: clients must use it" });
            }
        });
    });
}

fn sel_button(ui: &mut egui::Ui, label: &str, on: bool) -> egui::Response {
    ui.add(egui::Button::new(RichText::new(label).strong().color(if on { Color32::BLACK } else { c::TEXT })).fill(if on { c::ORANGE } else { c::PANEL_LIGHT }))
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

fn preset_buttons(app: &mut App, ui: &mut egui::Ui, group: &str, current: &[String]) {
    ui.horizontal_wrapped(|ui| {
        for (id, label, desc) in PRESETS {
            let on = current.iter().all(|p| p == id);
            if sel_button(ui, label, on).on_hover_text(desc).clicked() {
                preset(app, group, id, "");
            }
        }
    });
}

fn station_card(app: &mut App, ui: &mut egui::Ui, row: &Value, preset_now: &str, n: usize) {
    let online = row["online"] == true;
    let m = s(row.get("mode"));
    let health = if !online { "offline".to_string() } else if truthy(row.get("error")) { s(row.get("error")) } else if m == "mirror" { "mirroring".into() } else if row["state"] == "receiving" { format!("NDI {} fps", s(row.get("fps"))).trim().to_string() } else { let x = s(row.get("state")); if x.is_empty() { "connecting".into() } else { x } };
    let col = if !online { c::MUTED } else if truthy(row.get("error")) { c::RED } else if m == "mirror" || row["state"] == "receiving" { Color32::from_rgb(80, 200, 120) } else { c::ORANGE };
    egui::Frame::NONE.fill(c::PANEL_LIGHT).corner_radius(6.0).inner_margin(8.0).show(ui, |ui| {
        ui.set_width(200.0);
        ui.horizontal(|ui| {
            ui.label(RichText::new(format!("{n:02}")).strong().size(18.0));
            ui.label(RichText::new({ let h = s(row.get("hostname")); if h.is_empty() { "no client".into() } else { h } }).small().color(c::MUTED));
            ui.label(RichText::new("●").color(col)).on_hover_text(&health);
        });
        ui.label(RichText::new(&health).small().color(col));
        ui.horizontal(|ui| {
            if sel_button(ui, "GAME MIRROR", m == "mirror").clicked() { mode(app, &n.to_string(), "mirror"); }
            if sel_button(ui, "NDI", m == "ndi").clicked() { mode(app, &n.to_string(), "ndi"); }
        });
        let on = truthy(row.get("noise"));
        let warn = on && online && row["noiseState"] != "playing";
        let title_txt = if !online { "Station offline: it starts as soon as the client connects".to_string() } else if truthy(row.get("noiseError")) { s(row.get("noiseError")) } else { format!("{}{} · {}%", { let x = s(row.get("noiseState")); if x.is_empty() { "off".into() } else { x } }, if truthy(row.get("noiseDevice")) { format!(" · {}", s(row.get("noiseDevice"))) } else { String::new() }, row.get("noiseVolume").and_then(Value::as_f64).unwrap_or(30.0)) };
        if sel_button(ui, &format!("{}{}", if on { "PINK NOISE ON" } else { "PINK NOISE OFF" }, if warn { " · !" } else { "" }), on).on_hover_text(title_txt).clicked() {
            noise(app, &n.to_string(), !on);
        }
        let mut pick = preset_now.to_string();
        egui::ComboBox::from_id_salt(format!("dp{n}")).selected_text(PRESETS.iter().find(|p| p.0 == preset_now).map_or("Idle", |p| p.1)).show_ui(ui, |ui| {
            for (id, label, _) in PRESETS {
                ui.selectable_value(&mut pick, id.to_string(), label);
            }
        });
        if pick != preset_now {
            // data-display-preset change: keeps the station's team
            let p2 = pick.clone();
            app.commit(&format!("Display {n:02}: {pick}"), |st| {
                let team = st.pointer(&format!("/displays/stations/{n}/team")).and_then(Value::as_str).unwrap_or("").to_string();
                let _ = isu_core::display_presets::apply_display_preset(st, &n.to_string(), &p2, &team);
            });
        }
        let feed = app.obs.status.as_ref().and_then(|o| o["stations"].as_array().and_then(|a| a.iter().find(|x| x["station"].as_u64() == Some(n as u64)).cloned()));
        let src = { let x = s(row.get("source")); if x.is_empty() { format!("ISU Stage {n:02}") } else { x } };
        let tail = feed.as_ref().map_or(String::new(), |f| if f["active"] == true && f["ndiOn"] == true { " · OBS sending".into() } else { " · OBS not sending".into() });
        ui.label(RichText::new(format!("{src}{tail}")).small().color(c::MUTED));
    });
}

fn obs_panel(app: &mut App, ui: &mut egui::Ui) {
    panel(ui, |ui| {
        title(ui, "04", "OBS (draws + sends the NDI feeds)", "Needs OBS 31.1+ with DistroAV and Tools → WebSocket Server on. SET UP OBS makes 10 scenes with a browser page each and a DistroAV NDI filter named ISU Stage 01-10. Run it again any time; it only adds what's missing.");
        ui.horizontal_wrapped(|ui| {
            for (l, v, w, pw) in [("OBS PC", &mut app.obs.host, 140.0, false), ("PORT", &mut app.obs.port, 60.0, false)] {
                ui.vertical(|ui| { ui.label(RichText::new(l).small().color(c::MUTED)); ui.add(egui::TextEdit::singleline(v).desired_width(w).password(pw)); });
            }
            let hint = if app.obs.has_password { "saved · blank keeps it" } else { "from OBS WebSocket settings" };
            ui.vertical(|ui| { ui.label(RichText::new("PASSWORD").small().color(c::MUTED)); ui.add(egui::TextEdit::singleline(&mut app.obs.password).password(true).hint_text(hint).desired_width(170.0)); });
            ui.vertical(|ui| {
                ui.label(RichText::new("OUTPUT").small().color(c::MUTED));
                let cur = app.obs.format.clone();
                egui::ComboBox::from_id_salt("obs-format").selected_text(cur.replace('x', "×").replace('@', " @ ")).show_ui(ui, |ui| {
                    for f in ["1280x720@30", "1280x720@60", "1920x1080@30", "1920x1080@60"] {
                        ui.selectable_value(&mut app.obs.format, f.to_string(), f.replace('x', "×").replace('@', " @ "));
                    }
                });
            });
            ui.vertical(|ui| { ui.label(RichText::new("CONTROLLER URL FOR OBS").small().color(c::MUTED)); ui.add(egui::TextEdit::singleline(&mut app.obs.controller_url).hint_text("blank = this PC's LAN IP :3174").desired_width(230.0)); });
        });
        ui.horizontal(|ui| {
            let busy = app.obs.busy.is_some();
            for (action, label) in [("save", "SAVE"), ("setup", "SET UP OBS"), ("check", "CHECK OBS")] {
                if ui.add_enabled(!busy, egui::Button::new(label)).clicked() {
                    obs_action(app, action);
                }
            }
        });
        let obs = app.obs.status.clone();
        let summary = obs.as_ref().map_or("OBS not checked yet".to_string(), |o| format!("OBS {} · {}/{} fps · CPU {}% · render {} ms · skipped {}/{} · {}/10 feeds live", s(o.get("resolution")), s(o.get("fps")), s(o.get("targetFps")), s(o.get("cpu")), s(o.get("renderMs")), s(o.get("skippedRender")), s(o.get("skippedOutput")), o["stations"].as_array().map_or(0, |a| a.iter().filter(|x| x["active"] == true && x["ndiOn"] == true).count())));
        let (txt, bad) = if !app.obs.error.is_empty() { (app.obs.error.clone(), true) } else if !app.obs.message.is_empty() { (app.obs.message.clone(), false) } else { (summary, false) };
        ui.label(RichText::new(txt).color(if bad { c::RED } else { c::MUTED }));
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
