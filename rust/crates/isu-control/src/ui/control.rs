//! Match Control view (app.js renderControl, renderTeamControl, renderRocketLeaguePanel,
//! renderOverwatchBans; field / formatSelect).
use eframe::egui::{self, Color32, RichText};
use isu_core::controls::{series_length, series_target, visible_rows};
use isu_core::game_config::{config, js_string, num_or_zero, truthy};
use serde_json::{Value, json};

use super::widgets::{color_field, panel, text_field, title};
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
    ui.horizontal(|ui| {
        title(ui, "01", "Live scoreboard", "Primary match data");
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            let b = egui::Button::new(RichText::new(if live { "● Take off air" } else { "● Take live" }).strong()).fill(if live { c::RED } else { c::PANEL_LIGHT });
            if ui.add(b).clicked() {
                app.control("toggle-live", 0, None);
            }
        });
    });
    panel(ui, |ui| {
        ui.vertical_centered(|ui| {
            ui.label(RichText::new(format!("{}   ·   {}   ·   {}", s(game.pointer("/match/event")), s(game.pointer("/match/round")), s(game.pointer("/match/format")))).small().color(c::MUTED));
            ui.horizontal(|ui| {
                let w = ui.available_width();
                ui.add_space((w - 620.0).max(0.0) / 2.0);
                preview_team(ui, &game["teams"][0], "HOME");
                ui.vertical(|ui| {
                    ui.set_width(180.0);
                    ui.vertical_centered(|ui| {
                        ui.label(RichText::new(s(cfg.get("scoreLabel"))).small().color(c::MUTED));
                        ui.label(RichText::new(format!("{} — {}", s(game.pointer("/teams/0/score")), s(game.pointer("/teams/1/score")))).size(40.0).strong().color(c::TEXT));
                        ui.label(RichText::new(if live { "LIVE" } else { "PREVIEW" }).small().color(if live { c::RED } else { c::MUTED }));
                    });
                });
                preview_team(ui, &game["teams"][1], "AWAY");
            });
            let map_name = if key == "rocketleague" && rl_live.is_some_and(|l| truthy(l.get("arena"))) { isu_core::game_config::rocket_league_arena_name(&s(rl_live.unwrap().get("arena"))) } else { s(row.get("map")) };
            let mode = if key == "rocketleague" && rl_live.is_some() { game_clock(rl_live.unwrap().get("timeSeconds"), truthy(rl_live.unwrap().get("overtime"))) } else { s(row.get("mode")) };
            ui.label(RichText::new(format!("{unit} {}   {map_name}   {mode}", active + 1)).color(c::TEXT));
        });
    });
    ui.add_space(10.0);

    // team controls + middle buttons
    ui.columns(3, |cols| {
        team_control(app, &mut cols[0], game, 0, &key);
        let ui = &mut cols[1];
        ui.vertical_centered(|ui| {
            ui.add_space(30.0);
            if ui.add(egui::Button::new(RichText::new("⇄ SWAP SIDES").strong()).min_size(egui::vec2(180.0, 34.0))).on_hover_text("Swap team sides").clicked() {
                app.control("swap-teams", 0, None);
            }
            ui.add_space(8.0);
            if app.confirm_button(ui, "reset-scores", "RESET SCORES", "Click again to reset scores") {
                app.control("reset-scores", 0, None);
            }
            ui.add_space(8.0);
            let nb = egui::Button::new(RichText::new(format!("NEXT MATCH\nTO {unit} {}", next + 1)).strong().color(Color32::BLACK)).fill(c::ORANGE).min_size(egui::vec2(180.0, 48.0));
            if ui.add(nb).clicked() {
                app.control("next-match", 0, None);
            }
        });
        team_control(app, &mut cols[2], game, 1, &key);
    });
    ui.add_space(10.0);

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

    // 02 Match details + detail score
    ui.columns(2, |cols| {
        panel(&mut cols[0], |ui| {
            title(ui, "02", "Match details", "Information shared across graphics");
            ui.horizontal_wrapped(|ui| {
                if let Some(v) = text_field(ui, "match.event", "Event / league", &s(game.pointer("/match/event")), 60, 200.0) {
                    app.commit("Changes saved", |st| st["games"][key.as_str()]["match"]["event"] = json!(v));
                }
                if let Some(v) = text_field(ui, "match.round", "Round / stage", &s(game.pointer("/match/round")), 60, 200.0) {
                    app.commit("Changes saved", |st| st["games"][key.as_str()]["match"]["round"] = json!(v));
                }
                if let Some(opts) = cfg["formatOptions"].as_array().filter(|a| !a.is_empty()) {
                    ui.vertical(|ui| {
                        ui.label(RichText::new("Series format").small().color(c::MUTED));
                        let mut pick = length;
                        egui::ComboBox::from_id_salt("format").selected_text(format!("Best of {length}")).show_ui(ui, |ui| {
                            for o in opts.iter().filter_map(Value::as_f64) {
                                ui.selectable_value(&mut pick, o, format!("Best of {o}"));
                            }
                        });
                        ui.label(RichText::new(format!("First to {}", series_target(game, &key))).small().color(c::MUTED));
                        if pick != length {
                            app.commit(&format!("Format set to Best of {pick}"), |st| isu_core::controls::sync_format(st, pick));
                        }
                    });
                } else if let Some(v) = text_field(ui, "match.format", "Series format", &s(game.pointer("/match/format")), 60, 160.0) {
                    app.commit("Changes saved", |st| st["games"][key.as_str()]["match"]["format"] = json!(v));
                }
                ui.vertical(|ui| {
                    ui.label(RichText::new("Active map").small().color(c::MUTED));
                    let mut pick = active;
                    let rows = game["mapRows"].as_array().cloned().unwrap_or_default();
                    let label = |i: usize| format!("{} — {}", i + 1, { let m = s(rows.get(i).and_then(|r| r.get("map"))); if m.is_empty() { "TBD".into() } else { m } });
                    egui::ComboBox::from_id_salt("activeMap").selected_text(label(active)).show_ui(ui, |ui| {
                        for i in 0..visible_rows(game, &key) {
                            ui.selectable_value(&mut pick, i, label(i));
                        }
                    });
                    if pick != active {
                        app.commit("Changes saved", |st| st["games"][key.as_str()]["activeMap"] = json!(pick));
                    }
                });
            });
        });
        panel(&mut cols[1], |ui| {
            let label = match key.as_str() { "valorant" => "CURRENT ROUND SCORE", "rocketleague" => "CURRENT GAME GOALS", "smash" => "CURRENT STOCKS", _ => "LIVE MAP SCORE" };
            title(ui, "", label, "Optional in-game value");
            ui.horizontal(|ui| {
                for i in 0..2 {
                    ui.label(RichText::new(s(game.pointer(&format!("/teams/{i}/shortName")))).color(c::MUTED));
                    if ui.button("−").clicked() {
                        app.control("detail-minus", i, None);
                    }
                    ui.label(RichText::new(s(game.pointer(&format!("/teams/{i}/detailScore")))).size(22.0).strong());
                    if ui.button("+").clicked() {
                        app.control("detail-plus", i, None);
                    }
                    ui.add_space(24.0);
                }
            });
        });
    });
}

fn preview_team(ui: &mut egui::Ui, team: &Value, side: &str) {
    ui.vertical(|ui| {
        ui.set_width(220.0);
        ui.horizontal(|ui| {
            let (r, _) = ui.allocate_exact_size(egui::vec2(44.0, 44.0), egui::Sense::hover());
            ui.painter().rect_filled(r, 6.0, hex(&s(team.get("color"))));
            let short: String = s(team.get("shortName")).chars().take(3).collect();
            ui.painter().text(r.center(), egui::Align2::CENTER_CENTER, short, egui::FontId::proportional(14.0), Color32::WHITE);
            ui.vertical(|ui| {
                ui.label(RichText::new(side).small().color(c::MUTED));
                ui.label(RichText::new(s(team.get("name"))).strong().color(c::TEXT));
            });
        });
    });
}

fn team_control(app: &mut App, ui: &mut egui::Ui, game: &Value, i: usize, key: &str) {
    let team = &game["teams"][i];
    let target = series_target(game, key);
    panel(ui, |ui| {
        ui.label(RichText::new(if i == 0 { "HOME TEAM" } else { "AWAY TEAM" }).small().strong().color(hex(&s(team.get("color")))));
        ui.horizontal_wrapped(|ui| {
            let k = key.to_string();
            if let Some(v) = text_field(ui, &format!("t{i}name"), "DISPLAY NAME", &s(team.get("name")), 32, 150.0) {
                app.commit("Changes saved", |st| st["games"][k.as_str()]["teams"][i]["name"] = json!(v));
            }
            if let Some(v) = text_field(ui, &format!("t{i}short"), "ABBR.", &s(team.get("shortName")), 5, 50.0) {
                app.commit("Changes saved", |st| st["games"][k.as_str()]["teams"][i]["shortName"] = json!(v));
            }
            if let Some(v) = color_field(ui, "PRIMARY", &s(team.get("color")), true) {
                app.commit("Changes saved", |st| st["games"][k.as_str()]["teams"][i]["color"] = json!(v));
            }
            let sec_on = truthy(team.get("secondaryColorEnabled"));
            if let Some(v) = color_field(ui, "SECONDARY", &s(team.get("secondaryColor")), sec_on) {
                app.commit("Changes saved", |st| st["games"][k.as_str()]["teams"][i]["secondaryColor"] = json!(v));
            }
            let mut on = sec_on;
            if ui.checkbox(&mut on, "USE").changed() {
                app.commit("Changes saved", |st| st["games"][k.as_str()]["teams"][i]["secondaryColorEnabled"] = json!(on));
            }
        });
        ui.horizontal(|ui| {
            let logo = s(team.get("logoImage"));
            let name = s(team.get("logoImageName"));
            ui.label(RichText::new(if !name.is_empty() { name } else if !logo.is_empty() { "Custom URL".into() } else { "No logo selected".into() }).small().color(c::MUTED));
            if ui.button(if logo.is_empty() { "CHOOSE FILE" } else { "REPLACE FILE" }).clicked() {
                if let Some((n, url)) = super::roster::pick_image(app, "Choose team logo image") {
                    let k = key.to_string();
                    app.commit("Team logo saved", |st| {
                        st["games"][k.as_str()]["teams"][i]["logoImage"] = json!(url);
                        st["games"][k.as_str()]["teams"][i]["logoImageName"] = json!(n);
                    });
                }
            }
            if !logo.is_empty() && ui.button("CLEAR").clicked() {
                let k = key.to_string();
                app.commit("Team logo cleared", |st| {
                    st["games"][k.as_str()]["teams"][i]["logoImage"] = json!("");
                    st["games"][k.as_str()]["teams"][i]["logoImageName"] = json!("");
                });
            }
        });
        let k = key.to_string();
        if let Some(v) = text_field(ui, &format!("t{i}logo"), "LOGO URL", &s(team.get("logoImage")), 2000, ui.available_width() - 10.0) {
            app.commit("Changes saved", |st| {
                st["games"][k.as_str()]["teams"][i]["logoImageName"] = json!(if v.is_empty() { "" } else { "Custom URL" });
                st["games"][k.as_str()]["teams"][i]["logoImage"] = json!(v);
            });
        }
        ui.add_space(8.0);
        ui.horizontal(|ui| {
            if ui.add(egui::Button::new(RichText::new("−").size(22.0)).min_size(egui::vec2(48.0, 48.0))).clicked() {
                app.control("score-minus", i, None);
            }
            ui.vertical(|ui| {
                ui.label(RichText::new(s(config(key).unwrap().get("scoreLabel"))).small().color(c::MUTED));
                ui.label(RichText::new(s(team.get("score"))).size(34.0).strong().color(c::TEXT));
                ui.label(RichText::new(format!("of {target}")).small().color(c::MUTED));
            });
            if ui.add(egui::Button::new(RichText::new("+").size(22.0).color(Color32::BLACK)).fill(c::ORANGE).min_size(egui::vec2(48.0, 48.0))).clicked() {
                app.control("score-plus", i, None);
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

fn rocket_league_panel(app: &mut App, ui: &mut egui::Ui, game: &Value) {
    let rl = &game["rocketLeague"];
    let live = &rl["live"];
    panel(ui, |ui| {
        ui.horizontal(|ui| {
            ui.vertical(|ui| {
                ui.label(RichText::new("ROCKET LEAGUE STATS API").small().color(c::ORANGE));
                ui.label(RichText::new("Live game connection").strong().size(16.0));
                ui.label(RichText::new("Official game telemetry · no BakkesMod required").small().color(c::MUTED));
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.vertical(|ui| {
                    ui.label(RichText::new(s(live.get("status")).to_uppercase()).strong());
                    ui.label(RichText::new(s(live.get("message"))).small().color(c::MUTED));
                });
            });
        });
        ui.horizontal_wrapped(|ui| {
            let mut en = truthy(rl.get("enabled"));
            let label = format!("LIVE DATA ({})", if en { "Enabled" } else { "Disabled" });
            if ui.checkbox(&mut en, RichText::new(label).strong()).changed() {
                rl_set(app, "enabled", json!(en));
            }
            let src = s(rl.get("source"));
            let mut pick = src.clone();
            egui::ComboBox::from_label("DATA SOURCE").selected_text(if src == "remote" { "Game PC bridge" } else { "This PC / direct" }).show_ui(ui, |ui| {
                ui.selectable_value(&mut pick, "local".to_string(), "This PC / direct");
                ui.selectable_value(&mut pick, "remote".to_string(), "Game PC bridge");
            });
            if pick != src {
                rl_set(app, "source", json!(pick));
            }
            let interval = s(rl.get("updateIntervalMs"));
            if let Some(v) = text_field(ui, "rl-interval", "BOOST UPDATE INTERVAL (1–50 ms)", &interval, 3, 60.0) {
                rl_set(app, "updateIntervalMs", json!(isu_core::game_config::js_number(&v).unwrap_or(f64::NAN)));
            }
            if src == "remote" {
                if let Some(v) = text_field(ui, "rl-bport", "RECEIVER PORT", &s(rl.get("bridgePort")), 5, 70.0) {
                    rl_set(app, "bridgePort", json!(isu_core::game_config::js_number(&v).unwrap_or(f64::NAN)));
                }
                if let Some(v) = text_field(ui, "rl-token", "BRIDGE KEY", &s(rl.get("bridgeToken")), 128, 260.0) {
                    rl_set(app, "bridgeToken", json!(v));
                }
                if ui.button("GENERATE").clicked() {
                    let k = random_key();
                    app.commit("Private bridge key generated", |st| st["games"]["rocketleague"]["rocketLeague"]["bridgeToken"] = json!(k));
                    app.svc.sync_rl();
                }
                ui.label(RichText::new(format!("Graphics PC: {}", if app.addresses.is_empty() { "address unavailable".into() } else { app.addresses.join(" / ") })).small().color(c::MUTED));
            } else {
                let tr = s(rl.get("transport"));
                let mut pick = tr.clone();
                egui::ComboBox::from_label("TRANSPORT").selected_text(match tr.as_str() { "websocket" => "WebSocket · 49124", "tcp" => "TCP · 49123", _ => "Automatic (WebSocket → TCP)" }).show_ui(ui, |ui| {
                    ui.selectable_value(&mut pick, "auto".to_string(), "Automatic (WebSocket → TCP)");
                    ui.selectable_value(&mut pick, "websocket".to_string(), "WebSocket · 49124");
                    ui.selectable_value(&mut pick, "tcp".to_string(), "TCP · 49123");
                });
                if pick != tr {
                    rl_set(app, "transport", json!(pick));
                }
                if let Some(v) = text_field(ui, "rl-host", "ROCKET LEAGUE HOST", &s(rl.get("host")), 255, 130.0) {
                    rl_set(app, "host", json!(v));
                }
                if let Some(v) = text_field(ui, "rl-tcp", "TCP PORT", &s(rl.get("tcpPort")), 5, 60.0) {
                    rl_set(app, "tcpPort", json!(isu_core::game_config::js_number(&v).unwrap_or(f64::NAN)));
                }
                if let Some(v) = text_field(ui, "rl-ws", "WEBSOCKET PORT", &s(rl.get("webPort")), 5, 60.0) {
                    rl_set(app, "webPort", json!(isu_core::game_config::js_number(&v).unwrap_or(f64::NAN)));
                }
            }
        });
        ui.horizontal(|ui| {
            if ui.button("COPY GAME CONFIG").clicked() {
                // copy-rl-config: TAGame.MatchStatsExporter_TA block for the game's ini
                let ms = num_or_zero(rl.get("updateIntervalMs"));
                let rate = (1000.0 / (if ms == 0.0 { 33.0 } else { ms }).max(1.0)).round().clamp(1.0, 120.0);
                ui.ctx().copy_text(format!("[TAGame.MatchStatsExporter_TA]\nPacketSendRate={rate}\nPort={}\nWebPort={}", s(rl.get("tcpPort")), s(rl.get("webPort"))));
                app.toast("Rocket League configuration copied");
            }
            let simulating = live.get("status").and_then(Value::as_str) == Some("simulating");
            if ui.button(if simulating { "STOP TEST FEED" } else { "RUN TEST FEED" }).clicked() {
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
            let packets = s(live.get("packets"));
            ui.label(RichText::new(format!("{} · {} PACKETS · {:.1} PKT/S", if truthy(live.get("lastPacketAt")) { format!("LAST PACKET {}", s(live.get("lastPacketAt"))) } else { "NO MATCH DATA RECEIVED".into() }, if packets.is_empty() { "0".into() } else { packets }, num_or_zero(live.get("packetRate")))).small().color(c::MUTED));
        });
        ui.horizontal(|ui| {
            for (l, v) in [("GAME CLOCK", game_clock(live.get("timeSeconds"), truthy(live.get("overtime")))), ("ARENA", { let a = s(live.get("arena")); if a.is_empty() { "WAITING FOR MATCH".into() } else { a } }), ("MATCH ID", { let g = s(live.get("matchGuid")); if g.is_empty() { "-".into() } else { g.chars().take(14).collect() } }), ("SPECTATING", { let p = s(live.get("spectatedPlayer")); if p.is_empty() { "-".into() } else { p } })] {
                ui.vertical(|ui| {
                    ui.set_width(170.0);
                    ui.label(RichText::new(l).small().color(c::MUTED));
                    ui.label(RichText::new(v).strong());
                });
            }
        });
        ui.horizontal_wrapped(|ui| {
            let blue = num_or_zero(rl.get("blueTeam")) as i64;
            let mut pick = blue;
            egui::ComboBox::from_label("BLUE TEAM IS").selected_text(format!("{} · {}", if blue == 0 { "Home" } else { "Away" }, s(game.pointer(&format!("/teams/{}/shortName", blue.clamp(0, 1)))))).show_ui(ui, |ui| {
                ui.selectable_value(&mut pick, 0, format!("Home · {}", s(game.pointer("/teams/0/shortName"))));
                ui.selectable_value(&mut pick, 1, format!("Away · {}", s(game.pointer("/teams/1/shortName"))));
            });
            if pick != blue {
                rl_set(app, "blueTeam", json!(pick));
            }
            for (p, l) in [("syncGoals", "Game goals"), ("syncClock", "Clock & overtime"), ("syncPlayers", "Players & boost"), ("autoRoster", "Auto roster & cars"), ("autoSeriesScore", "Series score"), ("autoAdvance", "Advance next game")] {
                let mut on = truthy(rl.get(p));
                if ui.checkbox(&mut on, l).changed() {
                    rl_set(app, p, json!(on));
                }
            }
            let mut hs = rl.get("statCardHeadshot") != Some(&json!(false));
            if ui.checkbox(&mut hs, "Show headshot (off = team logo only)").changed() {
                rl_set(app, "statCardHeadshot", json!(hs));
            }
        });
        let players = live["players"].as_array().cloned().unwrap_or_default();
        if players.is_empty() {
            ui.label(RichText::new("Players and boost meters appear here when the spectator enters a match.").color(c::MUTED));
        }
        ui.horizontal_wrapped(|ui| {
            for p in &players {
                let ti = isu_core::rocket_league::map_team(p.get("teamNum"), rl);
                let team = game["teams"].get(ti.max(0.0) as usize).cloned().unwrap_or(json!({}));
                egui::Frame::NONE.fill(c::PANEL_LIGHT).corner_radius(6.0).inner_margin(8.0).show(ui, |ui| {
                    ui.set_width(180.0);
                    ui.horizontal(|ui| {
                        ui.label(RichText::new(s(team.get("shortName"))).small().color(hex(&s(team.get("color")))));
                        ui.label(RichText::new(s(p.get("name"))).strong());
                        if truthy(p.get("spectated")) {
                            ui.label(RichText::new("ON CAMERA").small().color(c::ORANGE));
                        }
                    });
                    let boost = p.get("boost").and_then(Value::as_f64).map(|b| b.clamp(0.0, 100.0));
                    ui.add(egui::ProgressBar::new(boost.unwrap_or(0.0) as f32 / 100.0).fill(hex(&s(team.get("color")))).text(boost.map_or("—".into(), |b| format!("{} BOOST", b.round()))));
                    ui.label(RichText::new(format!("{} G · {} A · {} S", num_or_zero(p.get("goals")), num_or_zero(p.get("assists")), num_or_zero(p.get("saves")))).small().color(c::MUTED));
                });
            }
        });
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
        ui.horizontal(|ui| {
            title(ui, "", &format!("Hero bans · Map {}{}", active + 1, if truthy(row.get("map")) { format!(" · {}", s(row.get("map"))) } else { String::new() }), "Shown next to each team's logo on the scoreboard; each map keeps its own bans");
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.add_enabled(truthy(bans.get("home")) || truthy(bans.get("away")), egui::Button::new("CLEAR BANS")).clicked() {
                    app.commit("Hero bans cleared", |st| {
                        let g = &mut st["games"]["overwatch"];
                        let a = num_or_zero(g.get("activeMap")) as usize;
                        if let Some(r) = g["mapRows"].get_mut(a) {
                            r["heroBans"] = json!({ "home": "", "away": "" });
                        }
                    });
                }
            });
        });
        ui.horizontal(|ui| {
            for (side, i) in [("home", 0), ("away", 1)] {
                let hero = s(bans.get(side));
                let mut pick = hero.clone();
                let short = { let x = s(game.pointer(&format!("/teams/{i}/shortName"))); if x.is_empty() { side.to_uppercase() } else { x } };
                egui::ComboBox::from_label(format!("{short} BAN")).selected_text(if hero.is_empty() { "No ban".into() } else { hero.clone() }).show_ui(ui, |ui| {
                    ui.selectable_value(&mut pick, String::new(), "No ban");
                    for h in cfg["characters"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                        ui.selectable_value(&mut pick, h.to_string(), h);
                    }
                });
                if pick != hero {
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
            }
        });
    });
}
