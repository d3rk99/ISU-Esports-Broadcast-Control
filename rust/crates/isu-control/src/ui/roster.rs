//! Rosters view (app.js renderRosters, renderPlayerEditor, stationOwners, readerLinkChip) and the
//! image picking of main.cjs assets:pick-image (copy into userData/broadcast-assets).
use eframe::egui::{self, Color32, RichText};
use isu_core::controls::{Field, set_field};
use isu_core::game_config::{config, initial_state, js_string, num_or_zero, truthy};
use serde_json::{Value, json};

use super::widgets::{asset_tile, chip, cols, heading, primary_button, select, tab, text_field, toggle};
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
    // .roster-subtabs (renderRosterSubTabs): manager first, then the match roster
    let sub = if st["rosterSubTab"] == "manager" { "manager" } else { "lineup" };
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 8.0;
        for (k, l, n) in [("manager", "ROSTER MANAGER", "Teams & players library · source of truth"), ("lineup", "MATCH ROSTER", "Who is loaded for this match")] {
            if tab(ui, l, n, sub == k, 260.0, "bottom") && sub != k {
                app.set_and_persist(|s| s["rosterSubTab"] = json!(k));
            }
        }
    });
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

    heading(ui, "01", &format!("{} rosters", s(cfg.get("name"))), "Home and away lineups are saved separately for every program", |ui| {
        if ui.add(primary_button("+ ADD PLAYER")).clicked() {
            app.control("add-player", 0, None);
        }
    });
    // .roster-sidebar: side tabs | first team shown | include second roster
    cols(ui, &[-1.0, 290.0, 300.0], 12.0, |j, ui| match j {
        0 => {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 7.0;
                let show_away = truthy(game.get("showAwayRoster")) || first == "away";
                for (sd, i) in [("home", 0), ("away", 1)] {
                    if sd == "away" && !show_away {
                        continue;
                    }
                    if tab(ui, &t(i, "name"), &sd.to_uppercase(), side == sd, 210.0, "left") && side != sd {
                        app.set_and_persist(|s| s["activeRosterSide"] = json!(sd));
                    }
                }
            });
        }
        1 => {
            let options = vec![("home".to_string(), format!("HOME · {}", t(0, "name"))), ("away".to_string(), format!("AWAY · {}", t(1, "name")))];
            if let Some(pick) = select(ui, "first-side", "First team shown", &first.to_string(), &options) {
                let mut m = None;
                app.commit("Changes saved", |st| m = set_field(st, Field::RosterFirstSide { value: &pick }));
                if let Some(m) = m { app.svc.core.lock().save_status = m; }
            }
            ui.label(RichText::new("Selection follows the team when sides are swapped.").size(9.5).color(c::DIM));
        }
        _ => {
            ui.add_space(8.0);
            let mut away = truthy(game.get("showAwayRoster"));
            let hint = if away { format!("Overlay cycles {} → {}", t(fi, "shortName"), t(si, "shortName")) } else { format!("Overlay shows {} only", t(fi, "shortName")) };
            if toggle(ui, &mut away, "Include second-team roster", &hint) {
                let mut m = None;
                app.commit("Changes saved", |st| m = set_field(st, Field::AwayRoster { on: away }));
                if let Some(m) = m { app.svc.core.lock().save_status = m; }
            }
        }
    });
    // .roster-tabs: Varsity / JV
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 8.0;
        for (k, l) in [("varsity", "Varsity"), ("jv", "Junior Varsity")] {
            let n = game[coll][k].as_array().map_or(0, |a| a.iter().filter(|p| truthy(p.get("handle")) || truthy(p.get("name"))).count());
            if tab(ui, l, &format!("{n} players entered"), rk == k, 210.0, "bottom") && rk != k {
                app.set_and_persist(|s| s["activeRoster"] = json!(k));
            }
        }
    });
    // reader links (VALORANT board / Overwatch OCR), already mapped by team
    let live = match key.as_str() { "valorant" => game.pointer("/valorantBoard/live"), "overwatch" => game.pointer("/overwatchOcr/live"), _ => None };
    let links: Vec<(usize, isu_core::roster_manager::Link)> = live.and_then(|l| l.pointer(&format!("/teams/{side}/players"))).and_then(Value::as_array).map(|rows| isu_core::roster_manager::live_links(&roster, rows, 0.9)).unwrap_or_default();
    let roster_size = num_or_zero(cfg.get("rosterSize")) as usize;
    // .roster-panel: band, header, rows, footer
    egui::Frame::NONE.fill(c::PANEL).stroke(egui::Stroke::new(1.0, Color32::from_rgb(0x2d, 0x2d, 0x31))).corner_radius(3.0).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.spacing_mut().item_spacing.y = 0.0;
        let tc = hex(&s(team.get("color")));
        let sec = if truthy(team.get("secondaryColorEnabled")) { hex(&s(team.get("secondaryColor"))) } else { tc };
        let (band, _) = ui.allocate_exact_size(egui::vec2(ui.available_width(), 42.0), egui::Sense::hover());
        let p = ui.painter();
        p.rect_filled(band, 0.0, Color32::from_rgb(0x19, 0x19, 0x1c));
        p.rect_filled(egui::Rect::from_min_size(band.min, egui::vec2(4.0, 21.0)), 0.0, tc);
        p.rect_filled(egui::Rect::from_min_size(egui::pos2(band.left(), band.top() + 21.0), egui::vec2(4.0, 21.0)), 0.0, sec);
        p.hline(band.x_range(), band.bottom(), egui::Stroke::new(1.0, Color32::from_rgb(0x32, 0x32, 0x38)));
        p.text(egui::pos2(band.left() + 17.0, band.center().y), egui::Align2::LEFT_CENTER, format!("{} LINEUP", side.to_uppercase()), egui::FontId::proportional(9.5), tc);
        p.text(egui::pos2(band.left() + 126.0, band.center().y), egui::Align2::LEFT_CENTER, s(team.get("name")), egui::FontId::proportional(12.0), Color32::WHITE);
        p.text(egui::pos2(band.right() - 17.0, band.center().y), egui::Align2::RIGHT_CENTER, if rk == "jv" { "JUNIOR VARSITY" } else { "VARSITY" }, egui::FontId::proportional(9.5), Color32::from_rgb(0x73, 0x73, 0x7b));
        // .roster-header
        egui::Frame::NONE.fill(c::INPUT).inner_margin(egui::Margin::symmetric(15, 11)).show(ui, |ui| {
            ui.set_width(ui.available_width());
            cols(ui, ROW_COLS, 8.0, |j, ui| {
                let l = ["#", "GAMERTAG / HANDLE", "PLAYER NAME", "ROLE", "STATION", "STATUS", ""][j];
                ui.label(RichText::new(l).size(9.0).strong().extra_letter_spacing(0.9).color(Color32::from_rgb(0x5f, 0x5f, 0x66)));
            });
        });
        for (i, p) in roster.iter().enumerate() {
            player_editor(app, ui, game, cfg, p, i, side, &rk, roster_size, links.iter().find(|l| l.0 == i).map(|l| &l.1), &key);
        }
        egui::Frame::NONE.fill(Color32::from_rgb(0x11, 0x11, 0x13)).inner_margin(egui::Margin::symmetric(18, 13)).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                ui.label(RichText::new(format!("{} roster slots", roster.len())).size(10.5).color(Color32::from_rgb(0xa7, 0xa7, 0xad)));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.label(RichText::new(format!("Recommended starters for {}: {roster_size}", s(cfg.get("name")))).size(10.5).color(Color32::from_rgb(0x65, 0x65, 0x6c)));
                });
            });
        });
    });
}

/// .roster-header / .player-row columns: # 46 | handle 1.05fr | name 1fr | role 150 | station 86 | status 220 | x 38
const ROW_COLS: &[f32] = &[46.0, -1.05, -1.0, 150.0, 110.0, 200.0, 38.0];

#[allow(clippy::too_many_arguments)]
fn player_editor(app: &mut App, ui: &mut egui::Ui, game: &Value, cfg: &Value, p: &Value, i: usize, side: &str, rk: &str, roster_size: usize, link: Option<&isu_core::roster_manager::Link>, key: &str) {
    let edit = |app: &App, prop: &str, v: &str| {
        app.commit("Changes saved", |st| { set_field(st, Field::Player { index: i, prop, value: v }); });
    };
    let r = egui::Frame::NONE.inner_margin(egui::Margin { left: 15, right: 15, top: 12, bottom: 13 }).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.spacing_mut().item_spacing.y = 8.0;
        cols(ui, ROW_COLS, 8.0, |j, ui| match j {
            0 => {
                ui.add_space(8.0);
                ui.label(RichText::new(format!("{:02}", i + 1)).size(15.0).strong().color(if i < roster_size { c::ORANGE } else { Color32::from_rgb(0x6c, 0x6c, 0x74) }));
            }
            1 => {
                if let Some(v) = text_field(ui, &format!("p{side}{rk}{i}h"), "", &s(p.get("handle")), 24, 0.0) {
                    edit(app, "handle", &v);
                }
            }
            2 => {
                if let Some(v) = text_field(ui, &format!("p{side}{rk}{i}n"), "", &s(p.get("name")), 40, 0.0) {
                    edit(app, "name", &v);
                }
            }
            3 => {
                let cur = s(p.get("role"));
                let options: Vec<(String, String)> = cfg["roles"].as_array().into_iter().flatten().filter_map(Value::as_str).map(|r| (r.to_string(), r.to_string())).collect();
                if let Some(v) = select(ui, &format!("role{side}{rk}{i}"), "", &cur, &options) {
                    edit(app, "role", &v);
                }
            }
            4 => {
                let owners = station_owners(game, side, rk, i);
                let cur = num_or_zero(p.get("stageStation")) as i64;
                let options: Vec<(i64, String)> = (0..=10).map(|n| (n, if n == 0 { "Off".to_string() } else { format!("{n:02}{}", owners.get(&n).map(|o| format!(" · {o}")).unwrap_or_default()) })).collect();
                if let Some(pick) = select(ui, &format!("st{side}{rk}{i}"), "", &cur, &options) {
                    edit(app, "stageStation", &if pick == 0 { String::new() } else { pick.to_string() });
                }
            }
            5 => {
                ui.add_space(6.0);
                ui.horizontal_wrapped(|ui| {
                    ui.spacing_mut().item_spacing = egui::vec2(4.0, 4.0);
                    let starter = i < roster_size;
                    let status = match p.get("libraryStatus").and_then(Value::as_str) { Some("sixth") => "6TH MAN", Some("sub") => "SUB", _ => if starter { "STARTER" } else { "RESERVE" } };
                    if starter { chip(ui, status, c::ORANGE, c::ORANGE.gamma_multiply(0.08)); } else { chip(ui, status, Color32::from_rgb(0x69, 0x69, 0x71), Color32::from_rgb(0x1c, 0x1c, 0x1f)); }
                    if key == "valorant" || key == "overwatch" {
                        match link {
                            None => { chip(ui, "READER —", Color32::from_rgb(0x55, 0x55, 0x5c), Color32::from_rgb(0x1c, 0x1c, 0x1f)).on_hover_text("Not seen on the scoreboard reader"); }
                            Some(l) => {
                                let txt = format!("{} {} · {}%{}", if l.linked { "LINKED" } else { "MAYBE" }, l.name, (l.score * 100.0).round(), if l.agent.is_empty() { String::new() } else { format!(" · {}", l.agent.to_uppercase()) });
                                if l.linked { chip(ui, &txt, Color32::from_rgb(0x7b, 0xe0, 0x8f), Color32::from_rgb(0x1f, 0x3a, 0x26)); } else { chip(ui, &txt, Color32::from_rgb(0xe6, 0xc3, 0x5c), Color32::from_rgb(0x3a, 0x32, 0x1a)); }
                            }
                        }
                    }
                });
            }
            _ => {
                ui.add_space(2.0);
                if app.confirm_button(ui, &format!("rm{side}{rk}{i}"), "×", "Remove?") {
                    app.control("remove-player", i, None);
                }
            }
        });
        // .player-media-row: portrait | character | art, indented under the number
        let label = s(cfg.get("characterLabel"));
        cols(ui, &[46.0, -1.0, -0.8, -1.0], 10.0, |j, ui| match j {
            0 => {}
            1 => image_tile(app, ui, "Player portrait", &s(p.get("playerImage")), &s(p.get("playerImageName")), "playerImage", i, "", "PLAYER"),
            2 => {
                let cur = s(p.get("character"));
                let mut options: Vec<(String, String)> = vec![(String::new(), format!("Select {label}"))];
                options.extend(cfg["characters"].as_array().into_iter().flatten().filter_map(Value::as_str).map(|h| (h.to_string(), h.to_string())));
                if let Some(v) = select(ui, &format!("ch{side}{rk}{i}"), &label, &cur, &options) {
                    edit(app, "character", &v);
                }
                let note = if key == "overwatch" { "Hero art is assigned automatically from the selected hero.".to_string() } else if key == "rocketleague" { "Car PNG is unique to this player.".into() } else { format!("Artwork is shared across every {} roster.", s(cfg.get("name"))) };
                ui.add(egui::Label::new(RichText::new(note).size(9.5).color(Color32::from_rgb(0x57, 0x57, 0x5e))).wrap());
            }
            _ => {
                let ch = s(p.get("character"));
                let art = game.pointer("/characterArt").and_then(|a| a.get(&ch)).cloned().unwrap_or(json!({}));
                if key == "overwatch" {
                    let file = if ch.is_empty() { format!("Select a {} to preview art", label.to_lowercase()) } else if truthy(art.get("name")) { s(art.get("name")) } else { format!("No {ch} artwork assigned") };
                    asset_tile(ui, "Hero artwork", &s(art.get("url")), &file, &label.to_uppercase(), "", false, false);
                } else if key == "rocketleague" {
                    image_tile(app, ui, "Player car PNG", &s(p.get("characterImage")), &s(p.get("characterImageName")), "characterImage", i, &ch, &label.to_uppercase());
                } else {
                    image_tile(app, ui, &format!("{label} artwork"), &s(art.get("url")), &s(art.get("name")), "characterArtwork", i, &ch, &label.to_uppercase());
                }
            }
        });
    }).response;
    ui.painter().hline(r.rect.x_range(), r.rect.bottom(), egui::Stroke::new(1.0, Color32::from_rgb(0x24, 0x24, 0x28)));
}

/// imageTile + pick/clear-player-image handlers.
#[allow(clippy::too_many_arguments)]
fn image_tile(app: &mut App, ui: &mut egui::Ui, label: &str, value: &str, filename: &str, kind: &str, index: usize, character: &str, placeholder: &str) {
    let shown = if !filename.is_empty() { filename.to_string() } else if !character.is_empty() { format!("No {character} artwork yet") } else { "No image selected".into() };
    let disabled = kind == "characterArtwork" && character.is_empty();
    let (choose, clear) = asset_tile(ui, label, value, &shown, placeholder, if value.is_empty() { "CHOOSE PNG" } else { "REPLACE" }, !disabled, !value.is_empty());
    {
        {
            if choose {
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
            if clear {
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
        }
    }
}
