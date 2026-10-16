//! Settings view (app.js renderSettings + its handlers): reset game, output displays, program fade,
//! spectated-player receiver (valorant-board-panel.js spectatePanel), Companion API.
use eframe::egui::{self, Color32, RichText};
use isu_core::game_config::{config, js_string, num_or_zero, truthy};
use serde_json::{Value, json};

use super::widgets::{cols, heading, panel, secondary_button, select, text_field, title, toggle};
use super::{App, c};

fn s(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        x => js_string(x),
    }
}

pub fn view(app: &mut App, ui: &mut egui::Ui, st: &Value) {
    let key = st["selectedGame"].as_str().unwrap_or("overwatch");
    let name = s(config(key).and_then(|c| c.get("name")));
    title(ui, "01", "This app", "Everything is saved on this PC automatically.");
    let card = |ui: &mut egui::Ui, icon: &str, t: &str, d: &str, right: &mut dyn FnMut(&mut egui::Ui)| {
        panel(ui, |ui| {
            cols(ui, &[46.0, -1.0, 240.0], 15.0, |j, ui| match j {
                0 => {
                    let (r, _) = ui.allocate_exact_size(egui::vec2(46.0, 46.0), egui::Sense::hover());
                    ui.painter().rect(r, 2.0, c::ORANGE.gamma_multiply(0.08), egui::Stroke::new(1.0, c::ORANGE.gamma_multiply(0.35)), egui::StrokeKind::Inside);
                    ui.painter().text(r.center(), egui::Align2::CENTER_CENTER, icon, egui::FontId::proportional(18.0), c::ORANGE);
                }
                1 => {
                    ui.add_space(4.0);
                    ui.label(RichText::new(t).strong().size(12.5).color(c::TEXT));
                    ui.add(egui::Label::new(RichText::new(d).size(11.0).color(Color32::from_rgb(0x73, 0x73, 0x7b))).wrap());
                }
                _ => {
                    ui.add_space(6.0);
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| right(ui));
                }
            });
        });
    };
    card(ui, "↻", "Reset active game", &format!("Restore {name} match, map, and roster data to its defaults."), &mut |ui| {
        if app.confirm_button(ui, "reset-game", "RESET GAME", "Click again: wipes this game") {
            app.control("reset-game", 0, None);
        }
    });
    card(ui, "✓", "Automatic local save", "All edits persist on this computer as soon as they are made. No account or network is required.", &mut |ui| {
        ui.label(RichText::new("ENABLED").strong().size(11.0).extra_letter_spacing(1.0).color(Color32::from_rgb(0x70, 0xcd, 0x6a)));
    });
    card(ui, "i", "Application", "ISU Esports Broadcast Control · Rocket League live telemetry · Companion control API", &mut |ui| {
        egui::Frame::NONE.stroke(egui::Stroke::new(1.0, c::BORDER)).inner_margin(egui::Margin::symmetric(9, 5)).show(ui, |ui| ui.label(RichText::new(format!("v{} (Rust)", env!("CARGO_PKG_VERSION"))).size(11.0).strong().color(c::MUTED)));
    });
    // 02 output displays
    title(ui, "02", "Program output screens", "Which monitors show the full-screen graphics (Fill and Key) when you press OPEN PROGRAM on the OBS Outputs page.");
    if app.monitors.is_none() {
        let o = std::sync::Arc::clone(&app.svc.outputs);
        app.monitors = Some(Vec::new());
        let tx = app.monitors_tx.clone();
        std::thread::spawn(move || { let _ = tx.send(o.displays()); });
    }
    let monitors = app.monitors.clone().unwrap_or_default();
    let ods = app.svc.outputs.settings();
    panel(ui, |ui| {
        let n = monitors.len();
        heading(ui, "", "Projection screens", "HDMI / SDI OUTPUT ROUTING · Paired outputs open two synced 1920 × 1080 fullscreen windows. Set display scaling to 100% for video outputs when possible.", |ui| {
            ui.label(RichText::new(format!("●  {n} DISPLAYS")).size(11.0).strong().color(Color32::from_rgb(0x70, 0xcd, 0x6a)));
        });
        let save = |app: &mut App, prop: &str, v: Value| {
            let mut n = ods.clone();
            n[prop] = v;
            app.svc.outputs.save_settings(&n);
            app.toast("Output display settings saved");
        };
        let screen = |app: &mut App, ui: &mut egui::Ui, prop: &str, label: &str, fallback: &str, note: &str| {
            let mut options: Vec<(String, String)> = vec![(String::new(), fallback.to_string())];
            options.extend(monitors.iter().map(|m| (s(m.get("id")), s(m.get("label")))));
            if let Some(pick) = select(ui, prop, label, &s(ods.get(prop)), &options) {
                save(app, prop, json!(pick));
            }
            ui.add(egui::Label::new(RichText::new(note).size(9.5).color(c::DIM)).wrap());
        };
        cols(ui, &[-1.0, -1.0, -1.0], 10.0, |j, ui| match j {
            0 => screen(app, ui, "fillDisplayId", "Fill screen", "Primary display", "The full picture (FILL)."),
            1 => screen(app, ui, "keyDisplayId", "Key screen", "Second display", "The cut-out mask (KEY), only for a video switcher."),
            _ => screen(app, ui, "gameOverlayDisplayId", "Game overlay screen", "Primary display", "Used by the transparent Valorant alignment overlay."),
        });
        ui.add_space(4.0);
        cols(ui, &[-1.0, -1.0, -1.0], 10.0, |j, ui| match j {
            0 => {
                let cur = s(ods.get("gameOverlayResolution"));
                if let Some(pick) = select(ui, "gores", "Game overlay size", &if cur == "1440" { cur.clone() } else { "1080".into() }, &[("1080".to_string(), "1920 x 1080".into()), ("1440".to_string(), "2560 x 1440".into())]) {
                    save(app, "gameOverlayResolution", json!(pick));
                }
                ui.label(RichText::new("Resolution of the game display you are aligning over.").size(9.5).color(c::DIM));
            }
            1 => {
                let t = format!("{:.1}", { let x = num_or_zero(st.get("programTransitionSeconds")); if x == 0.0 { 1.0 } else { x } });
                if let Some(v) = text_field(ui, "fade", "Program fade out (seconds)", &t, 4, 0.0) {
                    let x = isu_core::game_config::js_number(&v).filter(|x| *x != 0.0 && !x.is_nan()).unwrap_or(1.0).clamp(0.1, 5.0);
                    app.commit("Program transition saved", |st| st["programTransitionSeconds"] = isu_core::game_config::jnum(x));
                }
                ui.label(RichText::new("Applies when switching Scoreboard, Roster, Map Pool, or Clean.").size(9.5).color(c::DIM));
            }
            _ => {
                ui.add_space(12.0);
                let mut auto = ods["autoOpenProgramOutput"] != false;
                let note = if auto { "Open Fill and Key when the controller starts" } else { "Projectors stay closed until opened manually" };
                if toggle(ui, &mut auto, "Start Program outputs", note) {
                    save(app, "autoOpenProgramOutput", json!(auto));
                }
            }
        });
    });
    ui.add_space(10.0);
    // 03 Network & keys: every connection to another PC in one place
    title(ui, "03", "Network & keys", "Everything other PCs need to connect to this one. This PC's address on the network is shown below; type it into the other apps.");
    let addr = if app.addresses.is_empty() { "unknown (check the network cable / Wi-Fi)".to_string() } else { app.addresses.join(" / ") };
    panel(ui, |ui| {
        ui.horizontal(|ui| {
            super::widgets::field_label(ui, "This PC's address");
            ui.label(RichText::new(&addr).monospace().size(14.0).strong().color(c::TEXT));
            if ui.add(secondary_button("COPY")).clicked() { ui.ctx().copy_text(addr.clone()); app.toast("Address copied"); }
        });
    });
    // a) Rocket League game PC
    let rl = st.pointer("/games/rocketleague/rocketLeague").cloned().unwrap_or(json!({}));
    panel(ui, |ui| {
        heading(ui, "", "Rocket League game PC", "Only when Rocket League runs on another PC: that PC runs the Game Bridge app with this address, this port and this key. (Match Control → Rocket League → \"On another PC\".)", |_| {});
        cols(ui, &[140.0, -1.0, 110.0], 10.0, |j, ui| match j {
            0 => {
                if let Some(v) = text_field(ui, "net-rl-port", "Port", &s(rl.get("bridgePort")), 5, 0.0) {
                    let n = isu_core::game_config::js_number(&v).unwrap_or(f64::NAN);
                    app.commit("Rocket League settings saved", |st| st["games"]["rocketleague"]["rocketLeague"]["bridgePort"] = json!(n));
                    app.svc.sync_rl();
                }
            }
            1 => {
                if let Some(v) = text_field(ui, "net-rl-key", "Key", &s(rl.get("bridgeToken")), 128, 0.0) {
                    app.commit("Rocket League settings saved", |st| st["games"]["rocketleague"]["rocketLeague"]["bridgeToken"] = json!(v));
                    app.svc.sync_rl();
                }
            }
            _ => {
                ui.add_space(14.0);
                if ui.add(secondary_button("NEW KEY").min_size(egui::vec2(ui.available_width(), 35.0))).clicked() {
                    let k = super::control::random_key();
                    app.commit("Private bridge key generated", |st| st["games"]["rocketleague"]["rocketLeague"]["bridgeToken"] = json!(k));
                    app.svc.sync_rl();
                }
            }
        });
    });
    // b) camera (spectated player) PC
    panel(ui, |ui| {
        heading(ui, "", "Who the camera is on (VALORANT & Overwatch)", "The PC that shows a player's view runs the Game Bridge app; it tells this app which player is on screen, so the name bar and Stream Deck know. Rocket League does this by itself.", |_| {});
        spectate_panel(app, ui);
    });
    // c) stations
    panel(ui, |ui| {
        heading(ui, "", "Station screens key", "Optional password for the screen PCs (Display Client). If you set one, type the same key in each station's settings (Ctrl+Alt+S on that PC).", |_| {});
        super::displays::display_key_row(app, ui);
    });
    // d) Stream Deck
    title(ui, "04", "Stream Deck (Bitfocus Companion)", "Lets Stream Deck buttons change scores, maps and displays. Off until you turn it on.");
    let cset = app.svc.companion.settings();
    let cst = app.svc.companion.status();
    panel(ui, |ui| {
        let state = if cst["listening"] == true { "ONLINE" } else if cset.enabled { "ERROR" } else { "OFF" };
        heading(ui, "", "Companion connection", "Keep the key private (not in screenshots). In Companion, add the \"ISU Esports Broadcast Control\" connection and paste the address and key below.", |ui| {
            ui.label(RichText::new(format!("●  {state}")).size(11.0).strong().color(if state == "ONLINE" { Color32::from_rgb(0x70, 0xcd, 0x6a) } else if state == "ERROR" { c::RED } else { c::DIM }));
        });
        let mut next: Option<Value> = None;
        let base = json!({ "enabled": cset.enabled, "port": cset.port, "token": cset.token });
        cols(ui, &[-1.0, 140.0, -1.3], 10.0, |j, ui| match j {
            0 => {
                ui.add_space(12.0);
                let mut en = cset.enabled;
                if toggle(ui, &mut en, "Allow Stream Deck control", if cset.enabled { "On: Companion can control this app" } else { "Off: nothing can control this app from outside" }) {
                    let mut n = base.clone(); n["enabled"] = json!(en); next = Some(n);
                }
            }
            1 => {
                if let Some(v) = text_field(ui, "cport", "API port", &cset.port.to_string(), 5, 0.0) {
                    let p = isu_core::game_config::js_number(&v).filter(|x| *x != 0.0 && !x.is_nan()).unwrap_or(3176.0).round().clamp(1024.0, 65535.0);
                    let mut n = base.clone(); n["port"] = json!(p); next = Some(n);
                }
                ui.label(RichText::new("Default: 3176").size(9.5).color(c::DIM));
            }
            _ => {
                super::widgets::field_label(ui, "Private API key");
                cols(ui, &[-1.0, 100.0], 6.0, |k, ui| {
                    if k == 0 {
                        let mut key = app.companion_key.clone().unwrap_or_else(|| cset.token.clone());
                        let r = ui.add(egui::TextEdit::singleline(&mut key).password(true).desired_width(ui.available_width()).margin(egui::vec2(10.0, 9.0)));
                        if r.changed() { app.companion_key = Some(key.clone()); }
                        if r.lost_focus() && key.trim() != cset.token {
                            let mut n = base.clone(); n["token"] = json!(key.trim()); next = Some(n);
                            app.companion_key = None;
                        } else if r.lost_focus() { app.companion_key = None; }
                    } else if ui.add(secondary_button("GENERATE").min_size(egui::vec2(ui.available_width(), 35.0))).clicked() {
                        let mut n = base.clone(); n["token"] = json!(isu_server::companion::create_token()); next = Some(n);
                        app.toast("New private API key generated");
                    }
                });
            }
        });
        if let Some(n) = next {
            let saved = app.svc.core.files.save_companion(&n);
            let c2 = std::sync::Arc::clone(&app.svc.companion);
            let st = app.svc.rt.block_on(async move { c2.configure(&saved).await });
            app.toast(if st["listening"] == true { "Companion API settings saved" } else if n["enabled"] == true { "Companion API could not start" } else { "Companion API disabled" });
        }
        ui.add_space(4.0);
        let host = app.addresses.first().cloned().unwrap_or_else(|| "127.0.0.1".into());
        let url = format!("http://{host}:{}/api/companion", cset.port);
        egui::Frame::NONE.fill(Color32::from_rgb(0x0e, 0x0e, 0x10)).stroke(egui::Stroke::new(1.0, Color32::from_rgb(0x2d, 0x2d, 0x32))).inner_margin(egui::Margin::symmetric(12, 9)).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                ui.vertical(|ui| {
                    super::widgets::field_label(ui, "Companion base URL");
                    ui.label(RichText::new(&url).monospace().size(12.0).color(c::TEXT));
                });
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.add(secondary_button("COPY KEY")).clicked() { ui.ctx().copy_text(cset.token.clone()); app.toast("Private API key copied"); }
                    if ui.add(secondary_button("COPY URL")).clicked() { ui.ctx().copy_text(url.clone()); app.toast("Companion URL copied"); }
                });
            });
        });
        if truthy(cst.get("error")) {
            ui.colored_label(c::RED, s(cst.get("error")));
        }
        ui.add(egui::Label::new(RichText::new("Generic HTTP setup: base URL above · header X-ISU-API-Key: your-key · POST /action with a JSON body · Variables: GET /variables · Actions list: GET /capabilities · Live variables: GET /events").size(10.5).color(c::DIM)).wrap());
    });
}

/// valorant-board-panel.js spectatePanel + the data-sp-cfg / sp-generate-key handlers.
pub fn spectate_panel(app: &mut App, ui: &mut egui::Ui) {
    let st = app.svc.spectate.status();
    let norm = |v: &Value| { let s = isu_net::spectate::normalize_settings(v); json!({ "enabled": s.enabled, "port": s.port, "token": s.token }) };
    let settings = app.svc.core.files.merged("spectate-receiver.json", norm);
    let who = app.svc.core.lock().spectate["spectated"].clone();
    let mut next: Option<(Value, String)> = None;
    cols(ui, &[-1.2, 110.0, -1.4], 10.0, |j, ui| match j {
        0 => {
            ui.add_space(12.0);
            let mut en = settings["enabled"] == true;
            if toggle(ui, &mut en, "LISTEN FOR THE CAMERA PC", "Turn on when a Game Bridge reports who the camera is on") {
                next = Some((json!({ "enabled": en }), if en { "Spectated-player receiver on" } else { "Spectated-player receiver off" }.into()));
            }
        }
        1 => {
            let port = { let p = num_or_zero(settings.get("port")); if p == 0.0 { 3175.0 } else { p } };
            if let Some(v) = text_field(ui, "spport", "Port", &port.to_string(), 5, 0.0) {
                next = Some((json!({ "port": isu_core::game_config::js_number(v.trim()).unwrap_or(f64::NAN) }), "Receiver settings saved".into()));
            }
        }
        _ => {
            super::widgets::field_label(ui, "Key");
            cols(ui, &[-1.0, 100.0], 6.0, |k, ui| {
                if k == 0 {
                    if let Some(v) = text_field(ui, "sptoken", "", &s(settings.get("token")), 128, 0.0) {
                        next = Some((json!({ "token": v.trim() }), "Receiver settings saved".into()));
                    }
                } else if ui.add(secondary_button("NEW KEY").min_size(egui::vec2(ui.available_width(), 35.0))).clicked() {
                    next = Some((json!({ "token": super::control::random_key() }), "Bridge key generated: paste it into the Game Bridge".into()));
                }
            });
        }
    });
    if let Some((n, msg)) = next {
        let saved = app.svc.core.files.save_merged("spectate-receiver.json", &n, norm);
        let _g = app.svc.rt.enter();
        app.svc.spectate.configure(&saved);
        app.toast(&msg);
    }
    let state = { let x = s(st.get("state")); if x.is_empty() { "disabled".into() } else { x } };
    let tone = if state == "connected" { Color32::from_rgb(80, 200, 120) } else if state == "error" { c::RED } else { c::MUTED };
    let name = s(who.get("name"));
    let station = who.get("station").filter(|v| truthy(Some(v))).map(|v| format!(" (station {})", s(Some(v)))).unwrap_or_default();
    ui.add_space(4.0);
    ui.label(RichText::new(format!("{} · {} · CAMERA ON: {}{station}", state.to_uppercase(), { let m = s(st.get("message")); if m.is_empty() { "off".into() } else { m } }, if name.is_empty() { "—".into() } else { name })).color(tone));
}
