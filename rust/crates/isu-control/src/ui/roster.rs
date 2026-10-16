//! Rosters view (app.js renderRosters, renderPlayerEditor, stationOwners, readerLinkChip) and the
//! image picking of main.cjs assets:pick-image (copy into userData/broadcast-assets).
use eframe::egui::{self, Color32, RichText};
use isu_core::controls::{Field, set_field};
use isu_core::game_config::{config, initial_state, js_string, num_or_zero, truthy};
use serde_json::{Value, json};

use super::widgets::{panel, text_field, title};
use super::{App, c, hex};

fn s(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        x => js_string(x),
    }
}

/// assets:pick-image: file dialog, copy as <uuid><ext> into broadcast-assets, return { name, url }.
pub fn pick_image(app: &App, title: &str) -> Option<(String, String)> {
    let path = rfd::FileDialog::new().set_title(title).add_filter("Broadcast Images", &["png", "webp", "jpg", "jpeg"]).add_filter("All Files", &["*"]).pick_file()?;
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !["png", "webp", "jpg", "jpeg"].contains(&ext.as_str()) {
        return None;
    }
    let file = format!("{}.{ext}", super::control::random_uuid());
    let dir = app.svc.core.files.dir.join("broadcast-assets");
    let _ = std::fs::create_dir_all(&dir);
    std::fs::copy(&path, dir.join(&file)).ok()?;
    Some((path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), format!("http://127.0.0.1:3174/user-assets/{file}")))
}

/// stationOwners(game, self): station -> "JV · BOB" for other roster players.
fn station_owners(game: &Value, self_side: &str, self_key: &str, self_idx: usize) -> std::collections::HashMap<i64, String> {
    let mut out = std::collections::HashMap::new();
    for (side_label, coll, side) in [("", "rosters", "home"), ("AWAY ", "awayRosters", "away")] {
        for key in ["varsity", "jv"] {
            for (i, p) in game.get(coll).and_then(|r| r.get(key)).and_then(Value::as_array).into_iter().flatten().enumerate() {
                let n = num_or_zero(p.get("stageStation")).round() as i64;
                if (side == self_side && key == self_key && i == self_idx) || !(1..=10).contains(&n) || out.contains_key(&n) {
                    continue;
                }
                let h = s(p.get("handle"));
                out.insert(n, format!("{side_label}{}{}", if key == "jv" { "JV" } else { "VARSITY" }, if h.is_empty() { String::new() } else { format!(" {h}") }));
            }
        }
    }
    out
}

pub fn view(app: &mut App, ui: &mut egui::Ui, st: &Value) {
    let key = st["selectedGame"].as_str().unwrap_or("overwatch").to_string();
    let cfg = config(&key).unwrap();
    // Rosters / Roster Manager sub tabs (renderRosterSubTabs)
    let sub = if st["rosterSubTab"] == "manager" { "manager" } else { "lineup" };
    ui.horizontal(|ui| {
        for (k, l) in [("lineup", "MATCH LINEUP"), ("manager", "ROSTER MANAGER")] {
            let on = sub == k;
            if ui.add(egui::Button::new(RichText::new(l).strong().color(if on { Color32::BLACK } else { c::TEXT })).fill(if on { c::ORANGE } else { c::PANEL_LIGHT })).clicked() && !on {
                app.set_and_persist(|s| s["rosterSubTab"] = json!(k));
            }
        }
    });
    ui.add_space(8.0);
    if sub == "manager" {
        super::roster_manager::view(app, ui, st);
        return;
    }
    let game = &st["games"][key.as_str()];
    let first = if game["rosterFirstSide"] == "away" { "away" } else { "home" };
    let (fi, si) = if first == "away" { (1, 0) } else { (0, 1) };
    let side = if st["activeRosterSide"] == "away" { "away" } else { "home" };
    let rk = st["activeRoster"].as_str().filter(|s| !s.is_empty()).unwrap_or("varsity").to_string();
    let coll = if side == "away" { "awayRosters" } else { "rosters" };
    let roster = game[coll][rk.as_str()].as_array().cloned().unwrap_or_default();
    let team = &game["teams"][if side == "away" { 1 } else { 0 }];
    let t = |i: usize, k: &str| s(game.pointer(&format!("/teams/{i}/{k}")));

    ui.horizontal(|ui| {
        title(ui, "01", &format!("{} rosters", s(cfg.get("name"))), "Home and away lineups are saved separately for every program");
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if ui.add(egui::Button::new(RichText::new("+ ADD PLAYER").strong().color(Color32::BLACK)).fill(c::ORANGE)).clicked() {
                app.control("add-player", 0, None);
            }
        });
    });
    panel(ui, |ui| {
        ui.horizontal_wrapped(|ui| {
            let show_away = truthy(game.get("showAwayRoster")) || first == "away";
            for (sd, i) in [("home", 0), ("away", 1)] {
                if sd == "away" && !show_away {
                    continue;
                }
                let on = side == sd;
                if ui.add(egui::Button::new(RichText::new(format!("{}  {}", sd.to_uppercase(), t(i, "name"))).strong()).fill(if on { c::ORANGE.gamma_multiply(0.5) } else { c::PANEL_LIGHT })).clicked() && !on {
                    app.set_and_persist(|s| s["activeRosterSide"] = json!(sd));
                }
            }
            ui.add_space(20.0);
            let mut pick = first.to_string();
            egui::ComboBox::from_label("FIRST TEAM SHOWN").selected_text(format!("{} · {}", first.to_uppercase(), t(fi, "name"))).show_ui(ui, |ui| {
                ui.selectable_value(&mut pick, "home".to_string(), format!("HOME · {}", t(0, "name")));
                ui.selectable_value(&mut pick, "away".to_string(), format!("AWAY · {}", t(1, "name")));
            });
            if pick != first {
                let mut m = None;
                app.commit("Changes saved", |st| m = set_field(st, Field::RosterFirstSide { value: &pick }));
                if let Some(m) = m { app.svc.core.lock().save_status = m; }
            }
            let mut away = truthy(game.get("showAwayRoster"));
            let hint = if away { format!("Overlay cycles {} → {}", t(fi, "shortName"), t(si, "shortName")) } else { format!("Overlay shows {} only", t(fi, "shortName")) };
            if ui.checkbox(&mut away, format!("Include second-team roster ({hint})")).changed() {
                let mut m = None;
                app.commit("Changes saved", |st| m = set_field(st, Field::AwayRoster { on: away }));
                if let Some(m) = m { app.svc.core.lock().save_status = m; }
            }
        });
        ui.horizontal(|ui| {
            for (k, l) in [("varsity", "Varsity"), ("jv", "Junior Varsity")] {
                let n = game[coll][k].as_array().map_or(0, |a| a.iter().filter(|p| truthy(p.get("handle")) || truthy(p.get("name"))).count());
                let on = rk == k;
                if ui.add(egui::Button::new(RichText::new(format!("{l}\n{n} players entered")).strong()).fill(if on { c::ORANGE.gamma_multiply(0.5) } else { c::PANEL_LIGHT }).min_size(egui::vec2(180.0, 40.0))).clicked() && !on {
                    app.set_and_persist(|s| s["activeRoster"] = json!(k));
                }
            }
        });
    });
    ui.add_space(8.0);
    let band = hex(&s(team.get("color")));
    egui::Frame::NONE.fill(band.gamma_multiply(0.35)).corner_radius(6.0).inner_margin(10.0).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal(|ui| {
            ui.label(RichText::new(format!("{} LINEUP", side.to_uppercase())).small().color(c::TEXT));
            ui.label(RichText::new(s(team.get("name"))).strong().size(18.0));
            ui.label(RichText::new(if rk == "jv" { "JUNIOR VARSITY" } else { "VARSITY" }).small().color(c::MUTED));
        });
    });
    // reader links (VALORANT board / Overwatch OCR), already mapped by team
    let live = match key.as_str() { "valorant" => game.pointer("/valorantBoard/live"), "overwatch" => game.pointer("/overwatchOcr/live"), _ => None };
    let links: Vec<(usize, isu_core::roster_manager::Link)> = live.and_then(|l| l.pointer(&format!("/teams/{side}/players"))).and_then(Value::as_array).map(|rows| isu_core::roster_manager::live_links(&roster, rows, 0.9)).unwrap_or_default();
    let roster_size = num_or_zero(cfg.get("rosterSize")) as usize;
    for (i, p) in roster.iter().enumerate() {
        player_editor(app, ui, game, cfg, p, i, side, &rk, roster_size, links.iter().find(|l| l.0 == i).map(|l| &l.1), &key);
        ui.add_space(6.0);
    }
    ui.label(RichText::new(format!("{} roster slots · Recommended starters for {}: {roster_size}", roster.len(), s(cfg.get("name")))).small().color(c::MUTED));
}

#[allow(clippy::too_many_arguments)]
fn player_editor(app: &mut App, ui: &mut egui::Ui, game: &Value, cfg: &Value, p: &Value, i: usize, side: &str, rk: &str, roster_size: usize, link: Option<&isu_core::roster_manager::Link>, key: &str) {
    let edit = |app: &App, prop: &str, v: &str| {
        app.commit("Changes saved", |st| { set_field(st, Field::Player { index: i, prop, value: v }); });
    };
    panel(ui, |ui| {
        ui.horizontal_wrapped(|ui| {
            ui.label(RichText::new(format!("{:02}", i + 1)).strong().color(c::ORANGE));
            if let Some(v) = text_field(ui, &format!("p{side}{rk}{i}h"), "GAMERTAG", &s(p.get("handle")), 24, 150.0) {
                edit(app, "handle", &v);
            }
            if let Some(v) = text_field(ui, &format!("p{side}{rk}{i}n"), "PLAYER NAME", &s(p.get("name")), 40, 170.0) {
                edit(app, "name", &v);
            }
            ui.vertical(|ui| {
                ui.label(RichText::new("ROLE").small().color(c::MUTED));
                let cur = s(p.get("role"));
                let mut pick = cur.clone();
                egui::ComboBox::from_id_salt(format!("role{side}{rk}{i}")).selected_text(cur.clone()).show_ui(ui, |ui| {
                    for r in cfg["roles"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                        ui.selectable_value(&mut pick, r.to_string(), r);
                    }
                });
                if pick != cur {
                    edit(app, "role", &pick);
                }
            });
            ui.vertical(|ui| {
                ui.label(RichText::new("STATION").small().color(c::MUTED));
                let owners = station_owners(game, side, rk, i);
                let cur = num_or_zero(p.get("stageStation")) as i64;
                let label = |n: i64| if n == 0 { "Off".to_string() } else { format!("{n:02}{}", owners.get(&n).map(|o| format!(" · {o}")).unwrap_or_default()) };
                let mut pick = cur;
                egui::ComboBox::from_id_salt(format!("st{side}{rk}{i}")).selected_text(label(cur)).show_ui(ui, |ui| {
                    for n in 0..=10 {
                        ui.selectable_value(&mut pick, n, label(n));
                    }
                });
                if pick != cur {
                    edit(app, "stageStation", &if pick == 0 { String::new() } else { pick.to_string() });
                }
            });
            let status = match p.get("libraryStatus").and_then(Value::as_str) { Some("sixth") => "6TH MAN", Some("sub") => "SUB", _ => if i < roster_size { "STARTER" } else { "RESERVE" } };
            ui.label(RichText::new(status).small().strong().color(if i < roster_size { c::ORANGE } else { c::MUTED }));
            if key == "valorant" || key == "overwatch" {
                match link {
                    None => ui.label(RichText::new("READER —").small().color(c::MUTED)).on_hover_text("Not seen on the scoreboard reader"),
                    Some(l) => ui.label(RichText::new(format!("{} {} · {}%{}", if l.linked { "LINKED" } else { "MAYBE" }, l.name, (l.score * 100.0).round(), if l.agent.is_empty() { String::new() } else { format!(" · {}", l.agent.to_uppercase()) })).small().color(if l.linked { Color32::from_rgb(80, 200, 120) } else { c::ORANGE })),
                };
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if app.confirm_button(ui, &format!("rm{side}{rk}{i}"), "×", "Remove?") {
                    app.control("remove-player", i, None);
                }
            });
        });
        ui.horizontal_wrapped(|ui| {
            image_tile(app, ui, "Player portrait", &s(p.get("playerImage")), &s(p.get("playerImageName")), "playerImage", i, "");
            let label = s(cfg.get("characterLabel"));
            ui.vertical(|ui| {
                ui.label(RichText::new(label.to_uppercase()).small().color(c::MUTED));
                let cur = s(p.get("character"));
                let mut pick = cur.clone();
                egui::ComboBox::from_id_salt(format!("ch{side}{rk}{i}")).selected_text(if cur.is_empty() { format!("Select {label}") } else { cur.clone() }).show_ui(ui, |ui| {
                    ui.selectable_value(&mut pick, String::new(), format!("Select {label}"));
                    for h in cfg["characters"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                        ui.selectable_value(&mut pick, h.to_string(), h);
                    }
                });
                if pick != cur {
                    edit(app, "character", &pick);
                }
                let note = if key == "overwatch" { "Hero art is assigned automatically from the selected hero.".to_string() } else if key == "rocketleague" { "Car PNG is unique to this player.".into() } else { format!("Artwork is shared across every {} roster.", s(cfg.get("name"))) };
                ui.label(RichText::new(note).small().color(c::MUTED));
            });
            let ch = s(p.get("character"));
            let art = game.pointer("/characterArt").and_then(|a| a.get(&ch)).cloned().unwrap_or(json!({}));
            if key == "overwatch" {
                ui.vertical(|ui| {
                    ui.label(RichText::new("Hero artwork").strong());
                    ui.label(RichText::new(if ch.is_empty() { format!("Select a {} to preview art", label.to_lowercase()) } else if truthy(art.get("name")) { s(art.get("name")) } else { format!("No {ch} artwork assigned") }).small().color(c::MUTED));
                    ui.label(RichText::new("Assigned automatically").small().italics().color(c::MUTED));
                });
            } else if key == "rocketleague" {
                image_tile(app, ui, "Player car PNG", &s(p.get("characterImage")), &s(p.get("characterImageName")), "characterImage", i, &ch);
            } else {
                image_tile(app, ui, &format!("{label} artwork"), &s(art.get("url")), &s(art.get("name")), "characterArtwork", i, &ch);
            }
        });
    });
}

/// imageTile + pick/clear-player-image handlers.
#[allow(clippy::too_many_arguments)]
fn image_tile(app: &mut App, ui: &mut egui::Ui, label: &str, value: &str, filename: &str, kind: &str, index: usize, character: &str) {
    ui.vertical(|ui| {
        ui.label(RichText::new(label).strong());
        let shown = if !filename.is_empty() { filename.to_string() } else if !character.is_empty() { format!("No {character} artwork yet") } else { "No image selected".into() };
        ui.label(RichText::new(shown).small().color(c::MUTED));
        ui.horizontal(|ui| {
            let disabled = kind == "characterArtwork" && character.is_empty();
            if ui.add_enabled(!disabled, egui::Button::new(if value.is_empty() { "CHOOSE PNG" } else { "REPLACE" })).clicked() {
                let t = if kind == "playerImage" { "Choose player image" } else { "Choose character image" };
                if let Some((name, url)) = pick_image(app, t) {
                    let (k, ch) = (kind.to_string(), character.to_string());
                    let msg = if k == "characterArtwork" { format!("{ch} artwork saved") } else { "Roster image saved".into() };
                    app.commit(&msg, |st| {
                        let g = st["selectedGame"].as_str().unwrap_or("").to_string();
                        if k == "characterArtwork" {
                            st["games"][g.as_str()]["characterArt"][ch.as_str()] = json!({ "url": url, "name": name });
                        } else {
                            let coll = if st["activeRosterSide"] == "away" { "awayRosters" } else { "rosters" };
                            let rk = st["activeRoster"].as_str().filter(|s| !s.is_empty()).unwrap_or("varsity").to_string();
                            let p = &mut st["games"][g.as_str()][coll][rk.as_str()][index];
                            p[k.as_str()] = json!(url);
                            p[format!("{k}Name").as_str()] = json!(name);
                        }
                    });
                }
            }
            if !value.is_empty() && ui.button("CLEAR").clicked() {
                let (k, ch) = (kind.to_string(), character.to_string());
                let msg = if k == "characterArtwork" { format!("{ch} artwork cleared") } else { "Roster image cleared".into() };
                app.commit(&msg, |st| {
                    let g = st["selectedGame"].as_str().unwrap_or("").to_string();
                    if k == "characterArtwork" {
                        // clearing a custom PNG brings back the bundled art (Smash/VALORANT) if there is one
                        let bundled = initial_state()["games"][g.as_str()]["characterArt"].get(&ch).filter(|b| b.get("bundled") == Some(&json!(true))).cloned();
                        let art = &mut st["games"][g.as_str()]["characterArt"];
                        let cur_bundled = art.get(&ch).and_then(|a| a.get("bundled")) == Some(&json!(true));
                        match bundled {
                            Some(b) if !cur_bundled => art[ch.as_str()] = b,
                            _ => { art.as_object_mut().map(|o| o.remove(&ch)); }
                        }
                    } else {
                        let coll = if st["activeRosterSide"] == "away" { "awayRosters" } else { "rosters" };
                        let rk = st["activeRoster"].as_str().filter(|s| !s.is_empty()).unwrap_or("varsity").to_string();
                        let p = &mut st["games"][g.as_str()][coll][rk.as_str()][index];
                        p[k.as_str()] = json!("");
                        p[format!("{k}Name").as_str()] = json!("");
                    }
                });
            }
        });
    });
}
