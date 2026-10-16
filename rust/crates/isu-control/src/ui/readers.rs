//! Scoreboard reader panels on Match Control: src/valorant-board-panel.js renderValorantBoardPanel
//! (+ the vb-* / data-val-round / data-val-stat-cards handlers of app.js) and the Overwatch one
//! (src/overwatch-ocr-panel.js renderOverwatchOcrPanel + ow-ocr-* handlers).
use eframe::egui::{self, Color32, RichText};
use isu_core::boards::{attacking_team_now, current_round};
use isu_core::game_config::{js_string, num_or_zero, truthy};
use serde_json::{Value, json};

use super::widgets::{cols, inset, panel, secondary_button, select, text_field, title, toggle};
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
    let tone = match st.as_str() { "reading" => Color32::from_rgb(0x4a, 0xd1, 0x8a), "error" => Color32::from_rgb(0xff, 0x7b, 0x72), "no-board" => Color32::from_rgb(0xff, 0xce, 0x47), _ => Color32::from_rgb(0xae, 0xb9, 0xc4) };
    let sweep = num_or_zero(status.get("sweepMs"));
    ui.label(RichText::new(format!("{} · {}{}", st.to_uppercase(), { let m = s(status.get("message")); if m.is_empty() { "off".into() } else { m } }, if sweep > 0.0 { format!(" · {sweep} ms per read") } else { String::new() })).size(11.5).strong().color(tone));
}

/// .vb-match: bold line + small explanation under it.
fn info_line(ui: &mut egui::Ui, bold: &str, small: &str, col: Color32) {
    inset(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.spacing_mut().item_spacing.y = 3.0;
        ui.label(RichText::new(bold).size(11.5).strong().color(col));
        if !small.is_empty() {
            ui.add(egui::Label::new(RichText::new(small).size(10.5).color(c::DIM)).wrap());
        }
    });
}

/// A reader table: header row + rows, each column a fixed or fractional width (same `cols` rules).
fn table(ui: &mut egui::Ui, widths: &[f32], head: &[&str], rows: usize, mut cell: impl FnMut(usize, usize, &mut egui::Ui)) {
    egui::Frame::NONE.fill(c::INPUT).stroke(egui::Stroke::new(1.0, Color32::from_rgb(0x23, 0x27, 0x2e))).corner_radius(2.0).inner_margin(egui::Margin::symmetric(8, 6)).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.spacing_mut().item_spacing.y = 0.0;
        cols(ui, widths, 6.0, |j, ui| { ui.label(RichText::new(head[j]).size(9.5).strong().extra_letter_spacing(0.8).color(Color32::from_rgb(0x8a, 0x94, 0xa3))); });
        ui.add_space(5.0);
        for r in 0..rows {
            let top = ui.cursor().top();
            ui.painter().hline(ui.max_rect().x_range(), top, egui::Stroke::new(1.0, Color32::from_rgb(0x23, 0x27, 0x2e)));
            ui.add_space(3.0);
            cols(ui, widths, 6.0, |j, ui| {
                ui.set_min_height(26.0);
                ui.with_layout(egui::Layout::left_to_right(egui::Align::Center), |ui| cell(r, j, ui));
            });
        }
    });
}

/// Compact name box inside a reader table (manual names get an orange border).
fn name_box(ui: &mut egui::Ui, id: &str, value: &str, manual: bool, hint: &str) -> Option<String> {
    let key = egui::Id::new(("draft", id));
    let mut draft: String = ui.data(|d| d.get_temp::<String>(key)).unwrap_or_else(|| value.to_string());
    let r = ui.scope(|ui| {
        if manual {
            ui.visuals_mut().widgets.inactive.bg_stroke = egui::Stroke::new(1.0, c::ORANGE);
        }
        ui.add(egui::TextEdit::singleline(&mut draft).hint_text("(OCR)").desired_width(ui.available_width()).margin(egui::vec2(6.0, 4.0)).text_color(if manual { Color32::from_rgb(0xff, 0xd3, 0x7a) } else { c::TEXT }))
    }).inner.on_hover_text(hint);
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

fn cell_text(ui: &mut egui::Ui, t: &str) {
    let blank = t == "·" || t == "–";
    ui.label(RichText::new(t).size(12.0).color(if blank { Color32::from_rgb(0x4a, 0x52, 0x5d) } else { c::TEXT }));
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
        // .vb-panel .ow-ocr-controls: 1.6fr 1.4fr 1fr 1fr auto
        cols(ui, &[-1.6, -1.4, -1.0, -1.0, 210.0], 12.0, |j, ui| match j {
            0 => {
                let mut cards = game.get("valorantShowStatCards") != Some(&json!(false));
                if toggle(ui, &mut cards, "PLAYER STAT CARDS", "Bottom-left / bottom-right cards on the scoreboard overlay (Companion: Player stat cards)") {
                    app.commit(if cards { "VALORANT stat cards on" } else { "VALORANT stat cards off" }, |st| st["games"]["valorant"]["valorantShowStatCards"] = json!(cards));
                }
            }
            1 => {
                let mut en = settings["enabled"] == true;
                if toggle(ui, &mut en, "READ SCOREBOARD", "Off by default; turn on when Observer 3 is on the board") {
                    cfg = Some((json!({ "enabled": en }), if en { "VALORANT scoreboard reader on" } else { "VALORANT scoreboard reader off" }.into()));
                }
            }
            2 => {
                if let Some(x) = text_field(ui, "vbwin", "Window title contains", &{ let w = s(settings.get("windowName")); if w.is_empty() { "VALORANT".into() } else { w } }, 200, 0.0) {
                    cfg = Some((json!({ "windowName": x.trim() }), "VALORANT reader settings saved".into()));
                }
            }
            3 => {
                cols(ui, &[-1.0, -1.0], 6.0, |k, ui| {
                    let (key, l, d) = if k == 0 { ("intervalMs", "Read every (ms)", 500.0) } else { ("workers", "CPU cores", 4.0) };
                    let cur = { let n = num_or_zero(settings.get(key)); if n == 0.0 { d } else { n } };
                    if let Some(x) = text_field(ui, &format!("vb{key}"), l, &cur.to_string(), 5, 0.0) {
                        cfg = Some((json!({ key: isu_core::game_config::js_number(x.trim()).unwrap_or(f64::NAN) }), "VALORANT reader settings saved".into()));
                    }
                });
            }
            _ => {
                ui.add_space(12.0);
                ui.horizontal(|ui| {
                    if ui.add(secondary_button("TEST READ")).clicked() {
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
            info_line(ui, &format!("ROUND SCORE {score} · TIMER {timer}"), "Read from the top of the screen; the round score fills in the match score (never goes backwards).", c::TEXT);
        }
        cols(ui, &[220.0, -1.0], 12.0, |j, ui| {
            if j == 0 {
                if let Some(x) = text_field(ui, "valround", "Current round override", &override_v, 3, 0.0) {
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
                ui.add(egui::Label::new(RichText::new("Blank = auto from the round score. For replays or joining mid-map; saved per map.").size(9.5).color(c::DIM)).wrap());
            } else {
                let who = if attacking.is_empty() { "Set the first attacking team in Map Pool.".to_string() } else { format!("{} ATTACKING (RED) · {} DEFENDING (TEAL)", side_name(attacking), side_name(if attacking == "home" { "away" } else { "home" })) };
                let extra = if override_v.is_empty() && round == 1.0 { " Joining a replay mid-map? Set the current round on the left if the score is unreadable or still 0–0." } else { "" };
                info_line(ui, &format!("ROUND {round} · {source}"), &format!("{who} · First 12 rounds use Map Pool; rounds 13–24 reverse it; overtime alternates.{extra}"), c::TEXT);
            }
        });
        if !dups.is_empty() {
            info_line(ui, &format!("ROSTER CONFLICT: {}", dups.join(", ")), "These gamertags are assigned to both teams. Load the correct Home and Away teams in Roster Manager. The bridge uses the mapped reader block to disambiguate names it can read.", c::RED);
        }
        if let Some(d) = vb.get("decision").filter(|d| truthy(Some(d))) {
            let by = match d["by"].as_str().unwrap_or("") { "names" => "ROSTER GAMERTAGS", "sides" => "MAP POOL ATTACKING SIDE", "kept" => "LAST DECISION", "default" => "DEFAULT (nothing to go on yet)", x => x };
            info_line(ui, &format!("TEAMS ON THE BOARD: top = {} · decided by {by}", { let t = s(d.get("top")); if t.is_empty() { "home".into() } else { t } }.to_uppercase()), &format!("{} · Players are followed by gamertag when VALORANT re-sorts the board.", s(d.get("detail"))), c::TEXT);
        }
        status_line(ui, &vb["status"]);
        // .vb-tables: two blocks side by side
        let mut name_edit: Option<(String, usize, String)> = None;
        cols(ui, &[-1.0, -1.0], 14.0, |si, ui| {
            let side = if si == 0 { "home" } else { "away" };
            let players = vb.pointer(&format!("/live/teams/{side}/players")).and_then(Value::as_array).cloned().unwrap_or_default();
            let dec = vb.get("decision").and_then(|d| d.get("top")).and_then(Value::as_str);
            let team_side = dec.map(|t| if side == "home" { t.to_string() } else if t == "home" { "away".into() } else { "home".into() }).unwrap_or_default();
            let team_name = if team_side.is_empty() { String::new() } else { teams.get(if team_side == "home" { 0 } else { 1 }).map(|t| s(t.get("name"))).unwrap_or_default() };
            let color = s(vb.pointer(&format!("/live/colors/{side}")));
            let (tag, tagc) = if color.is_empty() { (String::new(), c::TEXT) } else if color == "red" { (" · ATTACKING".to_string(), Color32::from_rgb(0xff, 0x46, 0x55)) } else { (" · DEFENDING".to_string(), Color32::from_rgb(0x3d, 0xd9, 0xc3)) };
            ui.horizontal(|ui| {
                ui.label(RichText::new(format!("{} BLOCK · {}{}", if side == "home" { "TOP" } else { "BOTTOM" }, if team_name.is_empty() { "?".into() } else { team_name }, if team_side.is_empty() { String::new() } else { format!(" ({})", team_side.to_uppercase()) })).size(12.0).strong().extra_letter_spacing(0.8).color(c::TEXT));
                if !tag.is_empty() { ui.label(RichText::new(tag).size(12.0).strong().color(tagc)); }
            });
            let mut rows: Vec<(usize, Value)> = players.into_iter().enumerate().collect();
            rows.sort_by(|a, b| a.1.get("row").and_then(Value::as_f64).unwrap_or(a.0 as f64).partial_cmp(&b.1.get("row").and_then(Value::as_f64).unwrap_or(b.0 as f64)).unwrap_or(std::cmp::Ordering::Equal));
            table(ui, &[-1.0, -1.5, 30.0, 24.0, 24.0, 24.0, -0.9, 52.0, 52.0, 30.0], &["AGENT", "NAME", "ULT", "K", "D", "A", "GUN", "SHIELD", "CREDS", "PING"], rows.len(), |r, j, ui| {
                let (slot, p) = &rows[r];
                match j {
                    0 => {
                        match p.get("agent").filter(|a| truthy(Some(a))) {
                            Some(a) => {
                                let a = s(Some(a));
                                ui.add(egui::Image::new(format!("http://127.0.0.1:3174/assets/valorant/agents/{a}.webp")).fit_to_exact_size(egui::vec2(22.0, 22.0)).corner_radius(3.0));
                                ui.add(egui::Label::new(RichText::new(a.to_uppercase()).size(11.0).color(c::TEXT)).truncate());
                            }
                            None => cell_text(ui, "·"),
                        }
                    }
                    1 => {
                        if let Some(x) = name_box(ui, &format!("vbn{side}{slot}"), &s(p.get("name")), truthy(p.get("nameManual")), "Type to set the name by hand") {
                            name_edit = Some((side.to_string(), *slot, x));
                        }
                    }
                    2 => cell_text(ui, &v(p.get("ultimate"))),
                    3 => cell_text(ui, &v(p.get("kills"))),
                    4 => cell_text(ui, &v(p.get("deaths"))),
                    5 => cell_text(ui, &v(p.get("assists"))),
                    6 => cell_text(ui, &p.get("weapon").filter(|w| truthy(Some(w))).map_or("·".into(), |w| s(Some(w)).to_uppercase())),
                    7 => cell_text(ui, &p.get("shield").filter(|w| truthy(Some(w))).map_or("·".into(), |w| shield(&s(Some(w))).to_string())),
                    8 => cell_text(ui, &p.get("credits").and_then(Value::as_f64).filter(|x| x.is_finite()).map_or("·".into(), thousands)),
                    _ => cell_text(ui, &v(p.get("ping"))),
                }
            });
        });
        if let Some((side, slot, x)) = name_edit {
            if let Some(b) = &app.svc.board {
                if b.set_player_name(&side, slot as i64, &x).is_ok() {
                    app.svc.core.valorant_board_snapshot(&b.snapshot());
                }
            }
        }
        ui.add_space(6.0);
        ui.separator();
        ui.add_space(4.0);
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
        // toggles row
        cols(ui, &[-1.0, -1.0, -1.0, -1.0], 12.0, |j, ui| match j {
            0 => {
                let mut en = settings["enabled"] == true;
                if toggle(ui, &mut en, "READ SCOREBOARD", "Off by default; turn on when Observer 3 is on the board") { cfg = Some(("enabled".into(), json!(en))); }
            }
            1 => {
                let mut cards = truthy(game.get("overwatchShowStatCards"));
                if toggle(ui, &mut cards, "PLAYER STAT CARDS (EXPERIMENTAL)", "Bottom-left / bottom-right cards on the scoreboard overlay") {
                    app.commit(if cards { "Overwatch stat cards on" } else { "Overwatch stat cards off" }, |st| st["games"]["overwatch"]["overwatchShowStatCards"] = json!(cards));
                }
            }
            2 => {
                let mut auto = game.get("overwatchHeroAutofill") != Some(&json!(false));
                if toggle(ui, &mut auto, "AUTO-FILL ROSTER FROM OCR", "Matches gamertags at ≥90% similarity: hero + role follow the game; empty roster slots get filled from the board") {
                    app.commit(if auto { "Roster heroes auto-fill on" } else { "Roster heroes auto-fill off" }, |st| st["games"]["overwatch"]["overwatchHeroAutofill"] = json!(auto));
                }
            }
            _ => {
                let mut align = settings.get("autoAlign") != Some(&json!(false));
                if toggle(ui, &mut align, "AUTO-ALIGN BOXES", "Follows names pushed up by competitive Drives and columns nudged by icons; DEBUG CAPTURE shows what moved") { cfg = Some(("autoAlign".into(), json!(align))); }
            }
        });
        ui.add_space(4.0);
        // fields row
        cols(ui, &[-1.4, -0.8, -1.0, -0.7, -0.7], 12.0, |j, ui| match j {
            0 => {
                let cur = { let x = s(settings.get("view")); if x.is_empty() { "auto".into() } else { x } };
                let opts: Vec<(String, String)> = [("auto", "Auto-detect"), ("spectator", "Spectator (Observer)"), ("player", "Testing: in the lobby (own stat card)")].iter().map(|(k, l)| (k.to_string(), l.to_string())).collect();
                if let Some(pick) = select(ui, "owview", "Board view", &cur, &opts) { cfg = Some(("view".into(), json!(pick))); }
                ui.label(RichText::new("Auto finds it from the column labels; pick one to force it").size(9.5).color(c::DIM));
            }
            2 => {
                if let Some(x) = text_field(ui, "owwin", "Window title contains", &{ let w = s(settings.get("windowName")); if w.is_empty() { "Overwatch".into() } else { w } }, 200, 0.0) {
                    cfg = Some(("windowName".into(), json!(x.trim())));
                }
            }
            _ => {
                let (k, l, d, note) = match j { 1 => ("boxScale", "Number box size (%)", 108.0, "100 = measured, default 108"), 3 => ("intervalMs", "Read every (ms)", 500.0, ""), _ => ("workers", "CPU cores (OCR)", 4.0, "Default: half your cores") };
                let cur = { let n = num_or_zero(settings.get(k)); if n == 0.0 { d } else { n } };
                if let Some(x) = text_field(ui, &format!("ow{k}"), l, &cur.to_string(), 5, 0.0) {
                    cfg = Some((k.into(), json!(isu_core::game_config::js_number(x.trim()).unwrap_or(f64::NAN))));
                }
                if !note.is_empty() { ui.label(RichText::new(note).size(9.5).color(c::DIM)); }
            }
        });
        // buttons
        ui.horizontal(|ui| {
            if ui.add(secondary_button("TEST READ")).clicked() {
                match app.svc.overwatch.clone() {
                    Some(o) => {
                        let (tx, core) = (app.toast_tx.clone(), std::sync::Arc::clone(&app.svc.core));
                        std::thread::spawn(move || match o.sweep() { Ok(_) => { core.overwatch_snapshot(&o.snapshot()); let _ = tx.send("Read the scoreboard once".into()); } Err(e) => { let _ = tx.send(format!("Test read failed: {e}")); } });
                    }
                    None => app.toast("Test read failed: the OCR models are not installed"),
                }
            }
            if ui.add(secondary_button("DEBUG CAPTURE")).clicked() {
                match app.svc.overwatch.clone() {
                    Some(o) => {
                        app.toast("Capturing the Overwatch window…");
                        let (tx, slot) = (app.toast_tx.clone(), std::sync::Arc::clone(&app.ow_debug));
                        std::thread::spawn(move || match o.debug_capture() {
                            Ok(d) => { *slot.lock().unwrap() = Some((d, None)); let _ = tx.send("Debug capture ready".into()); }
                            Err(e) => { let _ = tx.send(format!("Debug capture failed: {e}")); }
                        });
                    }
                    None => app.toast("Debug capture failed: the OCR models are not installed"),
                }
            }
            if app.ow_debug.lock().unwrap().is_some() && ui.add(secondary_button("HIDE DEBUG")).clicked() {
                *app.ow_debug.lock().unwrap() = None;
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
        status_line(ui, &ow["status"]);
        // .ow-ocr-tables: two tables side by side
        let mut name_edit: Option<(String, usize, String)> = None;
        cols(ui, &[-1.0, -1.0], 14.0, |t, ui| {
            let side = if t == 0 { "home" } else { "away" };
            let players = ow.pointer(&format!("/live/teams/{side}/players")).and_then(Value::as_array).cloned().unwrap_or_default();
            let short = teams.get(t).map(|x| s(x.get("shortName"))).filter(|x| !x.is_empty()).unwrap_or_else(|| side.to_uppercase());
            ui.label(RichText::new(format!("{short} · {} of the board", if t == 0 { "top" } else { "bottom" })).size(12.0).strong().extra_letter_spacing(1.2).color(Color32::from_rgb(0xf0, 0x64, 0x14)));
            table(ui, &[16.0, -1.6, -1.2, 32.0, 24.0, 24.0, 24.0, 40.0, 40.0, 40.0], &["#", "PLAYER", "HERO", "ULT", "E", "A", "D", "DMG", "HEAL", "MIT"], 5, |i, j, ui| {
                let p = players.get(i).cloned().unwrap_or(json!({}));
                match j {
                    0 => cell_text(ui, &format!("{}", i + 1)),
                    1 => {
                        let manual = truthy(p.get("nameManual"));
                        let hint = if manual { "Set by hand. Clear it to go back to OCR." } else { "Read by OCR. Type to set it by hand." };
                        if let Some(x) = name_box(ui, &format!("own{side}{i}"), &s(p.get("name")), manual, hint) {
                            name_edit = Some((side.to_string(), i, x));
                        }
                    }
                    _ => {
                        let k = OW_STATS[j - 2].0;
                        cell_text(ui, &show(p.get(k)));
                    }
                }
            });
        });
        if let Some((side, i, x)) = name_edit {
            match app.svc.overwatch.clone() {
                Some(o) => match o.set_player_name(&side, i as f64, &x) {
                    Ok(_) => { app.svc.core.overwatch_snapshot(&o.snapshot()); app.toast(&if x.trim().is_empty() { "Name cleared, OCR reads it again".into() } else { format!("Name set to {} (stays until cleared)", x.trim()) }); }
                    Err(e) => app.toast(&format!("Could not set name: {e}")),
                },
                None => app.toast("Could not set name: the OCR models are not installed"),
            }
        }
        debug_view(app, ui);
    });
}

const FIELD_LABEL: [(&str, &str); 8] = [("name", "NAME"), ("ultimate", "ULT"), ("elims", "E"), ("assists", "A"), ("deaths", "D"), ("damage", "DMG"), ("healing", "HEAL"), ("mitigation", "MIT")];

/// data:image/png;base64,... -> texture.
fn data_url_texture(ctx: &egui::Context, name: &str, url: &str) -> Option<egui::TextureHandle> {
    use base64::Engine;
    let b = base64::engine::general_purpose::STANDARD.decode(url.strip_prefix("data:image/png;base64,")?).ok()?;
    let mut d = png::Decoder::new(std::io::Cursor::new(b));
    d.set_transformations(png::Transformations::EXPAND);
    let mut r = d.read_info().ok()?;
    let mut buf = vec![0; r.output_buffer_size()?];
    let info = r.next_frame(&mut buf).ok()?;
    let ch = info.color_type.samples();
    let (w, h) = (info.width as usize, info.height as usize);
    let rgba: Vec<u8> = buf[..w * h * ch].chunks(ch).flat_map(|p| match ch { 1 => [p[0], p[0], p[0], 255], 3 => [p[0], p[1], p[2], 255], _ => [p[0], p[1], p[2], p[3]] }).collect();
    Some(ctx.load_texture(name, egui::ColorImage::from_rgba_unmultiplied([w, h], &rgba), egui::TextureOptions::LINEAR))
}

/// renderOverwatchDebugCapture(debug) + alignSummary.
fn debug_view(app: &mut App, ui: &mut egui::Ui) {
    let mut slot = app.ow_debug.lock().unwrap();
    let Some((d, tex)) = slot.as_mut() else { return };
    if tex.is_none() {
        let ctx = ui.ctx().clone();
        let frame = data_url_texture(&ctx, "ow-dbg-frame", d["frameDataUrl"].as_str().unwrap_or(""));
        let cells: Vec<(Option<egui::TextureHandle>, Option<egui::TextureHandle>)> = d["cells"].as_array().into_iter().flatten().enumerate().map(|(i, c)| (data_url_texture(&ctx, &format!("ow-raw{i}"), c["rawDataUrl"].as_str().unwrap_or("")), data_url_texture(&ctx, &format!("ow-proc{i}"), c["processedDataUrl"].as_str().unwrap_or("")))).collect();
        *tex = Some(DebugTex { frame, cells });
    }
    let t = tex.as_ref().unwrap();
    let age = ((crate::core::now_ms() - num_or_zero(d.get("capturedAt"))) / 1000.0).round().max(0.0);
    ui.separator();
    ui.label(RichText::new(format!("DEBUG CAPTURE · {age}s old · {} · {}×{} → {}×{} · {}", { let n = s(d.get("sourceName")); if n.is_empty() { "window".into() } else { n } }, s(d.get("sourceWidth")), s(d.get("sourceHeight")), s(d.get("width")), s(d.get("height")), s(d.get("backend")))).strong());
    // alignSummary
    let a = &d["align"];
    if a.is_null() {
        ui.label(RichText::new("AUTO-ALIGN off · boxes at the profile positions").small().color(c::MUTED));
    } else {
        let mut rows: Vec<String> = Vec::new();
        for (k, r) in a["rows"].as_object().cloned().unwrap_or_default() {
            let (side, row) = k.split_once(':').unwrap_or(("", "0"));
            let mut bits = Vec::new();
            let sd = num_or_zero(r.get("statDy"));
            let nd = num_or_zero(r.get("nameDy"));
            if sd != 0.0 { bits.push(format!("stats {}{sd}", if sd > 0.0 { "+" } else { "" })); }
            if nd != 0.0 { bits.push(format!("name {}{nd}", if nd > 0.0 { "+" } else { "" })); }
            if !bits.is_empty() { rows.push(format!("{} {}: {}", if side == "home" { "TOP" } else { "BOT" }, row.parse::<i64>().unwrap_or(0) + 1, bits.join(", "))); }
        }
        let view = match a["view"].as_str() { Some("player") => "PLAYER VIEW (own stat card)", Some("spectator") => "SPECTATOR VIEW", _ => "LAYOUT NOT FOUND" };
        let ldx = num_or_zero(a.get("leftDx"));
        let layout = format!("{view}{}{}{}", if truthy(a.get("forced")) { " (forced)" } else { "" }, if truthy(a.get("perks")) { " · PERKS" } else { "" }, if ldx != 0.0 { format!(" · board {}{ldx} px", if ldx > 0.0 { "+" } else { "" }) } else { String::new() });
        let dx = num_or_zero(a.get("dx"));
        let cols = if a["cols"].is_object() { format!("from labels E{}…MIT{}", s(a["cols"].get("elims")), s(a["cols"].get("mitigation"))) } else if dx != 0.0 { format!("{}{dx} px", if dx > 0.0 { "+" } else { "" }) } else { "in place".into() };
        ui.label(RichText::new(format!("AUTO-ALIGN · {layout} · stat columns {cols}{}", if rows.is_empty() { " · every row in place".to_string() } else { format!(" · {}", rows.join(" · ")) })).small().color(c::MUTED));
    }
    // frame with every box (green accepted / red rejected)
    if let Some(f) = &t.frame {
        let w = ui.available_width().min(960.0);
        let size = egui::vec2(w, w * 1080.0 / 1920.0);
        let (rect, _) = ui.allocate_exact_size(size, egui::Sense::hover());
        ui.painter().image(f.id(), rect, egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)), Color32::WHITE);
        for cdat in d["cells"].as_array().into_iter().flatten() {
            let r = &cdat["roi"];
            let k = size.x / 1920.0;
            let bx = egui::Rect::from_min_size(rect.min + egui::vec2(num_or_zero(r.get("x")) as f32 * k, num_or_zero(r.get("y")) as f32 * k), egui::vec2(num_or_zero(r.get("w")) as f32 * k, num_or_zero(r.get("h")) as f32 * k));
            let ok = !cdat["accepted"].is_null();
            ui.painter().rect_stroke(bx, 0.0, egui::Stroke::new(1.0, if ok { Color32::from_rgb(80, 200, 120) } else { c::RED }), egui::StrokeKind::Outside);
        }
    }
    if let Some(hs) = d["heroes"].as_array().filter(|h| !h.is_empty()) {
        let txt: Vec<String> = hs.iter().map(|h| format!("{} {}: {}", if h["side"] == "home" { "TOP" } else { "BOT" }, num_or_zero(h.get("row")) + 1.0, if truthy(h.get("hero")) { s(h.get("hero")) } else { format!("? ({} {})", s(h.get("candidate")), s(h.get("score"))) })).collect();
        ui.label(RichText::new(format!("HEROES · {}", txt.join(" · "))).small().color(c::MUTED));
    }
    let mut use_name: Option<(String, i64, String)> = None;
    let columns = (ui.available_width() / 190.0).floor().max(1.0) as usize;
    egui::Grid::new("overwatch-debug-cells").num_columns(columns).show(ui, |ui| {
        for (i, cdat) in d["cells"].as_array().into_iter().flatten().enumerate() {
            let ok = !cdat["accepted"].is_null();
            egui::Frame::NONE.fill(c::PANEL_LIGHT).stroke(egui::Stroke::new(1.0, if ok { Color32::from_rgb(80, 200, 120) } else { c::RED })).corner_radius(4.0).inner_margin(6.0).show(ui, |ui| {
                ui.vertical(|ui| {
                    ui.set_width(170.0);
                    let f = cdat["field"].as_str().unwrap_or("");
                    ui.label(RichText::new(format!("{} {} · {}", if cdat["side"] == "home" { "TOP" } else { "BOT" }, num_or_zero(cdat.get("row")) + 1.0, FIELD_LABEL.iter().find(|x| x.0 == f).map_or(f, |x| x.1))).small().strong());
                    for tx in [t.cells.get(i).and_then(|c| c.0.as_ref()), t.cells.get(i).and_then(|c| c.1.as_ref())].into_iter().flatten() {
                        let sz = tx.size_vec2();
                        let k = (160.0 / sz.x).min(40.0 / sz.y).min(3.0);
                        ui.image((tx.id(), sz * k));
                    }
                    let g = &cdat["glyphs"];
                    let digits = if g.is_null() { String::new() } else { let n = num_or_zero(Some(g)); format!(" · {n} digit{} seen", if n == 1.0 { "" } else { "s" }) };
                    ui.label(RichText::new(format!("read “{}” {}%{digits} → {}", s(cdat.get("text")), s(cdat.get("confidence")), if ok { s(cdat.get("accepted")) } else { "rejected".into() })).small());
                    let txt = s(cdat.get("text")).trim().to_uppercase();
                    if f == "name" && !ok && !txt.is_empty() && ui.button(format!("USE “{txt}”")).clicked() {
                        use_name = Some((s(cdat.get("side")), num_or_zero(cdat.get("row")) as i64, txt.clone()));
                    }
                });
            });
            if (i + 1) % columns == 0 {
                ui.end_row();
            }
        }
    });
    drop(slot);
    if let Some((side, row, name)) = use_name {
        if let Some(o) = &app.svc.overwatch {
            if o.set_player_name(&side, row as f64, &name).is_ok() {
                app.svc.core.overwatch_snapshot(&o.snapshot());
                app.toast(&format!("Name set to {name} (stays until cleared)"));
            }
        }
    }
}

pub struct DebugTex {
    frame: Option<egui::TextureHandle>,
    cells: Vec<(Option<egui::TextureHandle>, Option<egui::TextureHandle>)>,
}
