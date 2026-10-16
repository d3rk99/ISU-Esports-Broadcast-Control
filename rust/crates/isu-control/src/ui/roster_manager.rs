//! Roster Manager view (src/roster-manager-view.js renderRosterManager + app.js rosterManagerAction /
//! rosterManagerChange). Library logic is isu_core::roster_manager.
use std::collections::BTreeSet;

use eframe::egui::{self, Color32, RichText};
use isu_core::game_config::{config, js_string, truthy};
use isu_core::roster_manager as rm;
use serde_json::{Value, json};

use super::widgets::{color_field, cols, field_label, heading, primary_button, secondary_button, select, text_field, toggle};
use super::{App, c, hex};

fn s(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        x => js_string(x),
    }
}

/// rosterManagerUi (window-only state, not saved).
#[derive(Default)]
pub struct Ui {
    pub team_id: String,
    pub selected: BTreeSet<String>,
    pub filter: String,
    pub bulk: String,
}

const STATUS_LABEL: [(&str, &str); 4] = [("starter", "STARTER"), ("sixth", "6TH MAN"), ("sub", "SUB"), ("coach", "COACH")];

/// rmTeam(): the picked team, else the first.
fn team_index(game: &Value, id: &str) -> Option<usize> {
    let teams = game.pointer("/rosterLibrary/teams").and_then(Value::as_array)?;
    teams.iter().position(|t| t["id"].as_str() == Some(id)).or(if teams.is_empty() { None } else { Some(0) })
}

/// With the selected game's library: runs f on (game, team index) inside a commit.
fn with_team(app: &App, msg: &str, ti: usize, f: impl FnOnce(&mut Value, usize)) {
    app.commit(msg, |st| {
        let k = st["selectedGame"].as_str().unwrap_or("").to_string();
        let g = &mut st["games"][k.as_str()];
        rm::ensure_library(g);
        f(g, ti);
    });
}

fn shown_ids(team: &Value, filter: &str) -> Vec<String> {
    rm::sorted_players(team, None).into_iter().filter(|p| filter == "all" || p["program"] == filter || p["status"] == filter).filter_map(|p| p["id"].as_str().map(str::to_string)).collect()
}

pub fn view(app: &mut App, ui: &mut egui::Ui, st: &Value) {
    let key = st["selectedGame"].as_str().unwrap_or("overwatch").to_string();
    let mut game = st["games"][key.as_str()].clone();
    rm::ensure_library(&mut game);
    if app.rm.filter.is_empty() {
        app.rm.filter = "all".into();
    }
    let isu = rm::isu_side(&mut game.clone());
    let teams = game["rosterLibrary"]["teams"].as_array().cloned().unwrap_or_default();
    let ti = team_index(&game, &app.rm.team_id);
    let sub = format!("Build every team once. Loading a team fills the match roster, and the scoreboard reader links players by gamertag. {}", if isu.is_empty() { "No team marked Idaho State is loaded yet.".to_string() } else { format!("Idaho State is loaded as {}.", isu.to_uppercase()) });
    heading(ui, "00", "Roster manager", &sub, |ui| {
        if ui.add(primary_button("+ NEW TEAM")).clicked() {
            let first = teams.is_empty();
            let mut id = String::new();
            app.commit("Team created", |st| {
                let k = st["selectedGame"].as_str().unwrap_or("").to_string();
                id = rm::create_team(&mut st["games"][k.as_str()], if first { "IDAHO STATE" } else { "NEW TEAM" }, if first { "ISU" } else { "" }, first, "");
            });
            app.rm.team_id = id;
        }
    });
    // .rm-layout: 260 px team list | panel
    cols(ui, &[260.0, -1.0], 12.0, |j, ui| {
        if j == 0 {
            ui.spacing_mut().item_spacing.y = 6.0;
            if teams.is_empty() {
                ui.label(RichText::new("No teams yet. Click + NEW TEAM.").size(12.0).color(Color32::from_rgb(0x66, 0x66, 0x6d)));
            }
            for (i, t) in teams.iter().enumerate() {
                let count = |st: &str| t["players"].as_array().map_or(0, |p| p.iter().filter(|x| x["status"] == st).count());
                let loaded: Vec<String> = ["home", "away"].iter().filter(|sd| game.pointer(&format!("/rosterAssign/{sd}")) == Some(&t["id"])).map(|x| x.to_uppercase()).collect();
                let on = ti == Some(i);
                let name = s(t.get("name"));
                let (r, resp) = ui.allocate_exact_size(egui::vec2(ui.available_width(), 52.0), egui::Sense::click());
                let p = ui.painter();
                p.rect(r, 2.0, if on { Color32::from_rgb(0x1c, 0x1c, 0x1f) } else if resp.hovered() { Color32::from_rgb(0x18, 0x18, 0x1a) } else { c::PANEL }, egui::Stroke::new(1.0, if on { c::ORANGE } else { Color32::from_rgb(0x30, 0x30, 0x35) }), egui::StrokeKind::Inside);
                p.rect_filled(egui::Rect::from_min_size(r.min, egui::vec2(4.0, r.height())), 0.0, hex(&{ let x = s(t.get("color")); if x.is_empty() { "#5e6673".into() } else { x } }));
                let g = p.layout_no_wrap(name.clone(), egui::FontId::proportional(12.5), Color32::from_rgb(0xd5, 0xd5, 0xd9));
                let nw = g.size().x;
                p.galley(egui::pos2(r.left() + 16.0, r.top() + 10.0), g, Color32::WHITE);
                if truthy(t.get("isISU")) {
                    let br = egui::Rect::from_min_size(egui::pos2(r.left() + 22.0 + nw, r.top() + 10.0), egui::vec2(26.0, 15.0));
                    p.rect_filled(br, 2.0, c::ORANGE);
                    p.text(br.center(), egui::Align2::CENTER_CENTER, "ISU", egui::FontId::proportional(9.0), Color32::from_rgb(0x11, 0x11, 0x11));
                }
                let line = format!("{} starters · {} 6th · {} subs · {} coaches", count("starter"), count("sixth"), count("sub"), count("coach"));
                p.text(egui::pos2(r.left() + 16.0, r.top() + 34.0), egui::Align2::LEFT_CENTER, line, egui::FontId::proportional(10.0), Color32::from_rgb(0x77, 0x77, 0x7f));
                if !loaded.is_empty() {
                    p.text(egui::pos2(r.right() - 10.0, r.top() + 16.0), egui::Align2::RIGHT_CENTER, format!("LOADED {}", loaded.join(" + ")), egui::FontId::proportional(9.5), c::ORANGE);
                }
                resp.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Button, true, &name));
                if resp.clicked() {
                    app.rm.team_id = s(t.get("id"));
                    app.rm.selected.clear();
                }
            }
        } else {
            match ti {
                None => {
                    super::widgets::panel(ui, |ui| ui.label(RichText::new("Pick or create a team.").size(12.0).color(Color32::from_rgb(0x66, 0x66, 0x6d))));
                }
                Some(ti) => {
                    let team = teams[ti].clone();
                    team_panel(app, ui, &game, &team, ti, &key);
                }
            }
        }
    });
}

fn team_panel(app: &mut App, ui: &mut egui::Ui, game: &Value, team: &Value, ti: usize, key: &str) {
    egui::Frame::NONE.fill(c::PANEL).stroke(egui::Stroke::new(1.0, Color32::from_rgb(0x2d, 0x2d, 0x31))).corner_radius(3.0).inner_margin(14.0).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.spacing_mut().item_spacing.y = 12.0;
        // .rm-team-edit: name 1.6fr | short .6fr | colour 70 | ISU toggle 1.4fr
        let save_prop = |app: &App, prop: &str, v: String| {
            let p = prop.to_string();
            with_team(app, "Team saved", ti, |g, ti| {
                let t = &mut g["rosterLibrary"]["teams"][ti];
                let val = if p == "shortName" { v.trim().chars().take(6).collect::<String>().to_uppercase() } else { let x: String = v.trim().chars().take(40).collect(); if x.is_empty() { s(t.get(p.as_str())) } else { x } };
                t[p.as_str()] = json!(val);
            });
        };
        cols(ui, &[-1.6, -0.6, 70.0, -1.4], 10.0, |j, ui| match j {
            0 => {
                if let Some(v) = text_field(ui, &format!("rmname{ti}"), "Team name", &s(team.get("name")), 40, 0.0) {
                    save_prop(app, "name", v);
                }
            }
            1 => {
                if let Some(v) = text_field(ui, &format!("rmshort{ti}"), "Short", &s(team.get("shortName")), 6, 0.0) {
                    save_prop(app, "shortName", v);
                }
            }
            2 => {
                let col = { let x = s(team.get("color")); if x.is_empty() { "#5e6673".to_string() } else { x } };
                if let Some(v) = color_field(ui, "Color", &col, true) {
                    save_prop(app, "color", v);
                }
            }
            _ => {
                ui.add_space(12.0);
                let mut isu = truthy(team.get("isISU"));
                if toggle(ui, &mut isu, "IDAHO STATE (HOME PROGRAM)", "The reader treats this team as ISU") {
                    with_team(app, "Team saved", ti, |g, ti| {
                        for t in g["rosterLibrary"]["teams"].as_array_mut().unwrap() {
                            t["isISU"] = json!(false);
                        }
                        g["rosterLibrary"]["teams"][ti]["isISU"] = json!(isu);
                    });
                }
            }
        });
        ui.horizontal(|ui| {
            for side in ["home", "away"] {
                if ui.add(primary_button(&format!("LOAD AS {}", side.to_uppercase()))).clicked() {
                    let other = if side == "home" { "away" } else { "home" };
                    let name = s(team.get("name"));
                    if game.pointer(&format!("/rosterAssign/{other}")) == Some(&team["id"]) {
                        app.toast(&format!("{name} is already loaded as {}. Load the opponent there first.", other.to_uppercase()));
                    } else {
                        let id = s(team.get("id"));
                        let cfg = config(key).unwrap().clone();
                        let size = cfg["rosterSize"].as_u64().unwrap_or(5) as usize;
                        app.commit(&format!("{name} loaded as {}", side.to_uppercase()), |st| {
                            let k = st["selectedGame"].as_str().unwrap_or("").to_string();
                            rm::load_team_into_match(&mut st["games"][k.as_str()], side, &id, &|i| isu_core::rocket_league::create_player(&cfg, i), size);
                        });
                        app.toast(&format!("{name} loaded as {}: the scoreboard reader now links these gamertags", side.to_uppercase()));
                    }
                }
            }
            if app.confirm_button(ui, &format!("rmdel{ti}"), "DELETE TEAM", "Delete this team from the library?") {
                let (id, name) = (s(team.get("id")), s(team.get("name")));
                app.commit(&format!("{name} deleted from the library"), |st| {
                    let k = st["selectedGame"].as_str().unwrap_or("").to_string();
                    let g = &mut st["games"][k.as_str()];
                    rm::ensure_library(g);
                    g["rosterLibrary"]["teams"].as_array_mut().unwrap().retain(|t| t["id"].as_str() != Some(id.as_str()));
                    for sd in ["home", "away"] {
                        if g["rosterAssign"][sd].as_str() == Some(id.as_str()) {
                            g["rosterAssign"][sd] = json!("");
                        }
                    }
                });
                app.rm.team_id.clear();
            }
        });
        // .rm-bulk: textarea 1fr | buttons
        cols(ui, &[-1.0, 140.0], 10.0, |j, ui| {
            if j == 0 {
                field_label(ui, "Add many (one per line: gamertag, name, starter/6th/sub/coach, varsity/jv)");
                ui.add(egui::TextEdit::multiline(&mut app.rm.bulk).desired_rows(3).desired_width(ui.available_width()).font(egui::TextStyle::Monospace).hint_text("Sn0wfal, Sam Snow, starter\nBaldReaper, Bob Reap, 6th, varsity\nCoachK, Kim Coach, coach"));
            } else {
                ui.add_space(14.0);
                let w = ui.available_width();
                if ui.add(secondary_button("ADD PLAYERS").min_size(egui::vec2(w, 32.0))).clicked() {
                    let text = app.rm.bulk.clone();
                    let mut added = 0;
                    with_team(app, "Players added", ti, |g, ti| added = rm::bulk_add(&mut g["rosterLibrary"]["teams"][ti], &text).len());
                    if added > 0 {
                        app.rm.bulk.clear();
                    }
                    let name = s(team.get("name"));
                    app.toast(&if added > 0 { format!("{added} players added to {name}") } else { "Nothing to add: one player per line".into() });
                }
                if ui.add(secondary_button("+ ONE PLAYER").min_size(egui::vec2(w, 32.0))).clicked() {
                    with_team(app, "Player added", ti, |g, ti| { rm::add_player(&mut g["rosterLibrary"]["teams"][ti], &json!({})); });
                }
            }
        });
        // .rm-filters
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 6.0;
            for (k, l) in [("all", "ALL"), ("varsity", "VARSITY"), ("jv", "JV"), ("starter", "STARTERS"), ("sixth", "6TH MAN"), ("sub", "SUBS"), ("coach", "COACHES")] {
                let on = app.rm.filter == k;
                let b = egui::Button::new(RichText::new(l).size(10.0).strong().color(if on { c::ORANGE } else { Color32::from_rgb(0x9a, 0x9a, 0xa2) })).fill(c::PANEL).stroke(egui::Stroke::new(1.0, if on { c::ORANGE } else { Color32::from_rgb(0x30, 0x30, 0x35) })).min_size(egui::vec2(0.0, 26.0));
                if ui.add(b).clicked() {
                    app.rm.filter = k.into();
                }
            }
        });
        // .rm-selected
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 6.0;
            ui.label(RichText::new(format!("{}", app.rm.selected.len())).strong().color(c::ORANGE));
            ui.label(RichText::new("selected").size(11.0).color(c::MUTED));
            let ids: Vec<String> = app.rm.selected.iter().cloned().collect();
            ui.allocate_ui(egui::vec2(150.0, 32.0), |ui| {
                let opts: Vec<(String, String)> = std::iter::once((String::new(), "Set status…".to_string())).chain(STATUS_LABEL.iter().map(|(k, l)| (k.to_string(), l.to_string()))).collect();
                if let Some(status) = select(ui, "rm-bulk-status", "", &String::new(), &opts).filter(|x| !x.is_empty()) {
                    let mut n = 0;
                    with_team(app, "Status changed", ti, |g, ti| n = rm::set_for_players(&mut g["rosterLibrary"]["teams"][ti], &ids, "status", &json!(status)));
                    app.toast(&format!("{n} players set to {}", status.to_uppercase()));
                }
            });
            ui.allocate_ui(egui::vec2(150.0, 32.0), |ui| {
                let opts = vec![(String::new(), "Set program…".to_string()), ("varsity".to_string(), "VARSITY".to_string()), ("jv".to_string(), "JV".to_string())];
                if let Some(prog) = select(ui, "rm-bulk-program", "", &String::new(), &opts).filter(|x| !x.is_empty()) {
                    let mut n = 0;
                    with_team(app, "Program changed", ti, |g, ti| n = rm::set_for_players(&mut g["rosterLibrary"]["teams"][ti], &ids, "program", &json!(prog)));
                    app.toast(&format!("{n} players moved to {}", prog.to_uppercase()));
                }
            });
            if ui.add(secondary_button("SELECT ALL SHOWN")).clicked() {
                app.rm.selected = shown_ids(team, &app.rm.filter).into_iter().collect();
            }
            if ui.add(secondary_button("CLEAR")).clicked() {
                app.rm.selected.clear();
            }
            if app.confirm_button(ui, "rm-remove-selected", "REMOVE SELECTED", "Remove selected players?") {
                let n = ids.len();
                with_team(app, &format!("{n} players removed"), ti, |g, ti| { rm::remove_players(&mut g["rosterLibrary"]["teams"][ti], &ids); });
                app.rm.selected.clear();
            }
        });
        // .rm-players
        let filter = app.rm.filter.clone();
        let players: Vec<Value> = rm::sorted_players(team, None).into_iter().filter(|p| filter == "all" || p["program"] == filter || p["status"] == filter).collect();
        ui.spacing_mut().item_spacing.y = 4.0;
        if players.is_empty() {
            ui.label(RichText::new("No players here yet.").size(12.0).color(Color32::from_rgb(0x66, 0x66, 0x6d)));
        }
        for p in &players {
            let id = s(p.get("id"));
            let edge = match p["status"].as_str() { Some("starter") => c::ORANGE, Some("sixth") => Color32::from_rgb(0xd8, 0xb1, 0x3a), Some("coach") => Color32::from_rgb(0x6a, 0xa4, 0xd9), _ => Color32::from_rgb(0x55, 0x55, 0x5c) };
            let r = egui::Frame::NONE.fill(Color32::from_rgb(0x12, 0x12, 0x14)).stroke(egui::Stroke::new(1.0, Color32::from_rgb(0x26, 0x26, 0x2a))).inner_margin(egui::Margin { left: 11, right: 8, top: 6, bottom: 6 }).show(ui, |ui| {
                ui.set_width(ui.available_width());
                let set = |app: &App, prop: &str, v: &str| {
                    let (pid, p2, v2) = (id.clone(), prop.to_string(), v.trim().to_string());
                    with_team(app, "Player saved", ti, |g, ti| { rm::set_for_players(&mut g["rosterLibrary"]["teams"][ti], &[pid], &p2, &json!(v2)); });
                };
                // .rm-player: check 22 | photo 44 | handle 1.3fr | name 1.3fr | status 130 | program 120 | x 30
                cols(ui, &[22.0, 44.0, -1.3, -1.3, 130.0, 120.0, 34.0], 8.0, |j, ui| match j {
                    0 => {
                        ui.add_space(14.0);
                        let mut sel = app.rm.selected.contains(&id);
                        if ui.checkbox(&mut sel, "").changed() {
                            if sel { app.rm.selected.insert(id.clone()); } else { app.rm.selected.remove(&id); }
                        }
                    }
                    1 => {
                        let url = s(p.get("playerImage"));
                        let (r, resp) = ui.allocate_exact_size(egui::vec2(44.0, 44.0), egui::Sense::click());
                        let pa = ui.painter();
                        pa.rect(r, 0.0, Color32::from_rgb(0x17, 0x17, 0x1a), egui::Stroke::new(1.0, if url.is_empty() { Color32::from_rgb(0x44, 0x44, 0x4a) } else { c::ORANGE.gamma_multiply(0.45) }), egui::StrokeKind::Inside);
                        if url.is_empty() {
                            pa.text(r.center(), egui::Align2::CENTER_CENTER, "PHOTO", egui::FontId::proportional(8.0), Color32::from_rgb(0x5e, 0x5e, 0x65));
                        } else {
                            let full = if url.starts_with("/assets/") { format!("http://127.0.0.1:3174{url}") } else { url.clone() };
                            egui::Image::new(full).fit_to_exact_size(egui::vec2(42.0, 42.0)).paint_at(ui, r.shrink(1.0));
                        }
                        if resp.on_hover_text("Choose headshot").clicked() {
                            if let Some((name, url)) = super::roster::pick_image(app, "Choose player image") {
                                let pid = id.clone();
                                with_team(app, "Headshot saved", ti, |g, ti| {
                                    let tid = s(g["rosterLibrary"]["teams"][ti].get("id"));
                                    if let Some(lp) = g["rosterLibrary"]["teams"][ti]["players"].as_array_mut().unwrap().iter_mut().find(|x| x["id"].as_str() == Some(pid.as_str())) {
                                        lp["playerImage"] = json!(url);
                                        lp["playerImageName"] = json!(name);
                                    }
                                    // already loaded into the match: the match roster gets the headshot too
                                    for (side, coll) in [("home", "rosters"), ("away", "awayRosters")] {
                                        if g["rosterAssign"][side].as_str() == Some(tid.as_str()) {
                                            for k in ["varsity", "jv"] {
                                                for mp in g[coll][k].as_array_mut().into_iter().flatten() {
                                                    if mp["libraryId"].as_str() == Some(pid.as_str()) {
                                                        mp["playerImage"] = json!(url);
                                                        mp["playerImageName"] = json!(name);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                });
                            }
                        }
                    }
                    2 => {
                        if let Some(v) = text_field(ui, &format!("rmh{id}"), "Gamertag", &s(p.get("handle")), 24, 0.0) {
                            set(app, "handle", &v);
                        }
                    }
                    3 => {
                        if let Some(v) = text_field(ui, &format!("rmn{id}"), "Name", &s(p.get("name")), 40, 0.0) {
                            set(app, "name", &v);
                        }
                    }
                    4 => {
                        let opts: Vec<(String, String)> = STATUS_LABEL.iter().map(|(k, l)| (k.to_string(), l.to_string())).collect();
                        if let Some(v) = select(ui, &format!("rms{id}"), "Status", &s(p.get("status")), &opts) {
                            set(app, "status", &v);
                        }
                    }
                    5 => {
                        let cur = if p["program"] == "jv" { "jv".to_string() } else { "varsity".to_string() };
                        if let Some(v) = select(ui, &format!("rmp{id}"), "Program", &cur, &[("varsity".to_string(), "VARSITY".into()), ("jv".to_string(), "JV".into())]) {
                            set(app, "program", &v);
                        }
                    }
                    _ => {
                        ui.add_space(12.0);
                        if app.confirm_button(ui, &format!("rmrm{id}"), "×", "Remove?") {
                            let pid = id.clone();
                            with_team(app, "Player removed", ti, |g, ti| { rm::remove_players(&mut g["rosterLibrary"]["teams"][ti], &[pid]); });
                            app.rm.selected.remove(&id);
                        }
                    }
                });
            }).response.rect;
            ui.painter().rect_filled(egui::Rect::from_min_size(r.min, egui::vec2(3.0, r.height())), 0.0, edge);
        }
        ui.add_space(4.0);
        ui.label(RichText::new(format!("{} players in {}", team["players"].as_array().map_or(0, Vec::len), s(team.get("name")))).size(10.5).color(c::DIM));
    });
}
