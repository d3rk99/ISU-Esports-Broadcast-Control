//! Map Pool view (app.js renderMaps, renderValorantVetoEditor, renderMapRow).
use eframe::egui::{self, Color32, RichText};
use isu_core::controls::{Field, series_length, series_target, set_field, visible_rows};
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

fn field(app: &App, msg: Option<&str>, f: impl FnOnce(&mut Value) -> Option<String>) {
    let mut m = None;
    app.commit(msg.unwrap_or("Changes saved"), |st| m = f(st));
    if let Some(m) = m {
        app.svc.core.lock().save_status = m;
    }
}

/// formatDuration(seconds).
fn duration(v: Option<&Value>) -> String {
    let t = num_or_zero(v).floor().max(0.0) as i64;
    format!("{}:{:02}", t / 60, t % 60)
}

pub fn view(app: &mut App, ui: &mut egui::Ui, st: &Value) {
    let key = st["selectedGame"].as_str().unwrap_or("overwatch").to_string();
    let cfg = config(&key).unwrap();
    let game = &st["games"][key.as_str()];
    let target = series_target(game, &key);
    let active = num_or_zero(game.get("activeMap")) as usize;
    ui.horizontal(|ui| {
        title(ui, "01", "Series map order", &format!("{} · select, score, and advance maps", s(game.pointer("/match/format"))));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if app.confirm_button(ui, "clear-maps", "Clear results", "Click again to clear results") {
                app.control("clear-maps", 0, None);
            }
        });
    });
    panel(ui, |ui| {
        ui.horizontal(|ui| {
            let t = |i: usize, k: &str| s(game.pointer(&format!("/teams/{i}/{k}")));
            for (l, v) in [("SERIES", format!("{} {} — {} {}", t(0, "shortName"), t(0, "score"), t(1, "score"), t(1, "shortName"))), ("ACTIVE", format!("MAP {}", active + 1)), ("TARGET", format!("FIRST TO {target}"))] {
                ui.vertical(|ui| {
                    ui.set_width(220.0);
                    ui.label(RichText::new(l).small().color(c::MUTED));
                    ui.label(RichText::new(v).strong().size(18.0));
                });
            }
            ui.vertical(|ui| {
                ui.label(RichText::new("FORMAT").small().color(c::MUTED));
                let opts = cfg["formatOptions"].as_array().filter(|a| !a.is_empty() && key != "rocketleague");
                match opts {
                    Some(opts) => {
                        let length = series_length(game, &key);
                        let mut pick = length;
                        egui::ComboBox::from_id_salt("maps-format").selected_text(format!("Best of {length}")).show_ui(ui, |ui| {
                            for o in opts.iter().filter_map(Value::as_f64) {
                                ui.selectable_value(&mut pick, o, format!("Best of {o}"));
                            }
                        });
                        if pick != length {
                            app.commit(&format!("Format set to Best of {pick}"), |st| isu_core::controls::sync_format(st, pick));
                        }
                    }
                    None => {
                        ui.label(RichText::new(s(game.pointer("/match/format"))).strong().size(18.0));
                    }
                }
            });
        });
    });
    ui.add_space(10.0);
    if key == "valorant" && game.get("veto").is_some() {
        veto_editor(app, ui, game, cfg);
        ui.add_space(10.0);
    }
    let rows = game["mapRows"].as_array().cloned().unwrap_or_default();
    for i in 0..visible_rows(game, &key) {
        map_row(app, ui, game, cfg, &rows[i], i, active);
        ui.add_space(6.0);
    }
    ui.label(RichText::new("LIVE OUTPUT  Changes on this page are sent to the Map Pool browser source immediately.").small().color(c::MUTED));
}

fn map_combo(ui: &mut egui::Ui, id: String, current: &str, options: &[String], none_label: &str) -> Option<String> {
    let mut pick = current.to_string();
    egui::ComboBox::from_id_salt(id).width(180.0).selected_text(if current.is_empty() { none_label.to_string() } else { current.to_string() }).show_ui(ui, |ui| {
        ui.selectable_value(&mut pick, String::new(), none_label);
        for o in options {
            ui.selectable_value(&mut pick, o.clone(), o);
        }
    });
    (pick != current).then_some(pick)
}

fn map_row(app: &mut App, ui: &mut egui::Ui, game: &Value, cfg: &Value, row: &Value, i: usize, active: usize) {
    let is_active = i == active;
    let done = !row.get("winner").is_none_or(Value::is_null);
    let fill = if is_active { c::PANEL_LIGHT } else { c::PANEL };
    egui::Frame::NONE.fill(fill).stroke(egui::Stroke::new(1.0, if is_active { c::ORANGE } else { c::LINE })).corner_radius(8.0).inner_margin(10.0).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal(|ui| {
            let b = egui::Button::new(RichText::new(format!("{}\n{:02}", if is_active { "LIVE" } else if done { "FINAL" } else { "MAP" }, i + 1)).strong()).min_size(egui::vec2(64.0, 48.0)).fill(if is_active { c::ORANGE.gamma_multiply(0.4) } else { c::PANEL_LIGHT });
            if ui.add(b).clicked() {
                app.control("activate-map", i, None);
            }
            let modes: Vec<String> = cfg["modes"].as_array().into_iter().flatten().filter_map(|m| m.as_str().map(str::to_string)).collect();
            ui.vertical(|ui| {
                ui.label(RichText::new("MODE").small().color(c::MUTED));
                if let Some(v) = map_combo(ui, format!("mode{i}"), &s(row.get("mode")), &modes, "TBD") {
                    field(app, None, |st| set_field(st, Field::MapProp { row: i, prop: "mode", value: &v }));
                }
            });
            let mut maps: Vec<String> = cfg["maps"].as_array().into_iter().flatten().filter_map(|m| m.as_str().map(str::to_string)).collect();
            let cur = s(row.get("map"));
            if !cur.is_empty() && !maps.contains(&cur) {
                maps.insert(0, cur.clone());
            }
            ui.vertical(|ui| {
                ui.label(RichText::new("MAP / STAGE").small().color(c::MUTED));
                if let Some(v) = map_combo(ui, format!("map{i}"), &cur, &maps, "TBD") {
                    field(app, None, |st| set_field(st, Field::MapProp { row: i, prop: "map", value: &v }));
                }
            });
            ui.add_space(12.0);
            let t = |k: usize| s(game.pointer(&format!("/teams/{k}/shortName")));
            ui.label(RichText::new(t(0)).color(c::MUTED));
            for side in 0..2 {
                if let Some(v) = text_field(ui, &format!("score{i}-{side}"), "", &s(row.pointer(&format!("/score/{side}"))), 3, 36.0) {
                    field(app, None, |st| set_field(st, Field::MapScore { row: i, side, value: &v }));
                }
                if side == 0 {
                    ui.label("—");
                }
            }
            ui.label(RichText::new(t(1)).color(c::MUTED));
            if truthy(row.get("overtime")) {
                ui.label(RichText::new(format!("OT {}", duration(row.get("overtimeSeconds")))).strong().color(c::ORANGE));
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                for w in [1usize, 0] {
                    let sel = row.get("winner").and_then(Value::as_f64) == Some(w as f64);
                    let b = egui::Button::new(RichText::new(t(w)).strong().color(if sel { Color32::BLACK } else { c::TEXT })).fill(if sel { c::ORANGE } else { c::PANEL_LIGHT }).min_size(egui::vec2(70.0, 30.0));
                    if ui.add(b).clicked() {
                        app.control("map-winner", i, Some(w as f64));
                    }
                }
            });
        });
    });
}

fn veto_editor(app: &mut App, ui: &mut egui::Ui, game: &Value, cfg: &Value) {
    let bans: Vec<String> = game["veto"]["bans"].as_array().into_iter().flatten().map(|b| s(Some(b))).collect();
    let picks = game["veto"]["picks"].as_array().cloned().unwrap_or_default();
    let all: Vec<String> = cfg["maps"].as_array().into_iter().flatten().filter_map(|m| m.as_str().map(str::to_string)).collect();
    // vetoOptions(current, slotType, slotIndex): maps not used elsewhere
    let options = |cur: &str, ban: bool, idx: usize| -> Vec<String> {
        let mut used: Vec<String> = bans.iter().enumerate().filter(|(i, _)| !ban || *i != idx).map(|(_, b)| b.clone()).collect();
        used.extend(picks.iter().enumerate().filter(|(i, _)| ban || *i != idx).map(|(_, p)| s(p.get("map"))));
        all.iter().filter(|m| m.as_str() == cur || !used.contains(m)).cloned().collect()
    };
    panel(ui, |ui| {
        ui.horizontal(|ui| {
            ui.vertical(|ui| {
                ui.label(RichText::new("VALORANT VETO").small().color(c::ORANGE));
                ui.label(RichText::new("Map picks & bans").strong().size(16.0));
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.button("OPEN PREVIEW").clicked() {
                    crate::ui::open_url(&crate::ui::overlay_url("map-pool", &[]).unwrap_or_default());
                }
                if app.confirm_button(ui, "reset-veto", "RESET MAP SELECTIONS", "Click again to reset picks & bans") {
                    app.control("reset-veto", 0, None);
                }
            });
        });
        ui.horizontal_wrapped(|ui| {
            for (i, b) in bans.iter().enumerate() {
                ui.vertical(|ui| {
                    ui.label(RichText::new(format!("BAN {}", i + 1)).small().color(c::MUTED));
                    if let Some(v) = map_combo(ui, format!("ban{i}"), b, &options(b, true, i), "Select map…") {
                        field(app, None, |st| set_field(st, Field::VetoBan { index: i, value: &v }));
                    }
                });
            }
        });
        ui.add_space(6.0);
        ui.horizontal_wrapped(|ui| {
            for (i, p) in picks.iter().enumerate() {
                egui::Frame::NONE.fill(c::PANEL_LIGHT).corner_radius(6.0).inner_margin(8.0).show(ui, |ui| {
                    ui.vertical(|ui| {
                        ui.label(RichText::new(if i == 2 { "DECIDER".to_string() } else { format!("PICK {}", i + 1) }).small().strong().color(c::ORANGE));
                        ui.label(RichText::new("MAP").small().color(c::MUTED));
                        let cur = s(p.get("map"));
                        if let Some(v) = map_combo(ui, format!("pick{i}"), &cur, &options(&cur, false, i), "Select map…") {
                            field(app, None, |st| set_field(st, Field::VetoPick { index: i, prop: "map", value: &v }));
                        }
                        ui.label(RichText::new("ATTACKING SIDE").small().color(c::MUTED));
                        let att = num_or_zero(p.get("attackers")) as i64;
                        let mut pick = att;
                        let t = |k: i64| s(game.pointer(&format!("/teams/{k}/shortName")));
                        egui::ComboBox::from_id_salt(format!("att{i}")).selected_text(t(att.clamp(0, 1))).show_ui(ui, |ui| {
                            ui.selectable_value(&mut pick, 0, t(0));
                            ui.selectable_value(&mut pick, 1, t(1));
                        });
                        if pick != att {
                            let v = pick.to_string();
                            field(app, None, |st| set_field(st, Field::VetoPick { index: i, prop: "attackers", value: &v }));
                        }
                    });
                });
            }
        });
    });
    let _ = json!(null);
}
