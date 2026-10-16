//! Map Pool view (app.js renderMaps, renderValorantVetoEditor, renderMapRow).
use eframe::egui::{self, Color32, RichText};
use isu_core::controls::{Field, series_length, series_target, set_field, visible_rows};
use isu_core::game_config::{config, js_string, num_or_zero, truthy};
use serde_json::Value;

use super::widgets::{cols, field_label, heading, secondary_button, select};
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
    heading(ui, "01", "Series map order", &format!("{} · select, score, and advance maps", s(game.pointer("/match/format"))), |ui| {
        if app.confirm_button(ui, "clear-maps", "Clear results", "Click again to clear results") {
            app.control("clear-maps", 0, None);
        }
    });
    // .map-summary: series 1fr | active 150 | target 190 | format 210, dividers between
    let t = |i: usize, k: &str| s(game.pointer(&format!("/teams/{i}/{k}")));
    egui::Frame::NONE.fill(Color32::from_rgb(0x15, 0x15, 0x17)).stroke(egui::Stroke::new(1.0, Color32::from_rgb(0x30, 0x30, 0x34))).inner_margin(egui::Margin::symmetric(0, 12)).show(ui, |ui| {
        ui.set_width(ui.available_width());
        cols(ui, &[-1.0, 150.0, 190.0, 210.0], 0.0, |j, ui| {
            let r = ui.max_rect();
            if j < 3 {
                ui.painter().vline(r.right(), r.y_range(), egui::Stroke::new(1.0, Color32::from_rgb(0x29, 0x29, 0x2d)));
            }
            egui::Frame::NONE.inner_margin(egui::Margin::symmetric(21, 0)).show(ui, |ui| {
                ui.spacing_mut().item_spacing.y = 4.0;
                match j {
                    0 => {
                        field_label(ui, "Series");
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(format!("{} {}", t(0, "shortName"), t(0, "score"))).strong().size(15.0).color(c::TEXT));
                            ui.label(RichText::new("—").color(c::ORANGE));
                            ui.label(RichText::new(format!("{} {}", t(1, "score"), t(1, "shortName"))).strong().size(15.0).color(c::TEXT));
                        });
                    }
                    1 => {
                        field_label(ui, "Active");
                        ui.label(RichText::new(format!("MAP {}", active + 1)).strong().size(15.0).color(c::TEXT));
                    }
                    2 => {
                        field_label(ui, "Target");
                        ui.label(RichText::new(format!("FIRST TO {target}")).strong().size(15.0).color(c::TEXT));
                    }
                    _ => {
                        let opts = cfg["formatOptions"].as_array().filter(|a| !a.is_empty() && key != "rocketleague");
                        match opts {
                            Some(opts) => {
                                let length = series_length(game, &key);
                                let options: Vec<(f64, String)> = opts.iter().filter_map(Value::as_f64).map(|o| (o, format!("Best of {o}"))).collect();
                                if let Some(pick) = select(ui, "maps-format", "Format", &length, &options) {
                                    app.commit(&format!("Format set to Best of {pick}"), |st| isu_core::controls::sync_format(st, pick));
                                }
                            }
                            None => {
                                field_label(ui, "Format");
                                ui.label(RichText::new(s(game.pointer("/match/format"))).strong().size(15.0).color(c::TEXT));
                            }
                        }
                    }
                }
            });
        });
    });
    if key == "valorant" && game.get("veto").is_some() {
        veto_editor(app, ui, game, cfg);
    }
    let rows = game["mapRows"].as_array().cloned().unwrap_or_default();
    ui.spacing_mut().item_spacing.y = 7.0;
    for i in 0..visible_rows(game, &key) {
        map_row(app, ui, game, cfg, &rows[i], i, active);
    }
    ui.add_space(4.0);
    ui.horizontal(|ui| {
        ui.label(RichText::new("LIVE").size(9.5).strong().extra_letter_spacing(1.2).color(c::ORANGE));
        ui.label(RichText::new("Changes here show up on the Map Pool graphic right away. Click a map number to make it the current map; click a team name to say who won it.").size(11.0).color(c::DIM));
    });
}

fn map_combo(ui: &mut egui::Ui, id: String, label: &str, current: &str, options: &[String], none_label: &str) -> Option<String> {
    let mut all: Vec<(String, String)> = vec![(String::new(), none_label.to_string())];
    all.extend(options.iter().map(|o| (o.clone(), o.clone())));
    select(ui, &id, label, &current.to_string(), &all)
}

fn map_row(app: &mut App, ui: &mut egui::Ui, game: &Value, cfg: &Value, row: &Value, i: usize, active: usize) {
    let is_active = i == active;
    let done = !row.get("winner").is_none_or(Value::is_null);
    let fill = if is_active { Color32::from_rgb(0x1b, 0x17, 0x14) } else { Color32::from_rgb(0x14, 0x14, 0x16) };
    let resp = egui::Frame::NONE.fill(fill).stroke(egui::Stroke::new(1.0, Color32::from_rgb(0x29, 0x29, 0x2e))).corner_radius(2.0).inner_margin(egui::Margin { left: 0, right: 10, top: 10, bottom: 10 }).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.set_min_height(58.0);
        if done && !is_active {
            ui.multiply_opacity(0.8);
        }
        let t = |k: usize| s(game.pointer(&format!("/teams/{k}/shortName")));
        // .map-row grid: index 65 | mode 150 | map 1fr | score 235 | winners 134
        cols(ui, &[65.0, 150.0, -1.0, 235.0, 140.0], 10.0, |j, ui| match j {
            0 => {
                let (r, resp) = ui.allocate_exact_size(egui::vec2(65.0, 58.0), egui::Sense::click());
                let p = ui.painter();
                p.vline(r.right(), r.y_range(), egui::Stroke::new(1.0, Color32::from_rgb(0x2d, 0x2d, 0x31)));
                let col = if is_active { c::ORANGE } else if resp.hovered() { Color32::WHITE } else { Color32::from_rgb(0x7b, 0x7b, 0x83) };
                let tag = if is_active { "LIVE" } else if done { "FINAL" } else { "MAP" };
                p.text(egui::pos2(r.center().x, r.center().y - 11.0), egui::Align2::CENTER_CENTER, tag, egui::FontId::proportional(8.5), if is_active { c::ORANGE } else { Color32::from_rgb(0x55, 0x55, 0x5c) });
                p.text(egui::pos2(r.center().x, r.center().y + 7.0), egui::Align2::CENTER_CENTER, format!("{:02}", i + 1), egui::FontId::proportional(18.0), col);
                resp.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Button, true, format!("{tag} {:02}", i + 1)));
                if resp.clicked() {
                    app.control("activate-map", i, None);
                }
            }
            1 => {
                let modes: Vec<String> = cfg["modes"].as_array().into_iter().flatten().filter_map(|m| m.as_str().map(str::to_string)).collect();
                if let Some(v) = map_combo(ui, format!("mode{i}"), "Mode", &s(row.get("mode")), &modes, "TBD") {
                    field(app, None, |st| set_field(st, Field::MapProp { row: i, prop: "mode", value: &v }));
                }
            }
            2 => {
                let mut maps: Vec<String> = cfg["maps"].as_array().into_iter().flatten().filter_map(|m| m.as_str().map(str::to_string)).collect();
                let cur = s(row.get("map"));
                if !cur.is_empty() && !maps.contains(&cur) {
                    maps.insert(0, cur.clone());
                }
                if let Some(v) = map_combo(ui, format!("map{i}"), "Map / stage", &cur, &maps, "TBD") {
                    field(app, None, |st| set_field(st, Field::MapProp { row: i, prop: "map", value: &v }));
                }
            }
            3 => {
                ui.add_space(10.0);
                cols(ui, &[36.0, 46.0, 12.0, 46.0, 36.0], 5.0, |k, ui| match k {
                    0 | 4 => {
                        ui.add_space(8.0);
                        ui.vertical_centered(|ui| ui.label(RichText::new(t(if k == 0 { 0 } else { 1 })).size(10.5).strong().color(Color32::from_rgb(0x70, 0x70, 0x78))));
                    }
                    2 => {
                        ui.add_space(8.0);
                        ui.label(RichText::new("—").color(Color32::from_rgb(0x56, 0x56, 0x5e)));
                    }
                    _ => {
                        let side = if k == 1 { 0 } else { 1 };
                        if let Some(v) = score_box(ui, &format!("score{i}-{side}"), &s(row.pointer(&format!("/score/{side}")))) {
                            field(app, None, |st| set_field(st, Field::MapScore { row: i, side, value: &v }));
                        }
                    }
                });
                if truthy(row.get("overtime")) {
                    ui.vertical_centered(|ui| ui.label(RichText::new(format!("OT {}", duration(row.get("overtimeSeconds")))).size(10.5).strong().color(c::ORANGE)));
                }
            }
            _ => {
                ui.add_space(12.0);
                cols(ui, &[-1.0, -1.0], 4.0, |w, ui| {
                    let sel = row.get("winner").and_then(Value::as_f64) == Some(w as f64);
                    let b = egui::Button::new(RichText::new(t(w)).size(10.0).strong().color(if sel { Color32::from_rgb(0x0b, 0x0b, 0x0c) } else { Color32::from_rgb(0xa0, 0xa0, 0xa8) })).fill(if sel { c::ORANGE } else { Color32::from_rgb(0x1d, 0x1d, 0x20) }).min_size(egui::vec2(ui.available_width(), 34.0));
                    if ui.add(b).clicked() {
                        app.control("map-winner", i, Some(w as f64));
                    }
                });
            }
        });
    }).response;
    if is_active {
        let r = resp.rect;
        ui.painter().rect_filled(egui::Rect::from_min_size(r.min, egui::vec2(2.0, r.height())), 0.0, c::ORANGE);
    }
}

/// Map score cell: centred, bold, commits like text_field.
fn score_box(ui: &mut egui::Ui, id: &str, value: &str) -> Option<String> {
    let key = egui::Id::new(("draft", id));
    let mut draft: String = ui.data(|d| d.get_temp::<String>(key)).unwrap_or_else(|| value.to_string());
    let r = ui.add(egui::TextEdit::singleline(&mut draft).char_limit(3).desired_width(ui.available_width()).horizontal_align(egui::Align::Center).font(egui::FontId::proportional(14.0)).margin(egui::vec2(2.0, 9.0)));
    if r.has_focus() || r.changed() {
        ui.data_mut(|d| d.insert_temp(key, draft.clone()));
    }
    if r.lost_focus() {
        ui.data_mut(|d| d.remove::<String>(key));
        if draft != value {
            return Some(draft);
        }
    } else if !r.has_focus() {
        ui.data_mut(|d| d.remove::<String>(key));
    }
    None
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
    const VRED: Color32 = Color32::from_rgb(0xff, 0x46, 0x55);
    let resp = egui::Frame::NONE.fill(c::PANEL).stroke(egui::Stroke::new(1.0, Color32::from_rgb(0x2d, 0x2d, 0x31))).corner_radius(3.0).inner_margin(16.0).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal(|ui| {
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = 3.0;
                ui.label(RichText::new("VALORANT VETO").size(9.5).strong().extra_letter_spacing(1.4).color(Color32::from_rgb(0xff, 0x58, 0x65)));
                ui.label(RichText::new("Map picks & bans").strong().size(14.0).color(c::TEXT));
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.add(secondary_button("OPEN PREVIEW")).clicked() {
                    crate::ui::open_url(&crate::ui::overlay_url("map-pool", &[]).unwrap_or_default());
                }
                if app.confirm_button(ui, "reset-veto", "RESET MAP SELECTIONS", "Click again to reset picks & bans") {
                    app.control("reset-veto", 0, None);
                }
            });
        });
        ui.add_space(6.0);
        // .veto-ban-grid: 4 columns on a faint red band
        egui::Frame::NONE.fill(Color32::from_rgba_unmultiplied(0xff, 0x46, 0x55, 9)).stroke(egui::Stroke::new(1.0, VRED.gamma_multiply(0.2))).inner_margin(10.0).show(ui, |ui| {
            ui.set_width(ui.available_width());
            let n = bans.len().max(1);
            let widths = vec![-1.0; n];
            cols(ui, &widths, 8.0, |i, ui| {
                let Some(b) = bans.get(i) else { return };
                if let Some(v) = map_combo(ui, format!("ban{i}"), &format!("Ban {}", i + 1), b, &options(b, true, i), "Select map…") {
                    field(app, None, |st| set_field(st, Field::VetoBan { index: i, value: &v }));
                }
            });
        });
        ui.add_space(4.0);
        // .veto-pick-grid: 3 cards, each map 1fr | attackers .8fr
        let n = picks.len().max(1);
        cols(ui, &vec![-1.0; n], 8.0, |i, ui| {
            let Some(p) = picks.get(i) else { return };
            egui::Frame::NONE.fill(Color32::from_rgb(0x11, 0x11, 0x13)).stroke(egui::Stroke::new(1.0, Color32::from_rgb(0x33, 0x33, 0x38))).inner_margin(10.0).show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.horizontal(|ui| {
                    ui.label(RichText::new(if i == 2 { "DECIDER".to_string() } else { format!("PICK {}", i + 1) }).size(9.5).strong().color(Color32::from_rgb(0x77, 0x77, 0x80)));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| ui.label(RichText::new(format!("0{}", i + 1)).strong().color(VRED)));
                });
                cols(ui, &[-1.0, -0.8], 8.0, |k, ui| {
                    if k == 0 {
                        let cur = s(p.get("map"));
                        if let Some(v) = map_combo(ui, format!("pick{i}"), "Map", &cur, &options(&cur, false, i), "Select map…") {
                            field(app, None, |st| set_field(st, Field::VetoPick { index: i, prop: "map", value: &v }));
                        }
                    } else {
                        let att = num_or_zero(p.get("attackers")) as i64;
                        let t = |k: i64| s(game.pointer(&format!("/teams/{k}/shortName")));
                        if let Some(pick) = select(ui, &format!("att{i}"), "Attacking side", &att, &[(0, t(0)), (1, t(1))]) {
                            let v = pick.to_string();
                            field(app, None, |st| set_field(st, Field::VetoPick { index: i, prop: "attackers", value: &v }));
                        }
                    }
                });
            });
        });
    }).response;
    let r = resp.rect;
    ui.painter().rect_filled(egui::Rect::from_min_size(r.min, egui::vec2(2.0, r.height())), 0.0, VRED);
}
