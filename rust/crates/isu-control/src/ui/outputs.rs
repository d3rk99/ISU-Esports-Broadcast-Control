//! OBS Outputs view (app.js renderOutputs + take/open/preview/copy handlers).
use eframe::egui::{self, Color32, RichText};
use isu_core::game_config::{config, js_string, truthy};
use serde_json::{Value, json};

use super::widgets::{cols, title};
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

/// .output-card: thumb (tag + ghost scoreboard), info, url box, footer buttons. Returns clicked footer button index.
#[allow(clippy::too_many_arguments)]
fn output_card(ui: &mut egui::Ui, kind: &str, tag: &str, ghost: (&str, &str, &str), ttl: &str, desc: &str, size: &str, url: &str, foot: &str, buttons: &[&str], extra: impl FnOnce(&mut egui::Ui)) -> Option<usize> {
    let (bg, bd, tagc) = match kind { "key" => (Color32::from_rgb(0x18, 0x18, 0x1b), Color32::from_rgb(0x4a, 0x4a, 0x52), Color32::from_rgb(0xd8, 0xd8, 0xdd)), "pair" => (Color32::from_rgb(0x15, 0x19, 0x22), Color32::from_rgb(0x31, 0x52, 0x7c), Color32::from_rgb(0x9f, 0xc7, 0xff)), _ => (c::PANEL, Color32::from_rgb(0x2e, 0x2e, 0x33), Color32::from_rgb(0x6b, 0x6b, 0x73)) };
    let mut out = None;
    egui::Frame::NONE.fill(bg).stroke(egui::Stroke::new(1.0, bd)).corner_radius(3.0).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.spacing_mut().item_spacing.y = 0.0;
        // .output-thumb: checker + ghost scoreboard
        let (r, _) = ui.allocate_exact_size(egui::vec2(ui.available_width(), 104.0), egui::Sense::hover());
        let p = ui.painter_at(r);
        p.rect_filled(r, 0.0, Color32::from_rgb(0x12, 0x12, 0x14));
        let mut x = r.left();
        let mut k = 0;
        while x < r.right() {
            let mut y = r.top();
            let mut kk = k;
            while y < r.bottom() {
                if kk % 2 == 0 { p.rect_filled(egui::Rect::from_min_size(egui::pos2(x, y), egui::vec2(20.0, 20.0)), 0.0, Color32::from_rgb(0x17, 0x17, 0x1a)); }
                y += 20.0;
                kk += 1;
            }
            x += 20.0;
            k += 1;
        }
        p.hline(r.x_range(), r.bottom() - 0.5, egui::Stroke::new(1.0, Color32::from_rgb(0x2a, 0x2a, 0x2e)));
        let grey = kind == "key";
        let gw = 230.0;
        let gr = egui::Rect::from_center_size(r.center(), egui::vec2(gw, 32.0));
        p.rect_filled(gr, 0.0, Color32::from_rgba_unmultiplied(10, 10, 11, 240));
        let acc = if grey { Color32::from_rgb(0xaa, 0xaa, 0xaa) } else { c::ORANGE };
        p.rect_filled(egui::Rect::from_min_size(gr.min, egui::vec2(5.0, 32.0)), 0.0, acc);
        p.rect_filled(egui::Rect::from_min_size(egui::pos2(gr.right() - 5.0, gr.top()), egui::vec2(5.0, 32.0)), 0.0, acc);
        let mid = egui::Rect::from_center_size(gr.center(), egui::vec2(90.0, 32.0));
        p.rect_filled(mid, 0.0, Color32::from_rgb(0x24, 0x24, 0x28));
        p.text(egui::pos2(gr.left() + 40.0, gr.center().y), egui::Align2::CENTER_CENTER, ghost.0, egui::FontId::proportional(10.0), Color32::from_rgb(0x83, 0x83, 0x8b));
        p.text(mid.center(), egui::Align2::CENTER_CENTER, ghost.1, egui::FontId::proportional(10.0), Color32::from_rgb(0xaa, 0xaa, 0xb0));
        p.text(egui::pos2(gr.right() - 40.0, gr.center().y), egui::Align2::CENTER_CENTER, ghost.2, egui::FontId::proportional(10.0), Color32::from_rgb(0x83, 0x83, 0x8b));
        let tg = p.layout_no_wrap(tag.to_string(), egui::FontId::proportional(8.5), tagc);
        let tr = egui::Rect::from_min_size(r.min + egui::vec2(10.0, 10.0), tg.size() + egui::vec2(12.0, 8.0));
        p.rect(tr, 0.0, Color32::from_rgb(0x12, 0x12, 0x14), egui::Stroke::new(1.0, bd), egui::StrokeKind::Inside);
        p.galley(tr.min + egui::vec2(6.0, 4.0), tg, tagc);
        // .output-info
        egui::Frame::NONE.inner_margin(egui::Margin { left: 16, right: 16, top: 14, bottom: 10 }).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal_top(|ui| {
                ui.vertical(|ui| {
                    ui.set_width(ui.available_width() - 110.0);
                    ui.spacing_mut().item_spacing.y = 5.0;
                    ui.label(RichText::new(ttl).strong().size(12.5).color(c::TEXT));
                    ui.add(egui::Label::new(RichText::new(desc).size(10.5).color(Color32::from_rgb(0x6e, 0x6e, 0x76))).wrap());
                });
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| ui.label(RichText::new(size).size(9.5).strong().color(Color32::from_rgb(0x55, 0x55, 0x5c))));
            });
        });
        extra(ui);
        // .output-url
        egui::Frame::NONE.outer_margin(egui::Margin { left: 15, right: 15, top: 4, bottom: 13 }).fill(Color32::from_rgb(0x0e, 0x0e, 0x10)).stroke(egui::Stroke::new(1.0, Color32::from_rgb(0x2d, 0x2d, 0x32))).inner_margin(egui::Margin::symmetric(10, 8)).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.add(egui::Label::new(RichText::new(url).monospace().size(10.5).color(Color32::from_rgb(0x77, 0x77, 0x80))).truncate());
        });
        // footer
        egui::Frame::NONE.fill(Color32::from_rgb(0x11, 0x11, 0x13)).inner_margin(egui::Margin::symmetric(15, 9)).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                let (d, _) = ui.allocate_exact_size(egui::vec2(6.0, 6.0), egui::Sense::hover());
                ui.painter().circle_filled(d.center(), 3.0, Color32::from_rgb(0x70, 0xcd, 0x6a));
                ui.label(RichText::new(foot).size(9.5).strong().extra_letter_spacing(0.8).color(Color32::from_rgb(0x65, 0x65, 0x6c)));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.spacing_mut().item_spacing.x = 6.0;
                    for (i, b) in buttons.iter().enumerate().rev() {
                        let first = i == 0 && buttons.len() > 1;
                        let btn = egui::Button::new(RichText::new(*b).size(9.5).strong().color(if first { Color32::from_rgb(0x9a, 0x9a, 0xa2) } else { c::ORANGE })).fill(Color32::from_rgb(0x18, 0x18, 0x1b)).stroke(egui::Stroke::new(1.0, if first { Color32::from_rgb(0x30, 0x30, 0x35) } else { Color32::from_rgb(0x5c, 0x3b, 0x25) })).min_size(egui::vec2(0.0, 26.0));
                        if ui.add(btn).clicked() {
                            out = Some(i);
                        }
                    }
                });
            });
        });
    });
    out
}

pub fn view(app: &mut App, ui: &mut egui::Ui, st: &Value) {
    let key = st["selectedGame"].as_str().unwrap_or("overwatch");
    let game = &st["games"][key];
    let rk = st["activeRoster"].as_str().filter(|s| !s.is_empty()).unwrap_or("varsity").to_string();
    let active = st["activeOutputOverlay"].as_str().filter(|n| PROGRAM.iter().any(|p| p.0 == *n)).unwrap_or("scoreboard").to_string();
    // .coming-banner.live-output-banner
    let r = egui::Frame::NONE.fill(Color32::from_rgb(0x17, 0x14, 0x12)).stroke(egui::Stroke::new(1.0, c::ORANGE.gamma_multiply(0.27))).inner_margin(egui::Margin::symmetric(28, 22)).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal(|ui| {
            let (b, _) = ui.allocate_exact_size(egui::vec2(52.0, 52.0), egui::Sense::hover());
            ui.painter().rect(b, 2.0, c::ORANGE.gamma_multiply(0.1), egui::Stroke::new(1.0, c::ORANGE.gamma_multiply(0.4)), egui::StrokeKind::Inside);
            ui.painter().text(b.center(), egui::Align2::CENTER_CENTER, "</>", egui::FontId::monospace(16.0), c::ORANGE);
            ui.add_space(12.0);
            ui.vertical(|ui| {
                ui.set_width((ui.available_width() - 200.0).max(200.0));
                ui.spacing_mut().item_spacing.y = 5.0;
                ui.label(RichText::new("LOCAL OVERLAY SERVER").size(9.5).strong().extra_letter_spacing(1.3).color(c::ORANGE));
                ui.label(RichText::new("OBS graphics are ready").strong().size(20.0).color(c::TEXT));
                ui.add(egui::Label::new(RichText::new("Open Program Output once, then take Scoreboard, Roster, or Map Pool from the controller or Companion without resetting the projectors.").size(11.0).color(Color32::from_rgb(0x83, 0x83, 0x8b))).wrap());
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                egui::Frame::NONE.fill(Color32::from_rgba_unmultiplied(0x70, 0xcd, 0x6a, 14)).stroke(egui::Stroke::new(1.0, Color32::from_rgba_unmultiplied(0x70, 0xcd, 0x6a, 64))).inner_margin(egui::Margin::symmetric(11, 9)).show(ui, |ui| {
                    ui.label(RichText::new("●  ONLINE · PORT 3174").size(10.5).strong().color(Color32::from_rgb(0x70, 0xcd, 0x6a)));
                });
            });
        });
    }).response.rect;
    ui.painter().rect_filled(egui::Rect::from_min_size(r.min, egui::vec2(3.0, r.height())), 0.0, c::ORANGE);
    // Program fill + key
    let pair = crate::ui::overlay_url("program", &[("output", "pair")]).unwrap();
    let fill = crate::ui::overlay_url("program", &[("output", "fill")]).unwrap();
    let keyu = crate::ui::overlay_url("program", &[("output", "key")]).unwrap();
    let shown = PROGRAM.iter().find(|p| p.0 == active).map_or("Scoreboard", |p| p.1);
    let mut take: Option<(&str, &str)> = None;
    let clicked = output_card(ui, "pair", "PROGRAM", ("FILL", if active == "clean" { "CLEAR" } else { shown }, "KEY"), "Program Fill+Key Output", "One persistent dual-screen output. Fill and Key stay open on the selected displays while the active HTML changes.", "2x 1920 × 1080", &pair, "PROGRAM OUTPUT", &["OPEN PROGRAM", "COPY FILL URL", "COPY KEY URL", "COPY OBS PAIR URL"], |ui| {
        // .program-output-actions: 4 equal take buttons
        egui::Frame::NONE.fill(Color32::from_rgb(0x11, 0x13, 0x18)).inner_margin(egui::Margin::symmetric(15, 12)).show(ui, |ui| {
            ui.set_width(ui.available_width());
            cols(ui, &[-1.0; 4], 8.0, |j, ui| {
                let (name, label) = PROGRAM[j];
                let on = active == name;
                let b = egui::Button::new(RichText::new(label).size(10.5).strong().color(if on { Color32::WHITE } else { Color32::from_rgb(0x8e, 0x95, 0xa3) })).fill(if on { Color32::from_rgb(0x10, 0x23, 0x3e) } else { Color32::from_rgb(0x17, 0x1a, 0x20) }).stroke(egui::Stroke::new(1.0, if on { Color32::from_rgb(0x2d, 0x8c, 0xff) } else { Color32::from_rgb(0x30, 0x34, 0x3d) })).min_size(egui::vec2(ui.available_width(), 34.0));
                if ui.add(b).clicked() {
                    take = Some((name, label));
                }
            });
        });
    });
    if let Some((name, label)) = take {
        // take-program-output: state.activeOutputOverlay + persistState, then the windows
        app.set_and_persist(|s| s["activeOutputOverlay"] = json!(name));
        let l = label.to_string();
        bg(app, move |o| if o.set_program(name) { format!("Program output: {l}") } else { format!("Selected {l}") });
    }
    match clicked {
        Some(3) => { ui.ctx().copy_text(pair.clone()); app.toast("URL copied"); }
        Some(2) => { ui.ctx().copy_text(keyu.clone()); app.toast("URL copied"); }
        Some(1) => { ui.ctx().copy_text(fill.clone()); app.toast("URL copied"); }
        Some(0) => {
            let n = active.clone();
            bg(app, move |o| if o.open_program(&n) { "Program output opened".into() } else { "Program output unavailable".into() });
        }
        _ => {}
    }
    // VALORANT game alignment overlay
    let res = app.svc.outputs.settings()["gameOverlayResolution"].as_str().unwrap_or("1080").to_string();
    let setup_url = "http://127.0.0.1:3174/overlays/scoreboard.html?output=fill&setup=game".to_string();
    match output_card(ui, "fill", "VAL SETUP", ("GAME", "ALIGN", "HUD"), "Valorant Game Alignment Overlay", "Transparent setup window that sits over the game so the score/logo covers can be lined up while the native timer remains visible.", if res == "1440" { "2560 × 1440" } else { "1920 × 1080" }, &setup_url, "GAME SETUP", &["TOGGLE GAME OVERLAY", "COPY URL"], |_| {}) {
        Some(1) => { ui.ctx().copy_text(setup_url.clone()); app.toast("URL copied"); }
        Some(0) => bg(app, |o| {
            let r = o.open_output("scoreboard", &json!({ "output": "fill", "setup": "game" }));
            if r["closed"] == true { "Game alignment overlay closed".into() } else if r == json!(true) { "Game alignment overlay opened".into() } else { "Game alignment overlay unavailable".into() }
        }),
        _ => {}
    }
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
    // .output-grid: 2 columns
    for pair in all.chunks(2) {
        cols(ui, &[-1.0, -1.0], 13.0, |j, ui| {
            let Some((name, tag, ttl, desc, q, is_key)) = pair.get(j) else { return };
            let refs: Vec<(&str, &str)> = q.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
            let url = crate::ui::overlay_url(name, &refs).unwrap();
            let ghost = if *name == "roster" { "PLAYER → HERO" } else { "0 — 0" };
            match output_card(ui, if *is_key { "key" } else { "fill" }, tag, ("ISU", ghost, "OPP"), ttl, desc, "1920 × 1080", &url, if *is_key { "KEY OUTPUT" } else { "FILL OUTPUT" }, &["PREVIEW", "OPEN WINDOW", "COPY URL"], |_| {}) {
                Some(0) => crate::ui::open_url(&url),
                Some(1) => {
                    let (n, qv) = (name.to_string(), Value::Object(q.iter().map(|(k, v)| (k.clone(), json!(v))).collect()));
                    bg(app, move |o| if o.open_output(&n, &qv) == json!(true) { "Output window opened".into() } else { "Output window unavailable".into() });
                }
                Some(2) => { ui.ctx().copy_text(url.clone()); app.toast("URL copied"); }
                _ => {}
            }
        });
        ui.add_space(5.0);
    }
}
