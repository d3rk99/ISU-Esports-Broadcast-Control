//! Scoreboard reader panels on Match Control: src/valorant-board-panel.js renderValorantBoardPanel
//! (+ the vb-* / data-val-round / data-val-stat-cards handlers of app.js) and the Overwatch one
//! (src/overwatch-ocr-panel.js renderOverwatchOcrPanel + ow-ocr-* handlers).
use eframe::egui::{self, Color32, RichText};
use isu_core::boards::{attacking_team_now, current_round};
use isu_core::game_config::{js_string, num_or_zero, truthy};
use serde_json::{Value, json};

use super::widgets::{panel, text_field, title};
use super::{App, c};

fn s(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        x => js_string(x),
    }
}

/// v(x): blank marker for null / undefined / ''.
fn v(x: Option<&Value>) -> String {
    match x {
        None | Some(Value::Null) => "·".into(),
        Some(Value::String(t)) if t.is_empty() => "·".into(),
        y => js_string(y),
    }
}

fn shield(x: &str) -> &'static str {
    match x { "light" => "LIGHT", "heavy" => "HEAVY", "regen" => "REGEN", "none" => "—", _ => "" }
}

/// credits.toLocaleString('en-US').
fn thousands(n: f64) -> String {
    let i = n.round() as i64;
    let s = i.abs().to_string();
    let mut o = String::new();
    for (k, ch) in s.chars().enumerate() {
        if k > 0 && (s.len() - k) % 3 == 0 {
            o.push(',');
        }
        o.push(ch);
    }
    if i < 0 { format!("-{o}") } else { o }
}

fn status_line(ui: &mut egui::Ui, status: &Value) {
    let st = { let x = s(status.get("state")); if x.is_empty() { "disabled".into() } else { x } };
    let tone = match st.as_str() { "reading" => Color32::from_rgb(80, 200, 120), "error" => c::RED, "no-board" => c::ORANGE, _ => c::MUTED };
    let sweep = num_or_zero(status.get("sweepMs"));
    ui.label(RichText::new(format!("{} · {}{}", st.to_uppercase(), { let m = s(status.get("message")); if m.is_empty() { "off".into() } else { m } }, if sweep > 0.0 { format!(" · {sweep} ms per read") } else { String::new() })).color(tone));
}

pub fn valorant(app: &mut App, ui: &mut egui::Ui, st: &Value) {
    let game = &st["games"]["valorant"];
    let teams = game["teams"].as_array().cloned().unwrap_or_default();
    let vb = app.svc.core.lock().valorant_board.clone();
    let settings = app.svc.core.files.merged("valorant-board-settings.json", |v| isu_ocr::service::settings_json(&isu_ocr::service::normalize_settings(v)));
    let round = current_round(game);
    let attacking = attacking_team_now(game);
    let active = num_or_zero(game.get("activeMap")) as i64;
    let override_v = game.pointer(&format!("/valorantRoundOverride/{active}")).filter(|x| truthy(Some(x))).map(|x| s(Some(x))).unwrap_or_default();
    let read = game.pointer("/valorantBoard/live/match");
    let scored = read.is_some_and(|m| m["homeScore"].is_number() && m["awayScore"].is_number());
    let source = if !override_v.is_empty() { "MANUAL OVERRIDE" } else if scored { "FROM READER SCORE" } else { "FROM CURRENT ROUND SCORE" };
    let side_name = |side: &str| teams.get(if side == "home" { 0 } else { 1 }).map(|t| s(t.get("name"))).filter(|n| !n.is_empty()).unwrap_or_else(|| side.to_string());
    let tags = |r: &Value| -> Vec<String> { ["varsity", "jv"].iter().flat_map(|k| r.get(*k).and_then(Value::as_array).cloned().unwrap_or_default()).map(|p| s(p.get("handle")).trim().to_string()).filter(|t| !t.is_empty()).collect() };
    let away: Vec<String> = tags(&game["awayRosters"]).iter().map(|t| t.to_lowercase()).collect();
    let mut dups: Vec<String> = Vec::new();
    for t in tags(&game["rosters"]) {
        if away.contains(&t.to_lowercase()) && !dups.contains(&t) {
            dups.push(t);
        }
    }
    panel(ui, |ui| {
        title(ui, "OCR", "VALORANT scoreboard reader", "Observer 3 keeps Tab open. The board is found by itself (it follows the window moving), then every cell is read. A value only shows after it reads the same twice, and a number stays blank instead of guessing.");
        let mut cfg: Option<(Value, String)> = None;
        ui.horizontal_wrapped(|ui| {
            let mut cards = game.get("valorantShowStatCards") != Some(&json!(false));
            if ui.checkbox(&mut cards, "PLAYER STAT CARDS (bottom-left / bottom-right cards on the scoreboard overlay)").changed() {
                app.commit(if cards { "VALORANT stat cards on" } else { "VALORANT stat cards off" }, |st| st["games"]["valorant"]["valorantShowStatCards"] = json!(cards));
            }
            let mut en = settings["enabled"] == true;
            if ui.checkbox(&mut en, "READ SCOREBOARD (off by default; turn on when Observer 3 is on the board)").changed() {
                cfg = Some((json!({ "enabled": en }), if en { "VALORANT scoreboard reader on" } else { "VALORANT scoreboard reader off" }.into()));
            }
            if let Some(x) = text_field(ui, "vbwin", "WINDOW TITLE CONTAINS", &{ let w = s(settings.get("windowName")); if w.is_empty() { "VALORANT".into() } else { w } }, 200, 140.0) {
                cfg = Some((json!({ "windowName": x.trim() }), "VALORANT reader settings saved".into()));
            }
            for (k, l, d, w) in [("intervalMs", "READ EVERY (MS)", 500.0, 70.0), ("workers", "CPU CORES (OCR WORKERS)", 4.0, 50.0)] {
                let cur = { let n = num_or_zero(settings.get(k)); if n == 0.0 { d } else { n } };
                if let Some(x) = text_field(ui, &format!("vb{k}"), l, &cur.to_string(), 5, w) {
                    cfg = Some((json!({ k: isu_core::game_config::js_number(x.trim()).unwrap_or(f64::NAN) }), "VALORANT reader settings saved".into()));
                }
            }
            if ui.button("TEST READ").clicked() {
                if let Some(b) = app.svc.board.clone() {
                    let tx = app.toast_tx.clone();
                    let core = std::sync::Arc::clone(&app.svc.core);
                    std::thread::spawn(move || match b.sweep() {
                        Ok(_) => { core.valorant_board_snapshot(&b.snapshot()); let _ = tx.send("Read the VALORANT scoreboard once".into()); }
                        Err(e) => { let _ = tx.send(format!("Test read failed: {e}")); }
                    });
                } else {
                    app.toast("Test read failed: the OCR models are not installed");
                }
            }
            if app.confirm_button(ui, "vb-clear", "CLEAR", "Clear?") {
                if let Some(b) = &app.svc.board {
                    b.clear();
                    app.svc.core.valorant_board_snapshot(&b.snapshot());
                }
                app.toast("VALORANT board cleared");
            }
        });
        if let Some((n, msg)) = cfg {
            if let Some(b) = &app.svc.board {
                let saved = app.svc.core.files.save_merged("valorant-board-settings.json", &n, |v| isu_ocr::service::settings_json(&isu_ocr::service::normalize_settings(v)));
                let _g = app.svc.rt.enter();
                b.configure(&saved);
            }
            app.toast(&msg);
        }
        if let Some(m) = vb.pointer("/live/match").filter(|m| truthy(Some(m))) {
            let score = if m["homeScore"].is_number() && m["awayScore"].is_number() { format!("{} – {}", s(m.get("homeScore")), s(m.get("awayScore"))) } else { "–".into() };
            let timer = if truthy(m.get("spikePlanted")) { "SPIKE PLANTED".into() } else { let t = s(m.pointer("/timer/display")); if t.is_empty() { "–".into() } else { t } };
            ui.label(RichText::new(format!("ROUND SCORE {score} · TIMER {timer}")).strong());
            ui.label(RichText::new("Read from the top of the screen; the round score fills in the match score (never goes backwards).").small().color(c::MUTED));
        }
        ui.horizontal_wrapped(|ui| {
            if let Some(x) = text_field(ui, "valround", "CURRENT ROUND OVERRIDE (blank = auto from round score)", &override_v, 3, 60.0) {
                let val = if x.trim().is_empty() { None } else { isu_core::game_config::js_number(x.trim()) };
                if !x.trim().is_empty() && !val.is_some_and(|n| n == n.trunc() && (1.0..=100.0).contains(&n)) {
                    app.toast("Enter a round from 1 to 100, or clear for automatic");
                } else {
                    let msg = val.map_or("Current round follows the score".to_string(), |n| format!("Current round set to {n}"));
                    app.commit(&msg, |st| {
                        let g = &mut st["games"]["valorant"];
                        let a = num_or_zero(g.get("activeMap")) as i64;
                        if !g["valorantRoundOverride"].is_object() { g["valorantRoundOverride"] = json!({}); }
                        g["valorantRoundOverride"][a.to_string()] = val.map_or(Value::Null, isu_core::game_config::jnum);
                    });
                }
            }
            ui.vertical(|ui| {
                ui.label(RichText::new(format!("ROUND {round} · {source}")).strong());
                let who = if attacking.is_empty() { "Set the first attacking team in Map Pool.".to_string() } else { format!("{} ATTACKING (RED) · {} DEFENDING (TEAL)", side_name(attacking), side_name(if attacking == "home" { "away" } else { "home" })) };
                ui.label(RichText::new(format!("{who} · First 12 rounds use Map Pool; rounds 13–24 reverse it; overtime alternates.")).small().color(c::MUTED));
                if override_v.is_empty() && round == 1.0 {
                    ui.label(RichText::new("Joining a replay mid-map? Set the current round above if the score is unreadable or still 0–0.").small().color(c::MUTED));
                }
            });
        });
        if !dups.is_empty() {
            ui.label(RichText::new(format!("ROSTER CONFLICT: {}", dups.join(", "))).strong().color(c::RED));
            ui.label(RichText::new("These gamertags are assigned to both teams. Load the correct Home and Away teams in Roster Manager. The bridge uses the mapped reader block to disambiguate names it can read.").small().color(c::MUTED));
        }
        if let Some(d) = vb.get("decision").filter(|d| truthy(Some(d))) {
            let by = match d["by"].as_str().unwrap_or("") { "names" => "ROSTER GAMERTAGS", "sides" => "MAP POOL ATTACKING SIDE", "kept" => "LAST DECISION", "default" => "DEFAULT (nothing to go on yet)", x => x };
            ui.label(RichText::new(format!("TEAMS ON THE BOARD: top = {} · decided by {by}", { let t = s(d.get("top")); if t.is_empty() { "home".into() } else { t } }.to_uppercase())).strong());
            ui.label(RichText::new(format!("{} · Players are followed by gamertag when VALORANT re-sorts the board.", s(d.get("detail")))).small().color(c::MUTED));
        }
        status_line(ui, &vb["status"]);
        for side in ["home", "away"] {
            let players = vb.pointer(&format!("/live/teams/{side}/players")).and_then(Value::as_array).cloned().unwrap_or_default();
            let dec = vb.get("decision").and_then(|d| d.get("top")).and_then(Value::as_str);
            let team_side = dec.map(|t| if side == "home" { t.to_string() } else if t == "home" { "away".into() } else { "home".into() }).unwrap_or_default();
            let team_name = if team_side.is_empty() { String::new() } else { teams.get(if team_side == "home" { 0 } else { 1 }).map(|t| s(t.get("name"))).unwrap_or_default() };
            let color = s(vb.pointer(&format!("/live/colors/{side}")));
            ui.add_space(6.0);
            ui.label(RichText::new(format!("{} BLOCK · {}{}{}", if side == "home" { "TOP" } else { "BOTTOM" }, if team_name.is_empty() { "?".into() } else { team_name }, if team_side.is_empty() { String::new() } else { format!(" ({})", team_side.to_uppercase()) }, if color.is_empty() { String::new() } else if color == "red" { " · ATTACKING".into() } else { " · DEFENDING".into() })).strong());
            let mut rows: Vec<(usize, Value)> = players.into_iter().enumerate().collect();
            rows.sort_by(|a, b| a.1.get("row").and_then(Value::as_f64).unwrap_or(a.0 as f64).partial_cmp(&b.1.get("row").and_then(Value::as_f64).unwrap_or(b.0 as f64)).unwrap_or(std::cmp::Ordering::Equal));
            egui::Grid::new(format!("vb{side}")).striped(true).num_columns(10).show(ui, |ui| {
                for h in ["AGENT", "NAME", "ULT", "K", "D", "A", "GUN", "SHIELD", "CREDS", "PING"] {
                    ui.label(RichText::new(h).small().color(c::MUTED));
                }
                ui.end_row();
                for (slot, p) in rows {
                    ui.label(p.get("agent").filter(|a| truthy(Some(a))).map_or("·".into(), |a| s(Some(a)).to_uppercase()));
                    let manual = truthy(p.get("nameManual"));
                    if let Some(x) = text_field(ui, &format!("vbn{side}{slot}"), "", &s(p.get("name")), 32, 140.0) {
                        if let Some(b) = &app.svc.board {
                            if let Ok(_snap) = b.set_player_name(side, slot as i64, &x) {
                                app.svc.core.valorant_board_snapshot(&b.snapshot());
                            }
                        }
                    }
                    let _ = manual;
                    ui.label(v(p.get("ultimate")));
                    ui.label(v(p.get("kills")));
                    ui.label(v(p.get("deaths")));
                    ui.label(v(p.get("assists")));
                    ui.label(p.get("weapon").filter(|w| truthy(Some(w))).map_or("·".into(), |w| s(Some(w)).to_uppercase()));
                    ui.label(p.get("shield").filter(|w| truthy(Some(w))).map_or("·".into(), |w| shield(&s(Some(w))).to_string()));
                    ui.label(p.get("credits").and_then(Value::as_f64).filter(|x| x.is_finite()).map_or("·".into(), thousands));
                    ui.label(v(p.get("ping")));
                    ui.end_row();
                }
            });
        }
        ui.add_space(8.0);
        super::settings::spectate_panel(app, ui);
    });
}

/// show(value): '–' for blank, READY -> RDY.
fn show(x: Option<&Value>) -> String {
    match x {
        None | Some(Value::Null) => "–".into(),
        Some(Value::String(t)) if t.is_empty() => "–".into(),
        Some(Value::String(t)) if t == "READY" => "RDY".into(),
        y => js_string(y),
    }
}

const OW_STATS: [(&str, &str); 8] = [("hero", "HERO"), ("ultimate", "ULT"), ("elims", "E"), ("assists", "A"), ("deaths", "D"), ("damage", "DMG"), ("healing", "HEAL"), ("mitigation", "MIT")];

fn ow_norm(v: &Value) -> Value {
    isu_ocr::ow_service::settings_json(&isu_ocr::ow_service::normalize_settings(v))
}

pub fn overwatch(app: &mut App, ui: &mut egui::Ui, st: &Value) {
    let game = &st["games"]["overwatch"];
    let teams = game["teams"].as_array().cloned().unwrap_or_default();
    let ow = app.svc.core.lock().overwatch_ocr.clone();
    let settings = app.svc.core.files.merged("overwatch-ocr-settings.json", ow_norm);
    panel(ui, |ui| {
        title(ui, "OCR", "Overwatch scoreboard OCR", "Observer 3 keeps the Tab scoreboard open; stats are read from it. Map score stays manual (Companion).");
        let mut cfg: Option<(String, Value)> = None;
        ui.horizontal_wrapped(|ui| {
            let mut en = settings["enabled"] == true;
            if ui.checkbox(&mut en, "READ SCOREBOARD (off by default; turn on when Observer 3 is on the board)").changed() { cfg = Some(("enabled".into(), json!(en))); }
            let mut cards = truthy(game.get("overwatchShowStatCards"));
            if ui.checkbox(&mut cards, "PLAYER STAT CARDS (EXPERIMENTAL)").changed() {
                app.commit(if cards { "Overwatch stat cards on" } else { "Overwatch stat cards off" }, |st| st["games"]["overwatch"]["overwatchShowStatCards"] = json!(cards));
            }
            let mut auto = game.get("overwatchHeroAutofill") != Some(&json!(false));
            if ui.checkbox(&mut auto, "AUTO-FILL ROSTER FROM OCR (gamertags at ≥90%: hero + role follow the game; empty slots get filled)").changed() {
                app.commit(if auto { "Roster heroes auto-fill on" } else { "Roster heroes auto-fill off" }, |st| st["games"]["overwatch"]["overwatchHeroAutofill"] = json!(auto));
            }
            let mut align = settings.get("autoAlign") != Some(&json!(false));
            if ui.checkbox(&mut align, "AUTO-ALIGN BOXES").changed() { cfg = Some(("autoAlign".into(), json!(align))); }
            ui.vertical(|ui| {
                ui.label(RichText::new("BOARD VIEW").small().color(c::MUTED));
                let cur = { let x = s(settings.get("view")); if x.is_empty() { "auto".into() } else { x } };
                let mut pick = cur.clone();
                let opts = [("auto", "Auto-detect"), ("spectator", "Spectator (Observer)"), ("player", "Testing: in the lobby (own stat card)")];
                egui::ComboBox::from_id_salt("owview").selected_text(opts.iter().find(|o| o.0 == cur).map_or("Auto-detect", |o| o.1)).show_ui(ui, |ui| {
                    for (k, l) in opts { ui.selectable_value(&mut pick, k.to_string(), l); }
                });
                if pick != cur { cfg = Some(("view".into(), json!(pick))); }
            });
            for (k, l, d, w) in [("boxScale", "NUMBER BOX SIZE (%)", 108.0, 50.0), ("intervalMs", "READ EVERY (MS)", 500.0, 60.0), ("workers", "CPU CORES (OCR WORKERS)", 4.0, 40.0)] {
                let cur = { let n = num_or_zero(settings.get(k)); if n == 0.0 { d } else { n } };
                if let Some(x) = text_field(ui, &format!("ow{k}"), l, &cur.to_string(), 5, w) {
                    cfg = Some((k.into(), json!(isu_core::game_config::js_number(x.trim()).unwrap_or(f64::NAN))));
                }
            }
            if let Some(x) = text_field(ui, "owwin", "WINDOW TITLE CONTAINS", &{ let w = s(settings.get("windowName")); if w.is_empty() { "Overwatch".into() } else { w } }, 200, 140.0) {
                cfg = Some(("windowName".into(), json!(x.trim())));
            }
            if ui.button("TEST READ").clicked() {
                match app.svc.overwatch.clone() {
                    Some(o) => {
                        let (tx, core) = (app.toast_tx.clone(), std::sync::Arc::clone(&app.svc.core));
                        std::thread::spawn(move || match o.sweep() { Ok(_) => { core.overwatch_snapshot(&o.snapshot()); let _ = tx.send("Read the scoreboard once".into()); } Err(e) => { let _ = tx.send(format!("Test read failed: {e}")); } });
                    }
                    None => app.toast("Test read failed: the OCR models are not installed"),
                }
            }
            if app.confirm_button(ui, "ow-clear", "CLEAR", "Clear?") {
                if let Some(o) = &app.svc.overwatch {
                    o.clear();
                    app.svc.core.overwatch_snapshot(&o.snapshot());
                }
            }
        });
        if let Some((k, val)) = cfg {
            let saved = app.svc.core.files.save_merged("overwatch-ocr-settings.json", &json!({ k.as_str(): val.clone() }), ow_norm);
            if let Some(o) = &app.svc.overwatch {
                let _g = app.svc.rt.enter();
                o.configure(&saved);
            }
            let on = val == json!(true);
            app.toast(&match k.as_str() {
                "enabled" => if on { "Overwatch scoreboard OCR on".into() } else { "Overwatch scoreboard OCR off".into() },
                "autoAlign" => if on { "OCR auto-align on".into() } else { "OCR auto-align off: fixed boxes".into() },
                "view" => format!("OCR board view: {}", s(Some(&val))),
                _ => "Overwatch OCR settings saved".to_string(),
            });
        }
        let stt = &ow["status"];
        let state = { let x = s(stt.get("state")); if x.is_empty() { "disabled".into() } else { x } };
        let tone = if state == "reading" { Color32::from_rgb(80, 200, 120) } else if state == "error" || state == "no-board" { c::RED } else { c::MUTED };
        let sweep = num_or_zero(stt.get("sweepMs"));
        ui.label(RichText::new(format!("{} · {}{}", state.to_uppercase(), s(stt.get("message")), if sweep > 0.0 { format!(" · {sweep} ms per read") } else { String::new() })).color(tone));
        for (t, side) in ["home", "away"].iter().enumerate() {
            let players = ow.pointer(&format!("/live/teams/{side}/players")).and_then(Value::as_array).cloned().unwrap_or_default();
            let short = teams.get(t).map(|x| s(x.get("shortName"))).filter(|x| !x.is_empty()).unwrap_or_else(|| side.to_uppercase());
            ui.add_space(6.0);
            ui.label(RichText::new(format!("{short} · {} of the board", if t == 0 { "top" } else { "bottom" })).strong());
            egui::Grid::new(format!("ow{side}")).striped(true).num_columns(10).show(ui, |ui| {
                ui.label(RichText::new("#").small().color(c::MUTED));
                ui.label(RichText::new("PLAYER").small().color(c::MUTED));
                for (_, l) in OW_STATS { ui.label(RichText::new(l).small().color(c::MUTED)); }
                ui.end_row();
                for i in 0..5 {
                    let p = players.get(i).cloned().unwrap_or(json!({}));
                    ui.label(format!("{}", i + 1));
                    let hint = if truthy(p.get("nameManual")) { "Set by hand. Clear it to go back to OCR." } else { "Read by OCR. Type to set it by hand." };
                    let r = ui.scope(|ui| text_field(ui, &format!("own{side}{i}"), "", &s(p.get("name")), 24, 140.0)).inner;
                    if let Some(x) = r {
                        match app.svc.overwatch.clone() {
                            Some(o) => match o.set_player_name(side, i as f64, &x) {
                                Ok(_) => { app.svc.core.overwatch_snapshot(&o.snapshot()); app.toast(&if x.trim().is_empty() { "Name cleared, OCR reads it again".into() } else { format!("Name set to {} (stays until cleared)", x.trim()) }); }
                                Err(e) => app.toast(&format!("Could not set name: {e}")),
                            },
                            None => app.toast("Could not set name: the OCR models are not installed"),
                        }
                    }
                    let _ = hint;
                    for (k, _) in OW_STATS { ui.label(show(p.get(k))); }
                    ui.end_row();
                }
            });
        }
    });
}
