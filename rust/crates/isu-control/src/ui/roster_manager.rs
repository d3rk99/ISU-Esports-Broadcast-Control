//! Roster Manager view (src/roster-manager-view.js renderRosterManager + app.js rosterManagerAction /
//! rosterManagerChange). Library logic is isu_core::roster_manager.
use std::collections::BTreeSet;

use eframe::egui::{self, Color32, RichText};
use isu_core::game_config::{config, js_string, truthy};
use isu_core::roster_manager as rm;
use serde_json::{Value, json};

use super::widgets::{color_field, panel, text_field, title};
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
    ui.horizontal(|ui| {
        title(ui, "00", "Roster manager", &format!("Build every team once. Loading a team fills the match roster, and the scoreboard reader links players by gamertag. {}", if isu.is_empty() { "No team marked Idaho State is loaded yet.".to_string() } else { format!("Idaho State is loaded as {}.", isu.to_uppercase()) }));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if ui.add(egui::Button::new(RichText::new("+ NEW TEAM").strong().color(Color32::BLACK)).fill(c::ORANGE)).clicked() {
                let first = teams.is_empty();
                let mut id = String::new();
                app.commit("Team created", |st| {
                    let k = st["selectedGame"].as_str().unwrap_or("").to_string();
                    id = rm::create_team(&mut st["games"][k.as_str()], if first { "IDAHO STATE" } else { "NEW TEAM" }, if first { "ISU" } else { "" }, first, "");
                });
                app.rm.team_id = id;
            }
        });
    });
    ui.horizontal_top(|ui| {
        // team list
        ui.vertical(|ui| {
            ui.set_width(260.0);
            if teams.is_empty() {
                ui.label(RichText::new("No teams yet. Click + NEW TEAM.").color(c::MUTED));
            }
            for (i, t) in teams.iter().enumerate() {
                let count = |st: &str| t["players"].as_array().map_or(0, |p| p.iter().filter(|x| x["status"] == st).count());
                let loaded: Vec<String> = ["home", "away"].iter().filter(|sd| game.pointer(&format!("/rosterAssign/{sd}")) == Some(&t["id"])).map(|x| x.to_uppercase()).collect();
                let on = ti == Some(i);
                let text = format!("{}{}\n{} starters · {} 6th · {} subs · {} coaches{}", s(t.get("name")), if truthy(t.get("isISU")) { "  ISU" } else { "" }, count("starter"), count("sixth"), count("sub"), count("coach"), if loaded.is_empty() { String::new() } else { format!(" · LOADED {}", loaded.join(" + ")) });
                let b = egui::Button::new(RichText::new(text).color(c::TEXT)).fill(if on { c::PANEL_LIGHT } else { c::PANEL }).stroke(egui::Stroke::new(if on { 2.0 } else { 1.0 }, hex(&s(t.get("color"))))).min_size(egui::vec2(250.0, 44.0));
                if ui.add(b).clicked() {
                    app.rm.team_id = s(t.get("id"));
                    app.rm.selected.clear();
                }
            }
        });
        ui.vertical(|ui| {
            let Some(ti) = ti else {
                ui.label(RichText::new("Pick or create a team.").color(c::MUTED));
                return;
            };
            let team = teams[ti].clone();
            team_panel(app, ui, &game, &team, ti, &key);
        });
    });
}

fn team_panel(app: &mut App, ui: &mut egui::Ui, game: &Value, team: &Value, ti: usize, key: &str) {
    panel(ui, |ui| {
        // header: name, short, colour, ISU, load / delete
        ui.horizontal_wrapped(|ui| {
            let save_prop = |app: &App, prop: &str, v: String| {
                let p = prop.to_string();
                with_team(app, "Team saved", ti, |g, ti| {
                    let t = &mut g["rosterLibrary"]["teams"][ti];
                    let val = if p == "shortName" { v.trim().chars().take(6).collect::<String>().to_uppercase() } else { let x: String = v.trim().chars().take(40).collect(); if x.is_empty() { s(t.get(p.as_str())) } else { x } };
                    t[p.as_str()] = json!(val);
                });
            };
            if let Some(v) = text_field(ui, &format!("rmname{ti}"), "TEAM NAME", &s(team.get("name")), 40, 180.0) {
                save_prop(app, "name", v);
            }
            if let Some(v) = text_field(ui, &format!("rmshort{ti}"), "SHORT", &s(team.get("shortName")), 6, 60.0) {
                save_prop(app, "shortName", v);
            }
            let col = { let x = s(team.get("color")); if x.is_empty() { "#5e6673".to_string() } else { x } };
            if let Some(v) = color_field(ui, "COLOR", &col, true) {
                save_prop(app, "color", v);
            }
            let mut isu = truthy(team.get("isISU"));
            if ui.checkbox(&mut isu, "IDAHO STATE (HOME PROGRAM) – the reader treats this team as ISU").changed() {
                with_team(app, "Team saved", ti, |g, ti| {
                    for t in g["rosterLibrary"]["teams"].as_array_mut().unwrap() {
                        t["isISU"] = json!(false);
                    }
                    g["rosterLibrary"]["teams"][ti]["isISU"] = json!(isu);
                });
            }
        });
        ui.horizontal(|ui| {
            for side in ["home", "away"] {
                if ui.add(egui::Button::new(RichText::new(format!("LOAD AS {}", side.to_uppercase())).strong().color(Color32::BLACK)).fill(c::ORANGE)).clicked() {
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
        ui.separator();
        // bulk add
        ui.label(RichText::new("ADD MANY (one per line: gamertag, name, starter/6th/sub/coach, varsity/jv)").small().color(c::MUTED));
        ui.add(egui::TextEdit::multiline(&mut app.rm.bulk).desired_rows(3).desired_width(f32::INFINITY).hint_text("Sn0wfal, Sam Snow, starter\nBaldReaper, Bob Reap, 6th, varsity\nCoachK, Kim Coach, coach"));
        ui.horizontal(|ui| {
            if ui.button("ADD PLAYERS").clicked() {
                let text = app.rm.bulk.clone();
                let mut added = 0;
                with_team(app, "Players added", ti, |g, ti| added = rm::bulk_add(&mut g["rosterLibrary"]["teams"][ti], &text).len());
                if added > 0 {
                    app.rm.bulk.clear();
                }
                let name = s(team.get("name"));
                app.toast(&if added > 0 { format!("{added} players added to {name}") } else { "Nothing to add: one player per line".into() });
            }
            if ui.button("+ ONE PLAYER").clicked() {
                with_team(app, "Player added", ti, |g, ti| { rm::add_player(&mut g["rosterLibrary"]["teams"][ti], &json!({})); });
            }
        });
        // filters
        ui.horizontal(|ui| {
            for (k, l) in [("all", "ALL"), ("varsity", "VARSITY"), ("jv", "JV"), ("starter", "STARTERS"), ("sixth", "6TH MAN"), ("sub", "SUBS"), ("coach", "COACHES")] {
                let on = app.rm.filter == k;
                if ui.add(egui::Button::new(l).fill(if on { c::ORANGE.gamma_multiply(0.5) } else { c::PANEL_LIGHT })).clicked() {
                    app.rm.filter = k.into();
                }
            }
        });
        // selection bar
        ui.horizontal(|ui| {
            ui.label(RichText::new(format!("{} selected", app.rm.selected.len())).strong());
            let ids: Vec<String> = app.rm.selected.iter().cloned().collect();
            let mut status = String::new();
            egui::ComboBox::from_id_salt("rm-bulk-status").selected_text("Set status…").show_ui(ui, |ui| {
                for (k, l) in STATUS_LABEL {
                    ui.selectable_value(&mut status, k.to_string(), l);
                }
            });
            if !status.is_empty() {
                let mut n = 0;
                with_team(app, "Status changed", ti, |g, ti| n = rm::set_for_players(&mut g["rosterLibrary"]["teams"][ti], &ids, "status", &json!(status)));
                app.toast(&format!("{n} players set to {}", status.to_uppercase()));
            }
            let mut prog = String::new();
            egui::ComboBox::from_id_salt("rm-bulk-program").selected_text("Set program…").show_ui(ui, |ui| {
                ui.selectable_value(&mut prog, "varsity".to_string(), "VARSITY");
                ui.selectable_value(&mut prog, "jv".to_string(), "JV");
            });
            if !prog.is_empty() {
                let mut n = 0;
                with_team(app, "Program changed", ti, |g, ti| n = rm::set_for_players(&mut g["rosterLibrary"]["teams"][ti], &ids, "program", &json!(prog)));
                app.toast(&format!("{n} players moved to {}", prog.to_uppercase()));
            }
            if ui.button("SELECT ALL SHOWN").clicked() {
                app.rm.selected = shown_ids(team, &app.rm.filter).into_iter().collect();
            }
            if ui.button("CLEAR").clicked() {
                app.rm.selected.clear();
            }
            if app.confirm_button(ui, "rm-remove-selected", "REMOVE SELECTED", "Remove selected players?") {
                let n = ids.len();
                with_team(app, &format!("{n} players removed"), ti, |g, ti| { rm::remove_players(&mut g["rosterLibrary"]["teams"][ti], &ids); });
                app.rm.selected.clear();
            }
        });
        ui.separator();
        // players
        let filter = app.rm.filter.clone();
        let players: Vec<Value> = rm::sorted_players(team, None).into_iter().filter(|p| filter == "all" || p["program"] == filter || p["status"] == filter).collect();
        if players.is_empty() {
            ui.label(RichText::new("No players here yet.").color(c::MUTED));
        }
        for p in &players {
            let id = s(p.get("id"));
            ui.horizontal(|ui| {
                let mut sel = app.rm.selected.contains(&id);
                if ui.checkbox(&mut sel, "").changed() {
                    if sel { app.rm.selected.insert(id.clone()); } else { app.rm.selected.remove(&id); }
                }
                if ui.button(if truthy(p.get("playerImage")) { "PHOTO ✓" } else { "PHOTO" }).on_hover_text("Choose headshot").clicked() {
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
                let set = |app: &App, prop: &str, v: &str| {
                    let (pid, p2, v2) = (id.clone(), prop.to_string(), v.trim().to_string());
                    with_team(app, "Player saved", ti, |g, ti| { rm::set_for_players(&mut g["rosterLibrary"]["teams"][ti], &[pid], &p2, &json!(v2)); });
                };
                if let Some(v) = text_field(ui, &format!("rmh{id}"), "GAMERTAG", &s(p.get("handle")), 24, 150.0) {
                    set(app, "handle", &v);
                }
                if let Some(v) = text_field(ui, &format!("rmn{id}"), "NAME", &s(p.get("name")), 40, 170.0) {
                    set(app, "name", &v);
                }
                let cur = s(p.get("status"));
                let mut pick = cur.clone();
                egui::ComboBox::from_id_salt(format!("rms{id}")).selected_text(STATUS_LABEL.iter().find(|x| x.0 == cur).map_or("SUB", |x| x.1)).show_ui(ui, |ui| {
                    for (k, l) in STATUS_LABEL {
                        ui.selectable_value(&mut pick, k.to_string(), l);
                    }
                });
                if pick != cur {
                    set(app, "status", &pick);
                }
                let cur = s(p.get("program"));
                let mut pick = cur.clone();
                egui::ComboBox::from_id_salt(format!("rmp{id}")).selected_text(if cur == "jv" { "JV" } else { "VARSITY" }).show_ui(ui, |ui| {
                    ui.selectable_value(&mut pick, "varsity".to_string(), "VARSITY");
                    ui.selectable_value(&mut pick, "jv".to_string(), "JV");
                });
                if pick != cur {
                    set(app, "program", &pick);
                }
                if app.confirm_button(ui, &format!("rmrm{id}"), "×", "Remove?") {
                    let pid = id.clone();
                    with_team(app, "Player removed", ti, |g, ti| { rm::remove_players(&mut g["rosterLibrary"]["teams"][ti], &[pid]); });
                    app.rm.selected.remove(&id);
                }
            });
        }
        ui.label(RichText::new(format!("{} players in {}", team["players"].as_array().map_or(0, Vec::len), s(team.get("name")))).small().color(c::MUTED));
    });
}
