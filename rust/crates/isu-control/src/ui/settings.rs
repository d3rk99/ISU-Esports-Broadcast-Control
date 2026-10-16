//! Settings view (app.js renderSettings + its handlers): reset game, output displays, program fade,
//! spectated-player receiver (valorant-board-panel.js spectatePanel), Companion API.
use eframe::egui::{self, Color32, RichText};
use isu_core::game_config::{config, js_string, num_or_zero, truthy};
use serde_json::{Value, json};

use super::widgets::{panel, text_field, title};
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
    title(ui, "01", "Workspace data", "Local-first settings for a dependable broadcast desk");
    ui.columns(3, |cols| {
        panel(&mut cols[0], |ui| {
            ui.label(RichText::new("Reset active game").strong());
            ui.label(RichText::new(format!("Restore {name} match, map, and roster data to its defaults.")).small().color(c::MUTED));
            if app.confirm_button(ui, "reset-game", "RESET GAME", "Click again: wipes this game") {
                app.control("reset-game", 0, None);
            }
        });
        panel(&mut cols[1], |ui| {
            ui.label(RichText::new("Automatic local save").strong());
            ui.label(RichText::new("All edits persist on this computer as soon as they are made. No account or network is required.").small().color(c::MUTED));
            ui.label(RichText::new("ENABLED").strong().color(Color32::from_rgb(80, 200, 120)));
        });
        panel(&mut cols[2], |ui| {
            ui.label(RichText::new("Application").strong());
            ui.label(RichText::new("ISU Esports Broadcast Control · Rocket League live telemetry · Companion control API").small().color(c::MUTED));
            ui.label(RichText::new(format!("v{} (Rust)", env!("CARGO_PKG_VERSION"))).strong());
        });
    });
    ui.add_space(10.0);
    // 02 output displays
    title(ui, "02", "Direct output displays", "Choose which displays receive fullscreen Fill and Key output windows");
    if app.monitors.is_none() {
        let o = std::sync::Arc::clone(&app.svc.outputs);
        app.monitors = Some(Vec::new());
        let tx = app.monitors_tx.clone();
        std::thread::spawn(move || { let _ = tx.send(o.displays()); });
    }
    let monitors = app.monitors.clone().unwrap_or_default();
    let ods = app.svc.outputs.settings();
    panel(ui, |ui| {
        ui.horizontal(|ui| {
            ui.vertical(|ui| {
                ui.label(RichText::new("HDMI / SDI OUTPUT ROUTING").small().color(c::ORANGE));
                ui.label(RichText::new("Projection screens").strong().size(16.0));
                ui.label(RichText::new("Paired outputs open two synced 1920 × 1080 fullscreen windows. Set display scaling to 100% for video outputs when possible.").small().color(c::MUTED));
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| { ui.label(RichText::new(format!("● {} DISPLAYS", monitors.len())).strong()); });
        });
        ui.horizontal_wrapped(|ui| {
            for (prop, label, fallback, note) in [("fillDisplayId", "FILL SCREEN", "Primary display", "Used by Fill and the left side of Paired dual output."), ("keyDisplayId", "KEY SCREEN", "Second display", "Used by Key and the right side of Paired dual output."), ("gameOverlayDisplayId", "GAME OVERLAY SCREEN", "Primary display", "Used by the transparent Valorant alignment overlay.")] {
                ui.vertical(|ui| {
                    ui.label(RichText::new(label).small().color(c::MUTED));
                    let cur = s(ods.get(prop));
                    let mut pick = cur.clone();
                    let shown = monitors.iter().find(|m| s(m.get("id")) == cur).map(|m| s(m.get("label"))).unwrap_or_else(|| fallback.to_string());
                    egui::ComboBox::from_id_salt(prop).width(260.0).selected_text(shown).show_ui(ui, |ui| {
                        ui.selectable_value(&mut pick, String::new(), fallback);
                        for m in &monitors {
                            ui.selectable_value(&mut pick, s(m.get("id")), s(m.get("label")));
                        }
                    });
                    ui.label(RichText::new(note).small().color(c::MUTED));
                    if pick != cur {
                        let mut n = ods.clone();
                        n[prop] = json!(pick);
                        app.svc.outputs.save_settings(&n);
                        app.toast("Output display settings saved");
                    }
                });
            }
            ui.vertical(|ui| {
                ui.label(RichText::new("GAME OVERLAY SIZE").small().color(c::MUTED));
                let cur = s(ods.get("gameOverlayResolution"));
                let mut pick = cur.clone();
                egui::ComboBox::from_id_salt("gores").selected_text(if cur == "1440" { "2560 x 1440" } else { "1920 x 1080" }).show_ui(ui, |ui| {
                    ui.selectable_value(&mut pick, "1080".to_string(), "1920 x 1080");
                    ui.selectable_value(&mut pick, "1440".to_string(), "2560 x 1440");
                });
                if pick != cur {
                    let mut n = ods.clone();
                    n["gameOverlayResolution"] = json!(pick);
                    app.svc.outputs.save_settings(&n);
                    app.toast("Output display settings saved");
                }
            });
            let mut auto = ods["autoOpenProgramOutput"] != false;
            let lbl = if auto { "Start Program outputs (open Fill and Key when the controller starts)" } else { "Start Program outputs (projectors stay closed until opened manually)" };
            if ui.checkbox(&mut auto, lbl).changed() {
                let mut n = ods.clone();
                n["autoOpenProgramOutput"] = json!(auto);
                app.svc.outputs.save_settings(&n);
                app.toast("Output display settings saved");
            }
            let t = format!("{:.1}", { let x = num_or_zero(st.get("programTransitionSeconds")); if x == 0.0 { 1.0 } else { x } });
            if let Some(v) = text_field(ui, "fade", "PROGRAM FADE OUT (seconds)", &t, 4, 60.0) {
                let x = isu_core::game_config::js_number(&v).filter(|x| *x != 0.0 && !x.is_nan()).unwrap_or(1.0).clamp(0.1, 5.0);
                app.commit("Program transition saved", |st| st["programTransitionSeconds"] = isu_core::game_config::jnum(x));
            }
        });
    });
    ui.add_space(10.0);
    // 02b spectated player receiver
    title(ui, "02b", "Spectated player receiver", "For the Game Bridge on a player-POV spectator PC (VALORANT and Overwatch). Rocket League gets the spectated player from its API. Companion: $(isu:spectated_station), $(isu:spectated_name)");
    panel(ui, |ui| spectate_panel(app, ui));
    ui.add_space(10.0);
    // 03 Companion
    title(ui, "03", "Bitfocus Companion API", "Authenticated LAN control for Stream Deck buttons, variables, and future native Companion modules");
    let cset = app.svc.companion.settings();
    let cst = app.svc.companion.status();
    panel(ui, |ui| {
        let state = if cst["listening"] == true { "ONLINE" } else if cset.enabled { "ERROR" } else { "OFF" };
        ui.horizontal(|ui| {
            ui.vertical(|ui| {
                ui.label(RichText::new("REMOTE CONTROL SERVICE").small().color(c::ORANGE));
                ui.label(RichText::new("Companion connection").strong().size(16.0));
                ui.label(RichText::new("The API is disabled until you turn it on. Keep the private key out of screenshots and public profiles.").small().color(c::MUTED));
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| { ui.label(RichText::new(format!("● {state}")).strong().color(if state == "ONLINE" { Color32::from_rgb(80, 200, 120) } else if state == "ERROR" { c::RED } else { c::MUTED })); });
        });
        let mut next: Option<Value> = None;
        let base = json!({ "enabled": cset.enabled, "port": cset.port, "token": cset.token });
        ui.horizontal_wrapped(|ui| {
            let mut en = cset.enabled;
            if ui.checkbox(&mut en, if cset.enabled { "Enable LAN API (accepting authenticated control requests)" } else { "Enable LAN API (no remote control connections allowed)" }).changed() {
                let mut n = base.clone(); n["enabled"] = json!(en); next = Some(n);
            }
            if let Some(v) = text_field(ui, "cport", "API PORT (default 3176)", &cset.port.to_string(), 5, 70.0) {
                let p = isu_core::game_config::js_number(&v).filter(|x| *x != 0.0 && !x.is_nan()).unwrap_or(3176.0).round().clamp(1024.0, 65535.0);
                let mut n = base.clone(); n["port"] = json!(p); next = Some(n);
            }
            ui.vertical(|ui| {
                ui.label(RichText::new("PRIVATE API KEY").small().color(c::MUTED));
                let mut k = app.companion_key.clone().unwrap_or_else(|| cset.token.clone());
                let r = ui.add(egui::TextEdit::singleline(&mut k).password(true).desired_width(260.0));
                if r.changed() { app.companion_key = Some(k.clone()); }
                if r.lost_focus() && k.trim() != cset.token {
                    let mut n = base.clone(); n["token"] = json!(k.trim()); next = Some(n);
                    app.companion_key = None;
                } else if r.lost_focus() { app.companion_key = None; }
            });
            if ui.button("GENERATE").clicked() {
                let mut n = base.clone(); n["token"] = json!(isu_server::companion::create_token()); next = Some(n);
                app.toast("New private API key generated");
            }
        });
        if let Some(n) = next {
            let saved = app.svc.core.files.save_companion(&n);
            let c2 = std::sync::Arc::clone(&app.svc.companion);
            let st = app.svc.rt.block_on(async move { c2.configure(&saved).await });
            app.toast(if st["listening"] == true { "Companion API settings saved" } else if n["enabled"] == true { "Companion API could not start" } else { "Companion API disabled" });
        }
        let host = app.addresses.first().cloned().unwrap_or_else(|| "127.0.0.1".into());
        let url = format!("http://{host}:{}/api/companion", cset.port);
        ui.horizontal(|ui| {
            ui.label(RichText::new("COMPANION BASE URL").small().color(c::MUTED));
            ui.label(RichText::new(&url).monospace());
            if ui.button("COPY URL").clicked() { ui.ctx().copy_text(url.clone()); app.toast("Companion URL copied"); }
            if ui.button("COPY KEY").clicked() { ui.ctx().copy_text(cset.token.clone()); app.toast("Private API key copied"); }
        });
        if truthy(cst.get("error")) {
            ui.colored_label(c::RED, s(cst.get("error")));
        }
        ui.label(RichText::new("Generic HTTP setup: base URL above · header X-ISU-API-Key: your-key · POST /action with a JSON body · GET /variables · GET /capabilities · GET /events").small().color(c::MUTED));
    });
}

/// valorant-board-panel.js spectatePanel + the data-sp-cfg / sp-generate-key handlers.
pub fn spectate_panel(app: &mut App, ui: &mut egui::Ui) {
    let st = app.svc.spectate.status();
    let norm = |v: &Value| { let s = isu_net::spectate::normalize_settings(v); json!({ "enabled": s.enabled, "port": s.port, "token": s.token }) };
    let settings = app.svc.core.files.merged("spectate-receiver.json", norm);
    let who = app.svc.core.lock().spectate["spectated"].clone();
    let mut next: Option<(Value, String)> = None;
    ui.label(RichText::new("SPECTATED PLAYER (player-POV spectator → Companion) · VALORANT & Overwatch").strong());
    ui.horizontal_wrapped(|ui| {
        let mut en = settings["enabled"] == true;
        if ui.checkbox(&mut en, "SPECTATED PLAYER RECEIVER (for the Game Bridge on the player-view spectator PC)").changed() {
            next = Some((json!({ "enabled": en }), if en { "Spectated-player receiver on" } else { "Spectated-player receiver off" }.into()));
        }
        let port = { let p = num_or_zero(settings.get("port")); if p == 0.0 { 3175.0 } else { p } };
        if let Some(v) = text_field(ui, "spport", "PORT", &port.to_string(), 5, 70.0) {
            next = Some((json!({ "port": isu_core::game_config::js_number(v.trim()).unwrap_or(f64::NAN) }), "Receiver settings saved".into()));
        }
        if let Some(v) = text_field(ui, "sptoken", "BRIDGE KEY", &s(settings.get("token")), 128, 260.0) {
            next = Some((json!({ "token": v.trim() }), "Receiver settings saved".into()));
        }
        if ui.button("GENERATE").clicked() {
            next = Some((json!({ "token": super::control::random_key() }), "Bridge key generated: paste it into the Game Bridge".into()));
        }
        let addr = app.addresses.join(" / ");
        ui.label(RichText::new(format!("This PC: {}", if addr.is_empty() { "address unavailable".into() } else { addr })).small().color(c::MUTED));
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
    ui.label(RichText::new(format!("{} · {} · NOW: {}{station}", state.to_uppercase(), { let m = s(st.get("message")); if m.is_empty() { "off".into() } else { m } }, if name.is_empty() { "—".into() } else { name })).color(tone));
}
