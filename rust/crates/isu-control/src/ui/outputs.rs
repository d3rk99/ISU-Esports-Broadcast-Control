//! OBS Outputs view (app.js renderOutputs + take/open/preview/copy handlers).
use eframe::egui::{self, Color32, RichText};
use isu_core::game_config::{config, js_string, truthy};
use serde_json::{Value, json};

use super::widgets::{panel, title};
use super::{App, c};

fn s(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        x => js_string(x),
    }
}

const PROGRAM: [(&str, &str); 4] = [("scoreboard", "Scoreboard"), ("roster", "Roster"), ("map-pool", "Map Pool"), ("clean", "Clean")];

/// One background call to the output helper (it waits on the webview).
fn bg(app: &App, f: impl FnOnce(&crate::outputs::Outputs) -> String + Send + 'static) {
    let o = std::sync::Arc::clone(&app.svc.outputs);
    let tx = app.toast_tx.clone();
    std::thread::spawn(move || {
        let m = f(&o);
        if !m.is_empty() {
            let _ = tx.send(m);
        }
    });
}

pub fn view(app: &mut App, ui: &mut egui::Ui, st: &Value) {
    let key = st["selectedGame"].as_str().unwrap_or("overwatch");
    let game = &st["games"][key];
    let rk = st["activeRoster"].as_str().filter(|s| !s.is_empty()).unwrap_or("varsity").to_string();
    let active = st["activeOutputOverlay"].as_str().filter(|n| PROGRAM.iter().any(|p| p.0 == *n)).unwrap_or("scoreboard").to_string();
    panel(ui, |ui| {
        ui.label(RichText::new("LOCAL OVERLAY SERVER").small().color(c::ORANGE));
        ui.label(RichText::new("OBS graphics are ready").strong().size(18.0));
        ui.label(RichText::new("Open Program Output once, then take Scoreboard, Roster, or Map Pool from the controller or Companion without resetting the projectors.").color(c::MUTED));
        ui.label(RichText::new("● ONLINE · PORT 3174").strong().color(Color32::from_rgb(80, 200, 120)));
    });
    ui.add_space(8.0);
    // Program fill + key
    let pair = crate::ui::overlay_url("program", &[("output", "pair")]).unwrap();
    let fill = crate::ui::overlay_url("program", &[("output", "fill")]).unwrap();
    let keyu = crate::ui::overlay_url("program", &[("output", "key")]).unwrap();
    panel(ui, |ui| {
        ui.horizontal(|ui| {
            ui.vertical(|ui| {
                ui.label(RichText::new("Program Fill+Key Output").strong().size(16.0));
                ui.label(RichText::new("One persistent dual-screen output. Fill and Key stay open on the selected displays while the active HTML changes.").small().color(c::MUTED));
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| { ui.label(RichText::new("2x 1920 × 1080").small().color(c::MUTED)); });
        });
        ui.horizontal(|ui| {
            for (name, label) in PROGRAM {
                let on = active == name;
                if ui.add(egui::Button::new(RichText::new(label).strong().color(if on { Color32::BLACK } else { c::TEXT })).fill(if on { c::ORANGE } else { c::PANEL_LIGHT })).clicked() {
                    // take-program-output: state.activeOutputOverlay + persistState, then the windows
                    app.set_and_persist(|s| s["activeOutputOverlay"] = json!(name));
                    let l = label.to_string();
                    bg(app, move |o| if o.set_program(name) { format!("Program output: {l}") } else { format!("Selected {l}") });
                }
            }
        });
        ui.label(RichText::new(&pair).monospace().small().color(c::MUTED));
        ui.horizontal(|ui| {
            if ui.button("OPEN PROGRAM").clicked() {
                let n = active.clone();
                bg(app, move |o| if o.open_program(&n) { "Program output opened".into() } else { "Program output unavailable".into() });
            }
            for (l, u) in [("COPY FILL URL", &fill), ("COPY KEY URL", &keyu), ("COPY OBS PAIR URL", &pair)] {
                if ui.button(l).clicked() {
                    ui.ctx().copy_text(u.clone());
                }
            }
        });
    });
    ui.add_space(8.0);
    // VALORANT game alignment overlay
    let res = app.svc.outputs.settings()["gameOverlayResolution"].as_str().unwrap_or("1080").to_string();
    let setup_url = "http://127.0.0.1:3174/overlays/scoreboard.html?output=fill&setup=game".to_string();
    panel(ui, |ui| {
        ui.label(RichText::new("Valorant Game Alignment Overlay").strong().size(16.0));
        ui.label(RichText::new("Transparent setup window that sits over the game so the score/logo covers can be lined up while the native timer remains visible.").small().color(c::MUTED));
        ui.label(RichText::new(if res == "1440" { "2560 × 1440" } else { "1920 × 1080" }).small().color(c::MUTED));
        ui.label(RichText::new(&setup_url).monospace().small().color(c::MUTED));
        ui.horizontal(|ui| {
            if ui.button("TOGGLE GAME OVERLAY").clicked() {
                bg(app, |o| {
                    let r = o.open_output("scoreboard", &json!({ "output": "fill", "setup": "game" }));
                    if r["closed"] == true { "Game alignment overlay closed".into() } else if r == json!(true) { "Game alignment overlay opened".into() } else { "Game alignment overlay unavailable".into() }
                });
            }
            if ui.button("COPY URL").clicked() {
                ui.ctx().copy_text(setup_url.clone());
            }
        });
    });
    ui.add_space(8.0);
    title(ui, "01", "Browser-source outputs", &format!("Individual Fill and Key HTML graphics · current game: {}", s(config(key).and_then(|c| c.get("name")))));
    let away = truthy(game.get("showAwayRoster"));
    let fills: Vec<(&str, &str, &str, String, Vec<(String, String)>)> = vec![
        ("scoreboard", "SCORE", "Main Scoreboard Fill", "Full-color scoreboard graphic for the switcher fill input.".into(), vec![("output".into(), "fill".into())]),
        ("map-pool", "MAPS", "Map Pool Fill", "Full-color map pool graphic for the switcher fill input.".into(), vec![("output".into(), "fill".into())]),
        ("roster", "TEAM", "Roster Fill", if away { "Full-color Home and Away roster cycle for the switcher fill input.".into() } else { "Full-color roster screen for the switcher fill input.".into() }, vec![("output".into(), "fill".into()), ("program".into(), rk.clone())]),
        ("clean", "CLEAN", "Clean Fill", "Transparent no-graphic output for clearing the fill input.".into(), vec![("output".into(), "fill".into())]),
    ];
    let mut all = Vec::new();
    for f in &fills {
        all.push((f.0, f.1.to_string(), f.2.to_string(), f.3.clone(), f.4.clone(), false));
    }
    for f in &fills {
        let q: Vec<(String, String)> = f.4.iter().map(|(k, v)| if k == "output" { (k.clone(), "key".into()) } else { (k.clone(), v.clone()) }).collect();
        all.push((f.0, format!("{} KEY", f.1), f.2.replace(" Fill", " Key"), f.3.replace("Full-color", "Alpha-mask").replace("fill input", "key input"), q, true));
    }
    ui.horizontal_wrapped(|ui| {
        for (name, tag, ttl, desc, q, is_key) in &all {
            let refs: Vec<(&str, &str)> = q.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
            let url = crate::ui::overlay_url(name, &refs).unwrap();
            egui::Frame::NONE.fill(c::PANEL).stroke(egui::Stroke::new(1.0, c::LINE)).corner_radius(8.0).inner_margin(10.0).show(ui, |ui| {
                ui.set_width(330.0);
                ui.label(RichText::new(tag).small().strong().color(c::ORANGE));
                ui.label(RichText::new(ttl).strong());
                ui.label(RichText::new(desc).small().color(c::MUTED));
                ui.label(RichText::new("1920 × 1080").small().color(c::MUTED));
                ui.label(RichText::new(&url).monospace().small().color(c::MUTED));
                ui.horizontal(|ui| {
                    ui.label(RichText::new(if *is_key { "KEY OUTPUT" } else { "FILL OUTPUT" }).small().color(c::MUTED));
                    if ui.button("PREVIEW").clicked() {
                        crate::ui::open_url(&url);
                    }
                    if ui.button("OPEN WINDOW").clicked() {
                        let (n, qv) = (name.to_string(), Value::Object(q.iter().map(|(k, v)| (k.clone(), json!(v))).collect()));
                        bg(app, move |o| if o.open_output(&n, &qv) == json!(true) { "Output window opened".into() } else { "Output window unavailable".into() });
                    }
                    if ui.button("COPY URL").clicked() {
                        ui.ctx().copy_text(url.clone());
                    }
                });
            });
        }
    });
}
