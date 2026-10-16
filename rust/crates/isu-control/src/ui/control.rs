//! Match Control view (app.js renderControl, renderTeamControl, renderRocketLeaguePanel,
//! renderOverwatchBans; field / formatSelect).
use eframe::egui::{self, Color32, RichText};
use isu_core::controls::{series_length, series_target, visible_rows};
use isu_core::game_config::{config, js_string, num_or_zero, truthy};
use serde_json::{Value, json};

use super::widgets::{color_field, field_label, heading, inset, panel, primary_button, cols, secondary_button, select, text_field, title, toggle};
use super::{App, c, hex};

fn s(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        x => js_string(x),
    }
}

/// formatGameClock(seconds, overtime).
pub fn game_clock(seconds: Option<&Value>, overtime: bool) -> String {
    let t = num_or_zero(seconds).floor().max(0.0) as i64;
    let body = format!("{}:{:02}", t / 60, t % 60);
    if overtime { format!("OT +{body}") } else { body }
}

pub fn view(app: &mut App, ui: &mut egui::Ui, st: &Value) {
    let key = st["selectedGame"].as_str().unwrap_or("overwatch").to_string();
    let cfg = config(&key).unwrap();
    let game = &st["games"][key.as_str()];
    let active = num_or_zero(game.get("activeMap")) as usize;
    let row = game["mapRows"].get(active).or_else(|| game["mapRows"].get(0)).cloned().unwrap_or(json!({}));
    let length = series_length(game, &key);
    let next = (active + 1) % (length.max(1.0) as usize);
    let live = truthy(game.pointer("/match/live"));
    let rl_live = game.pointer("/rocketLeague/live");
    let unit = if key == "rocketleague" || key == "smash" { "GAME" } else { "MAP" };

    // 01 Live scoreboard
    heading(ui, "01", "Live scoreboard", "Primary match data", |ui| {
        let b = if live { egui::Button::new(RichText::new("● Take off air").strong().color(Color32::from_rgb(0xff, 0x6b, 0x63))).fill(Color32::from_rgb(0x2a, 0x13, 0x12)).stroke(egui::Stroke::new(1.0, Color32::from_rgb(0xd9, 0x47, 0x3e))).min_size(egui::vec2(0.0, 37.0)) } else { secondary_button("● Take live") };
        if ui.add(b).clicked() {
            app.control("toggle-live", 0, None);
        }
    });
    scoreboard_preview(ui, game, cfg, &key, &row, active, live, rl_live, unit);
    ui.add_space(6.0);

    // .control-grid: home | middle buttons | away
    cols(ui, &[-1.0, 170.0, -1.0], 11.0, |i, ui| match i {
        0 => team_control(app, ui, game, 0, &key),
        1 => {
            ui.add_space(26.0);
            let w = ui.available_width();
            if ui.add(secondary_button("⇄ SWAP SIDES").min_size(egui::vec2(w, 40.0))).on_hover_text("Swap team sides").clicked() {
                app.control("swap-teams", 0, None);
            }
            if app.confirm_button(ui, "reset-scores", "RESET SCORES", "Click again to reset scores") {
                app.control("reset-scores", 0, None);
            }
            if ui.add(primary_button(&format!("NEXT MATCH\nTO {unit} {}", next + 1)).min_size(egui::vec2(w, 58.0))).clicked() {
                app.control("next-match", 0, None);
            }
        }
        _ => team_control(app, ui, game, 1, &key),
    });

    if key == "rocketleague" {
        rocket_league_panel(app, ui, game);
        ui.add_space(10.0);
    }
    if key == "valorant" {
        super::readers::valorant(app, ui, st);
        ui.add_space(10.0);
    }
    if key == "overwatch" {
        overwatch_bans(app, ui, game, cfg);
        ui.add_space(10.0);
        super::readers::overwatch(app, ui, st);
        ui.add_space(10.0);
    }

    // .lower-grid 1.7fr / .8fr
    cols(ui, &[-1.7, -0.8], 15.0, |i, ui| {
        if i == 0 {
            panel(ui, |ui| {
                title(ui, "02", "Match details", "Information shared across graphics");
                cols(ui, &[-1.0, -1.0], 10.0, |j, ui| {
                    if j == 0 {
                        if let Some(v) = text_field(ui, "match.event", "Event / league", &s(game.pointer("/match/event")), 60, 0.0) {
                            app.commit("Changes saved", |st| st["games"][key.as_str()]["match"]["event"] = json!(v));
                        }
                    } else if let Some(v) = text_field(ui, "match.round", "Round / stage", &s(game.pointer("/match/round")), 60, 0.0) {
                        app.commit("Changes saved", |st| st["games"][key.as_str()]["match"]["round"] = json!(v));
                    }
                });
                ui.add_space(4.0);
                cols(ui, &[-1.0, -1.0], 10.0, |j, ui| {
                    if j == 0 {
                        if let Some(opts) = cfg["formatOptions"].as_array().filter(|a| !a.is_empty()) {
                            let options: Vec<(f64, String)> = opts.iter().filter_map(Value::as_f64).map(|o| (o, format!("Best of {o}"))).collect();
                            if let Some(pick) = select(ui, "format", "Series format", &length, &options) {
                                app.commit(&format!("Format set to Best of {pick}"), |st| isu_core::controls::sync_format(st, pick));
                            }
                            ui.label(RichText::new(format!("First to {}", series_target(game, &key))).size(10.0).color(c::DIM));
                        } else if let Some(v) = text_field(ui, "match.format", "Series format", &s(game.pointer("/match/format")), 60, 0.0) {
                            app.commit("Changes saved", |st| st["games"][key.as_str()]["match"]["format"] = json!(v));
                        }
                    } else {
                        let rows = game["mapRows"].as_array().cloned().unwrap_or_default();
                        let options: Vec<(usize, String)> = (0..visible_rows(game, &key)).map(|i| (i, format!("{} — {}", i + 1, { let m = s(rows.get(i).and_then(|r| r.get("map"))); if m.is_empty() { "TBD".into() } else { m } }))).collect();
                        if let Some(pick) = select(ui, "activeMap", "Active map", &active, &options) {
                            app.commit("Changes saved", |st| st["games"][key.as_str()]["activeMap"] = json!(pick));
                        }
                    }
                });
            });
        } else {
            panel(ui, |ui| {
                let label = match key.as_str() { "valorant" => "Current round score", "rocketleague" => "Current game goals", "smash" => "Current stocks", _ => "Live map score" };
                title(ui, "", label, "Optional in-game value");
                cols(ui, &[-1.0, -1.0], 10.0, |t, ui| detail_score(app, ui, game, t));
            });
        }
    });
}

/// .detail-score-row > div: team label on top, [−] value [+].
fn detail_score(app: &App, ui: &mut egui::Ui, game: &Value, t: usize) {
    inset(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.vertical_centered(|ui| ui.label(RichText::new(s(game.pointer(&format!("/teams/{t}/shortName")))).size(9.5).strong().color(c::DIM)));
        cols(ui, &[34.0, -1.0, 34.0], 4.0, |j, ui| match j {
            0 => {
                if ui.add(egui::Button::new(RichText::new("−").size(17.0)).min_size(egui::vec2(34.0, 36.0))).clicked() {
                    app.control("detail-minus", t, None);
                }
            }
            1 => {
                ui.vertical_centered(|ui| ui.label(RichText::new(s(game.pointer(&format!("/teams/{t}/detailScore")))).size(24.0).strong().color(c::TEXT)));
            }
            _ => {
                if ui.add(egui::Button::new(RichText::new("+").size(17.0)).min_size(egui::vec2(34.0, 36.0))).clicked() {
                    app.control("detail-plus", t, None);
                }
            }
        });
    });
}

/// .scoreboard-stage: dark stage with the preview bar (team | orange score | team) and the map strip.
#[allow(clippy::too_many_arguments)]
fn scoreboard_preview(ui: &mut egui::Ui, game: &Value, cfg: &Value, key: &str, row: &Value, active: usize, live: bool, rl_live: Option<&Value>, unit: &str) {
    let (rect, _) = ui.allocate_exact_size(egui::vec2(ui.available_width(), 230.0), egui::Sense::hover());
    let p = ui.painter_at(rect);
    p.rect(rect, 4.0, Color32::from_rgb(0x14, 0x14, 0x17), egui::Stroke::new(1.0, Color32::from_rgb(0x2d, 0x2d, 0x31)), egui::StrokeKind::Inside);
    // faint grid
    let grid = Color32::from_rgba_unmultiplied(255, 255, 255, 6);
    let mut x = rect.left();
    while x < rect.right() { p.vline(x, rect.y_range(), egui::Stroke::new(1.0, grid)); x += 36.0; }
    let mut y = rect.top();
    while y < rect.bottom() { p.hline(rect.x_range(), y, egui::Stroke::new(1.0, grid)); y += 36.0; }
    let w = (rect.width() * 0.83).min(850.0);
    let cx = rect.center().x;
    let bar = egui::Rect::from_center_size(egui::pos2(cx, rect.center().y - 8.0), egui::vec2(w, 88.0));
    // meta line
    let meta = format!("{}     {}     {}", s(game.pointer("/match/event")), s(game.pointer("/match/round")), s(game.pointer("/match/format")));
    p.text(egui::pos2(cx, bar.top() - 16.0), egui::Align2::CENTER_CENTER, meta.to_uppercase(), egui::FontId::proportional(10.0), Color32::from_rgb(0x95, 0x95, 0x9d));
    let mid_w = 140.0;
    let left = egui::Rect::from_min_max(bar.min, egui::pos2(cx - mid_w / 2.0, bar.bottom()));
    let right = egui::Rect::from_min_max(egui::pos2(cx + mid_w / 2.0, bar.top()), bar.max);
    p.rect_filled(left, 0.0, Color32::from_rgb(0x1f, 0x1f, 0x23));
    p.rect_filled(right, 0.0, Color32::from_rgb(0x1f, 0x1f, 0x23));
    for (t, r, home) in [(&game["teams"][0], left, true), (&game["teams"][1], right, false)] {
        let badge = if home { egui::Rect::from_center_size(egui::pos2(r.left() + 48.0, r.center().y), egui::vec2(46.0, 46.0)) } else { egui::Rect::from_center_size(egui::pos2(r.right() - 48.0, r.center().y), egui::vec2(46.0, 46.0)) };
        p.rect(badge, 0.0, hex(&s(t.get("color"))), egui::Stroke::new(1.0, Color32::from_white_alpha(60)), egui::StrokeKind::Inside);
        let short: String = s(t.get("shortName")).chars().take(3).collect();
        p.text(badge.center(), egui::Align2::CENTER_CENTER, short, egui::FontId::proportional(14.0), Color32::WHITE);
        let (tx, al) = if home { (badge.right() + 14.0, egui::Align2::LEFT_CENTER) } else { (badge.left() - 14.0, egui::Align2::RIGHT_CENTER) };
        p.text(egui::pos2(tx, r.center().y - 11.0), al, if home { "HOME" } else { "AWAY" }, egui::FontId::proportional(9.5), Color32::from_rgb(0x75, 0x75, 0x7d));
        p.text(egui::pos2(tx, r.center().y + 8.0), al, s(t.get("name")), egui::FontId::proportional(17.0), Color32::WHITE);
    }
    let mid = egui::Rect::from_center_size(bar.center(), egui::vec2(mid_w + 16.0, 88.0));
    let k = 14.0;
    p.add(egui::Shape::convex_polygon(vec![egui::pos2(mid.left() + k, mid.top()), egui::pos2(mid.right() - k, mid.top()), egui::pos2(mid.right(), mid.center().y), egui::pos2(mid.right() - k, mid.bottom()), egui::pos2(mid.left() + k, mid.bottom()), egui::pos2(mid.left(), mid.center().y)], c::ORANGE, egui::Stroke::NONE));
    p.text(egui::pos2(cx, mid.top() + 15.0), egui::Align2::CENTER_CENTER, s(cfg.get("scoreLabel")).to_uppercase(), egui::FontId::proportional(8.5), Color32::from_rgb(0x27, 0x16, 0x0b));
    p.text(mid.center(), egui::Align2::CENTER_CENTER, format!("{} — {}", s(game.pointer("/teams/0/score")), s(game.pointer("/teams/1/score"))), egui::FontId::proportional(28.0), Color32::from_rgb(0x11, 0x11, 0x11));
    let tag = egui::Rect::from_center_size(egui::pos2(cx, mid.bottom() - 15.0), egui::vec2(58.0, 15.0));
    p.rect_filled(tag, 0.0, Color32::from_rgb(0x17, 0x17, 0x19));
    p.text(tag.center(), egui::Align2::CENTER_CENTER, if live { "LIVE" } else { "PREVIEW" }, egui::FontId::proportional(8.5), if live { Color32::from_rgb(0xff, 0x6b, 0x63) } else { Color32::WHITE });
    // .preview-map strip
    let map_name = if key == "rocketleague" && rl_live.is_some_and(|l| truthy(l.get("arena"))) { isu_core::game_config::rocket_league_arena_name(&s(rl_live.unwrap().get("arena"))) } else { s(row.get("map")) };
    let mode = if key == "rocketleague" && rl_live.is_some() { game_clock(rl_live.unwrap().get("timeSeconds"), truthy(rl_live.unwrap().get("overtime"))) } else { s(row.get("mode")) };
    let strip = egui::Rect::from_center_size(egui::pos2(cx, bar.bottom() + 15.0), egui::vec2((w * 0.45).max(330.0), 30.0));
    p.rect_filled(strip, 0.0, Color32::from_rgb(0x0b, 0x0b, 0x0c));
    let line = format!("{unit} {}    {}    {}", active + 1, if map_name.is_empty() { "TBD".into() } else { map_name.to_uppercase() }, mode.to_uppercase());
    p.text(strip.center(), egui::Align2::CENTER_CENTER, line, egui::FontId::proportional(10.5), Color32::from_rgb(0xe3, 0xe3, 0xe5));
    p.text(egui::pos2(rect.right() - 14.0, rect.bottom() - 14.0), egui::Align2::RIGHT_CENTER, "CONTROL PREVIEW", egui::FontId::proportional(9.0), Color32::from_rgb(0x4f, 0x4f, 0x56));
}

fn team_control(app: &mut App, ui: &mut egui::Ui, game: &Value, i: usize, key: &str) {
    let team = &game["teams"][i];
    let target = series_target(game, key);
    let k = key.to_string();
    panel(ui, |ui| {
        ui.horizontal(|ui| {
            ui.label(RichText::new(if i == 0 { "HOME TEAM" } else { "AWAY TEAM" }).size(10.0).strong().extra_letter_spacing(1.4).color(Color32::from_rgb(0x77, 0x77, 0x7f)));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let (r, _) = ui.allocate_exact_size(egui::vec2(24.0, 4.0), egui::Sense::hover());
                let sec = if truthy(team.get("secondaryColorEnabled")) { s(team.get("secondaryColor")) } else { s(team.get("color")) };
                ui.painter().rect_filled(egui::Rect::from_min_max(r.min, egui::pos2(r.left() + 13.0, r.bottom())), 0.0, hex(&s(team.get("color"))));
                ui.painter().rect_filled(egui::Rect::from_min_max(egui::pos2(r.left() + 13.0, r.top()), r.max), 0.0, hex(&sec));
            });
        });
        // .team-fields: name 1fr | abbr 60 | primary 42 | secondary 42 | use 46
        let sec_on = truthy(team.get("secondaryColorEnabled"));
        cols(ui, &[-1.0, 60.0, 44.0, 44.0, 40.0], 7.0, |j, ui| match j {
            0 => {
                if let Some(v) = text_field(ui, &format!("t{i}name"), "Display name", &s(team.get("name")), 32, 0.0) {
                    app.commit("Changes saved", |st| st["games"][k.as_str()]["teams"][i]["name"] = json!(v));
                }
            }
            1 => {
                if let Some(v) = text_field(ui, &format!("t{i}short"), "Abbr.", &s(team.get("shortName")), 5, 0.0) {
                    app.commit("Changes saved", |st| st["games"][k.as_str()]["teams"][i]["shortName"] = json!(v));
                }
            }
            2 => {
                if let Some(v) = color_field(ui, "Primary", &s(team.get("color")), true) {
                    app.commit("Changes saved", |st| st["games"][k.as_str()]["teams"][i]["color"] = json!(v));
                }
            }
            3 => {
                if let Some(v) = color_field(ui, "2nd", &s(team.get("secondaryColor")), sec_on) {
                    app.commit("Changes saved", |st| st["games"][k.as_str()]["teams"][i]["secondaryColor"] = json!(v));
                }
            }
            _ => {
                field_label(ui, "Use");
                let mut on = sec_on;
                if ui.checkbox(&mut on, "").on_hover_text("Use the secondary colour").changed() {
                    app.commit("Changes saved", |st| st["games"][k.as_str()]["teams"][i]["secondaryColorEnabled"] = json!(on));
                }
            }
        });
        ui.add_space(2.0);
        // .team-logo-row: thumb 56 | url 1fr | actions 120
        let logo = s(team.get("logoImage"));
        cols(ui, &[56.0, -1.0, 112.0], 8.0, |j, ui| match j {
            0 => {
                let (r, _) = ui.allocate_exact_size(egui::vec2(56.0, 55.0), egui::Sense::hover());
                ui.painter().rect(r, 2.0, c::INPUT, egui::Stroke::new(1.0, c::BORDER), egui::StrokeKind::Inside);
                if logo.is_empty() {
                    ui.painter().text(r.center(), egui::Align2::CENTER_CENTER, "LOGO", egui::FontId::proportional(9.0), c::DIM);
                } else {
                    let url = if logo.starts_with("/assets/") { format!("http://127.0.0.1:3174{logo}") } else { logo.clone() };
                    egui::Image::new(url).fit_to_exact_size(r.shrink(5.0).size()).paint_at(ui, r.shrink(5.0));
                }
            }
            1 => {
                if let Some(v) = text_field(ui, &format!("t{i}logo"), "Logo URL", &logo, 2000, 0.0) {
                    app.commit("Changes saved", |st| {
                        st["games"][k.as_str()]["teams"][i]["logoImageName"] = json!(if v.is_empty() { "" } else { "Custom URL" });
                        st["games"][k.as_str()]["teams"][i]["logoImage"] = json!(v);
                    });
                }
            }
            _ => {
                let name = s(team.get("logoImageName"));
                ui.spacing_mut().item_spacing.y = 4.0;
                ui.add(egui::Label::new(RichText::new(if !name.is_empty() { name } else if !logo.is_empty() { "Custom URL".into() } else { "No logo selected".into() }).size(9.5).color(c::DIM)).truncate());
                let w = ui.available_width();
                if ui.add(egui::Button::new(RichText::new(if logo.is_empty() { "CHOOSE FILE" } else { "REPLACE FILE" }).size(10.0).strong()).min_size(egui::vec2(w, 22.0))).clicked() {
                    if let Some((n, url)) = super::roster::pick_image(app, "Choose team logo image") {
                        app.commit("Team logo saved", |st| {
                            st["games"][k.as_str()]["teams"][i]["logoImage"] = json!(url);
                            st["games"][k.as_str()]["teams"][i]["logoImageName"] = json!(n);
                        });
                    }
                }
                if !logo.is_empty() && ui.add(egui::Button::new(RichText::new("CLEAR").size(10.0).strong().color(Color32::from_rgb(0xe9, 0x78, 0x70))).min_size(egui::vec2(w, 22.0))).clicked() {
                    app.commit("Team logo cleared", |st| {
                        st["games"][k.as_str()]["teams"][i]["logoImage"] = json!("");
                        st["games"][k.as_str()]["teams"][i]["logoImageName"] = json!("");
                    });
                }
            }
        });
        ui.add_space(4.0);
        // .score-control: [−] score box [+], 69 px tall
        cols(ui, &[52.0, -1.0, 52.0], 8.0, |j, ui| match j {
            0 => {
                if ui.add(egui::Button::new(RichText::new("−").size(24.0)).min_size(egui::vec2(52.0, 69.0))).clicked() {
                    app.control("score-minus", i, None);
                }
            }
            1 => {
                inset(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.set_height(49.0);
                    ui.horizontal_centered(|ui| {
                        ui.label(RichText::new(s(config(key).unwrap().get("scoreLabel")).to_uppercase()).size(10.0).strong().color(Color32::from_rgb(0x77, 0x77, 0x7f)));
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            ui.label(RichText::new(format!("of {target}")).size(10.0).color(Color32::from_rgb(0x58, 0x58, 0x5f)));
                            ui.label(RichText::new(s(team.get("score"))).size(32.0).strong().color(c::TEXT));
                        });
                    });
                });
            }
            _ => {
                if ui.add(egui::Button::new(RichText::new("+").size(24.0).color(Color32::from_rgb(0x10, 0x10, 0x10))).fill(c::ORANGE).stroke(egui::Stroke::new(1.0, Color32::from_rgb(0xd4, 0x64, 0x18))).min_size(egui::vec2(52.0, 69.0))).clicked() {
                    app.control("score-plus", i, None);
                }
            }
        });
    });
}

/// rl[prop] change (app.js data-rl-prop handler).
fn rl_set(app: &App, prop: &str, v: Value) {
    let p = prop.to_string();
    app.commit("Rocket League settings saved", |st| {
        let rl = &mut st["games"]["rocketleague"]["rocketLeague"];
        rl[p.as_str()] = v;
        if p == "updateIntervalMs" {
            let n = num_or_zero(rl.get("updateIntervalMs"));
            rl["updateIntervalMs"] = json!((if n == 0.0 { 33.0 } else { n }).round().clamp(1.0, 50.0));
        }
        if p == "blueTeam" {
            let rl2 = rl.clone();
            isu_core::rocket_league::apply_scores(&mut st["games"]["rocketleague"]);
            if truthy(rl2.get("syncPlayers")) {
                if let Some(ps) = st["games"]["rocketleague"]["rocketLeague"]["live"]["players"].as_array_mut() {
                    ps.sort_by(|a, b| isu_core::rocket_league::map_team(a.get("teamNum"), &rl2).partial_cmp(&isu_core::rocket_league::map_team(b.get("teamNum"), &rl2)).unwrap_or(std::cmp::Ordering::Equal));
                }
            }
        }
    });
    if p_is_conn(prop) {
        app.svc.sync_rl();
    } else if prop == "updateIntervalMs" {
        let v = app.state().pointer("/games/rocketleague/rocketLeague/updateIntervalMs").cloned().unwrap_or(json!(33));
        app.svc.rl.set_update_interval(&v);
    }
}

fn p_is_conn(p: &str) -> bool {
    ["enabled", "source", "transport", "host", "tcpPort", "webPort", "bridgePort", "bridgeToken"].contains(&p)
}

fn num_field(v: &str) -> Value {
    json!(isu_core::game_config::js_number(v).unwrap_or(f64::NAN))
}

fn stat(ui: &mut egui::Ui, label: &str, value: &str) {
    inset(ui, |ui| {
        ui.set_width(ui.available_width());
        field_label(ui, label);
        ui.add(egui::Label::new(RichText::new(value).strong().size(14.0).color(c::TEXT)).truncate());
    });
}

fn rocket_league_panel(app: &mut App, ui: &mut egui::Ui, game: &Value) {
    let rl = &game["rocketLeague"];
    let live = &rl["live"];
    let status = s(live.get("status"));
    let status_col = match status.as_str() { "connected" | "simulating" => Color32::from_rgb(0x70, 0xcd, 0x6a), "error" => c::RED, "waiting" | "connecting" | "idle" | "listening" => Color32::from_rgb(0xe8, 0xb3, 0x3c), _ => c::DIM };
    panel(ui, |ui| {
        heading(ui, "", "Live game connection", "ROCKET LEAGUE STATS API · official game telemetry, no BakkesMod required", |ui| {
            ui.vertical(|ui| {
                ui.with_layout(egui::Layout::top_down(egui::Align::Max), |ui| {
                    ui.label(RichText::new(format!("●  {}", status.to_uppercase())).strong().size(11.0).color(status_col));
                    ui.label(RichText::new(s(live.get("message"))).size(10.0).color(c::DIM));
                });
            });
        });
        // .rl-connection-grid: toggle 170 | 4 fields
        let src = s(rl.get("source"));
        cols(ui, &[180.0, -1.0, -1.0, -1.0, -1.0], 9.0, |j, ui| match (j, src.as_str()) {
            (0, _) => {
                let mut en = truthy(rl.get("enabled"));
                ui.add_space(12.0);
                let note = if en { "Enabled" } else { "Disabled" };
                if toggle(ui, &mut en, "LIVE DATA", note) {
                    rl_set(app, "enabled", json!(en));
                }
            }
            (1, _) => {
                if let Some(v) = select(ui, "rl-source", "Data source", &src, &[("local".to_string(), "This PC / direct".into()), ("remote".to_string(), "Game PC bridge".into())]) {
                    rl_set(app, "source", json!(v));
                }
            }
            (2, _) => {
                if let Some(v) = text_field(ui, "rl-interval", "Boost update interval (ms)", &s(rl.get("updateIntervalMs")), 3, 0.0) {
                    rl_set(app, "updateIntervalMs", num_field(&v));
                }
                let ms = num_or_zero(rl.get("updateIntervalMs"));
                ui.label(RichText::new(format!("1–50 ms · {} updates/sec", (1000.0 / (if ms == 0.0 { 33.0 } else { ms }).max(1.0)).round().clamp(1.0, 120.0))).size(9.5).color(c::DIM));
            }
            (3, "remote") => {
                if let Some(v) = text_field(ui, "rl-bport", "Receiver port", &s(rl.get("bridgePort")), 5, 0.0) {
                    rl_set(app, "bridgePort", num_field(&v));
                }
            }
            (4, "remote") => {
                if let Some(v) = text_field(ui, "rl-token", "Bridge key", &s(rl.get("bridgeToken")), 128, 0.0) {
                    rl_set(app, "bridgeToken", json!(v));
                }
                ui.horizontal(|ui| {
                    if ui.small_button("GENERATE").clicked() {
                        let k = random_key();
                        app.commit("Private bridge key generated", |st| st["games"]["rocketleague"]["rocketLeague"]["bridgeToken"] = json!(k));
                        app.svc.sync_rl();
                    }
                    ui.label(RichText::new(format!("Graphics PC: {}", if app.addresses.is_empty() { "address unavailable".into() } else { app.addresses.join(" / ") })).size(9.5).color(c::DIM));
                });
            }
            (3, _) => {
                let tr = s(rl.get("transport"));
                if let Some(v) = select(ui, "rl-transport", "Transport", &tr, &[("auto".to_string(), "Automatic (WebSocket → TCP)".into()), ("websocket".to_string(), "WebSocket · 49124".into()), ("tcp".to_string(), "TCP · 49123".into())]) {
                    rl_set(app, "transport", json!(v));
                }
            }
            _ => {
                cols(ui, &[-1.6, -1.0, -1.0], 6.0, |k, ui| match k {
                    0 => {
                        if let Some(v) = text_field(ui, "rl-host", "Host", &s(rl.get("host")), 255, 0.0) {
                            rl_set(app, "host", json!(v));
                        }
                    }
                    1 => {
                        if let Some(v) = text_field(ui, "rl-tcp", "TCP", &s(rl.get("tcpPort")), 5, 0.0) {
                            rl_set(app, "tcpPort", num_field(&v));
                        }
                    }
                    _ => {
                        if let Some(v) = text_field(ui, "rl-ws", "WebSocket", &s(rl.get("webPort")), 5, 0.0) {
                            rl_set(app, "webPort", num_field(&v));
                        }
                    }
                });
            }
        });
        ui.separator();
        // .rl-toolbar
        ui.horizontal(|ui| {
            if ui.add(secondary_button("COPY GAME CONFIG")).clicked() {
                // copy-rl-config: TAGame.MatchStatsExporter_TA block for the game's ini
                let ms = num_or_zero(rl.get("updateIntervalMs"));
                let rate = (1000.0 / (if ms == 0.0 { 33.0 } else { ms }).max(1.0)).round().clamp(1.0, 120.0);
                ui.ctx().copy_text(format!("[TAGame.MatchStatsExporter_TA]\nPacketSendRate={rate}\nPort={}\nWebPort={}", s(rl.get("tcpPort")), s(rl.get("webPort"))));
                app.toast("Rocket League configuration copied");
            }
            let simulating = status == "simulating";
            if ui.add(secondary_button(if simulating { "STOP TEST FEED" } else { "RUN TEST FEED" })).clicked() {
                let rl2 = std::sync::Arc::clone(&app.svc.rl);
                let _g = app.svc.rt.enter();
                if simulating {
                    rl2.stop_simulator();
                    app.toast("Test feed stopped");
                } else {
                    rl2.start_simulator();
                    app.toast("Rocket League test feed started");
                }
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let packets = s(live.get("packets"));
                ui.label(RichText::new(format!("{} · {} PACKETS · {:.1} PKT/S", if truthy(live.get("lastPacketAt")) { format!("LAST PACKET {}", s(live.get("lastPacketAt"))) } else { "NO MATCH DATA RECEIVED".into() }, if packets.is_empty() { "0".into() } else { packets }, num_or_zero(live.get("packetRate")))).size(10.0).color(c::DIM));
            });
        });
        // .rl-live-summary
        let arena: String = { let a = s(live.get("arena")); if a.is_empty() { "WAITING FOR MATCH".into() } else { a } };
        let guid: String = { let g = s(live.get("matchGuid")); if g.is_empty() { "-".into() } else { g.chars().take(14).collect() } };
        let spec: String = { let p = s(live.get("spectatedPlayer")); if p.is_empty() { "-".into() } else { p } };
        let clock = game_clock(live.get("timeSeconds"), truthy(live.get("overtime")));
        cols(ui, &[-1.0, -1.0, -1.0, -1.0], 9.0, |j, ui| match j {
            0 => stat(ui, "Game clock", &clock),
            1 => stat(ui, "Arena", &arena),
            2 => stat(ui, "Match ID", &guid),
            _ => stat(ui, "Spectating", &spec),
        });
        // .rl-settings-grid: mapping | automation | stat card
        cols(ui, &[-0.9, -1.6, -0.9], 14.0, |j, ui| match j {
            0 => {
                field_label(ui, "Team mapping");
                let blue = num_or_zero(rl.get("blueTeam")) as i64;
                if let Some(v) = select(ui, "rl-blue", "Blue team is", &blue, &[(0, format!("Home · {}", s(game.pointer("/teams/0/shortName")))), (1, format!("Away · {}", s(game.pointer("/teams/1/shortName"))))]) {
                    rl_set(app, "blueTeam", json!(v));
                }
                ui.label(RichText::new("Orange is assigned to the opposite side.").size(10.0).color(c::DIM));
            }
            1 => {
                field_label(ui, "Automation");
                let items = [("syncGoals", "Game goals"), ("syncClock", "Clock & overtime"), ("syncPlayers", "Players & boost"), ("autoRoster", "Auto roster & cars"), ("autoSeriesScore", "Series score"), ("autoAdvance", "Advance next game")];
                egui::Grid::new("rl-auto").num_columns(2).spacing([18.0, 4.0]).show(ui, |ui| {
                    for (n, (p, l)) in items.iter().enumerate() {
                        let mut on = truthy(rl.get(*p));
                        if ui.checkbox(&mut on, *l).changed() {
                            rl_set(app, p, json!(on));
                        }
                        if n % 2 == 1 {
                            ui.end_row();
                        }
                    }
                });
            }
            _ => {
                field_label(ui, "Stat card");
                let mut hs = rl.get("statCardHeadshot") != Some(&json!(false));
                if ui.checkbox(&mut hs, "Show headshot").on_hover_text("Off = team logo only").changed() {
                    rl_set(app, "statCardHeadshot", json!(hs));
                }
                ui.label(RichText::new("Off = team logo only").size(10.0).color(c::DIM));
            }
        });
        // .rl-player-grid: 3 per row
        let players = live["players"].as_array().cloned().unwrap_or_default();
        if players.is_empty() {
            inset(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.label(RichText::new("Players and boost meters appear here when the spectator enters a match.").size(11.0).color(c::DIM));
            });
        }
        for chunk in players.chunks(3) {
            cols(ui, &[-1.0, -1.0, -1.0], 9.0, |j, ui| {
                let Some(p) = chunk.get(j) else { return };
                let ti = isu_core::rocket_league::map_team(p.get("teamNum"), rl);
                let team = game["teams"].get(ti.max(0.0) as usize).cloned().unwrap_or(json!({}));
                let tc = hex(&s(team.get("color")));
                egui::Frame::NONE.fill(c::INPUT).stroke(egui::Stroke::new(1.0, Color32::from_rgb(0x2f, 0x2f, 0x34))).corner_radius(2.0).inner_margin(10.0).show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.horizontal(|ui| {
                        ui.label(RichText::new(s(team.get("shortName"))).size(10.0).strong().color(tc));
                        ui.label(RichText::new(s(p.get("name"))).strong().color(c::TEXT));
                        if truthy(p.get("spectated")) {
                            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| ui.label(RichText::new("ON CAMERA").size(9.5).strong().color(c::ORANGE)));
                        }
                    });
                    let boost = p.get("boost").and_then(Value::as_f64).map(|b| b.clamp(0.0, 100.0));
                    let (r, _) = ui.allocate_exact_size(egui::vec2(ui.available_width(), 6.0), egui::Sense::hover());
                    ui.painter().rect_filled(r, 1.0, Color32::from_rgb(0x22, 0x22, 0x26));
                    ui.painter().rect_filled(egui::Rect::from_min_size(r.min, egui::vec2(r.width() * boost.unwrap_or(0.0) as f32 / 100.0, r.height())), 1.0, tc);
                    ui.horizontal(|ui| {
                        ui.label(RichText::new(boost.map_or("—".into(), |b| format!("{}", b.round()))).size(18.0).strong().color(c::TEXT));
                        ui.label(RichText::new("BOOST").size(9.5).color(c::DIM));
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            ui.label(RichText::new(format!("{} G · {} A · {} S", num_or_zero(p.get("goals")), num_or_zero(p.get("assists")), num_or_zero(p.get("saves")))).size(10.0).color(c::DIM));
                        });
                    });
                });
            });
        }
    });
}

/// crypto.randomUUID(): 8-4-4-4-12 lowercase hex, version 4.
pub fn random_uuid() -> String {
    let mut b = [0u8; 16];
    getrandom(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// crypto.randomUUID().replaceAll('-', '') -> 32 hex chars.
pub fn random_key() -> String {
    let mut b = [0u8; 16];
    getrandom(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn getrandom(buf: &mut [u8]) {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    for (i, chunk) in buf.chunks_mut(8).enumerate() {
        let mut h = RandomState::new().build_hasher();
        h.write_usize(i);
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        let v = h.finish().to_le_bytes();
        chunk.copy_from_slice(&v[..chunk.len()]);
    }
}

fn overwatch_bans(app: &mut App, ui: &mut egui::Ui, game: &Value, cfg: &Value) {
    let active = num_or_zero(game.get("activeMap")) as usize;
    let row = game["mapRows"].get(active).cloned().unwrap_or(json!({}));
    let bans = row.get("heroBans").cloned().unwrap_or(json!({}));
    panel(ui, |ui| {
        let t = format!("Hero bans · Map {}{}", active + 1, if truthy(row.get("map")) { format!(" · {}", s(row.get("map"))) } else { String::new() });
        heading(ui, "", &t, "Shown next to each team's logo on the scoreboard; each map keeps its own bans", |ui| {
            if ui.add_enabled(truthy(bans.get("home")) || truthy(bans.get("away")), secondary_button("CLEAR BANS")).clicked() {
                app.commit("Hero bans cleared", |st| {
                    let g = &mut st["games"]["overwatch"];
                    let a = num_or_zero(g.get("activeMap")) as usize;
                    if let Some(r) = g["mapRows"].get_mut(a) {
                        r["heroBans"] = json!({ "home": "", "away": "" });
                    }
                });
            }
        });
        let mut options: Vec<(String, String)> = vec![(String::new(), "No ban".into())];
        options.extend(cfg["characters"].as_array().into_iter().flatten().filter_map(Value::as_str).map(|h| (h.to_string(), h.to_string())));
        cols(ui, &[-1.0, -1.0], 14.0, |i, ui| {
            let side = if i == 0 { "home" } else { "away" };
            let hero = s(bans.get(side));
            let short = { let x = s(game.pointer(&format!("/teams/{i}/shortName"))); if x.is_empty() { side.to_uppercase() } else { x } };
            if let Some(pick) = select(ui, &format!("ban-{side}"), &format!("{short} ban"), &hero, &options) {
                let msg = if pick.is_empty() { format!("{} ban cleared", if side == "home" { "Home" } else { "Away" }) } else { format!("{} ban: {pick}", if side == "home" { "Home" } else { "Away" }) };
                app.commit(&msg, |st| {
                    let g = &mut st["games"]["overwatch"];
                    let a = num_or_zero(g.get("activeMap")) as usize;
                    if let Some(r) = g["mapRows"].get_mut(a) {
                        if !r["heroBans"].is_object() {
                            r["heroBans"] = json!({});
                        }
                        r["heroBans"][side] = json!(pick);
                    }
                });
            }
        });
    });
}
