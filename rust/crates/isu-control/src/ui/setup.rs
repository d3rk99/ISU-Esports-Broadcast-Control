//! "Show setup" checklist: the steps for a broadcast, in order, each checked from the real
//! state (not a manual tick). Shown on first start and any time from the sidebar.
use eframe::egui::{self, Color32, RichText};
use isu_core::game_config::{config, js_string, truthy};
use serde_json::{Value, json};

use super::status::Light;
use super::widgets::{heading, panel, primary_button, secondary_button};
use super::{App, c};

pub struct Step {
    pub title: String,
    pub what: String,
    pub done: Light,
    pub note: String,
    /// (button label, view to open)
    pub go: (&'static str, &'static str),
    pub optional: bool,
}

fn players(roster: &Value) -> usize {
    ["varsity", "jv"].iter().flat_map(|k| roster.get(*k).and_then(Value::as_array).cloned().unwrap_or_default()).filter(|p| truthy(p.get("handle")) || truthy(p.get("name"))).count()
}

pub fn steps(app: &App, st: &Value) -> Vec<Step> {
    let key = st["selectedGame"].as_str().unwrap_or("overwatch");
    let name = js_string(config(key).and_then(|c| c.get("name")));
    let game = &st["games"][key];
    let t = |i: usize, k: &str| isu_core::game_config::text(game.pointer(&format!("/teams/{i}/{k}")));
    let mut out = Vec::new();
    // 1 game
    out.push(Step { title: format!("1. Game: {name}"), what: "Pick the game you are broadcasting in the top-left box.".into(), done: Light::Good, note: String::new(), go: ("", ""), optional: false });
    // 2 teams
    let default_names = t(1, "name") == "OPPONENT";
    let lib = game.pointer("/rosterLibrary/teams").and_then(Value::as_array).map_or(0, Vec::len);
    let loaded = truthy(game.pointer("/rosterAssign/home")) && truthy(game.pointer("/rosterAssign/away"));
    out.push(Step {
        title: format!("2. Teams: {} vs {}", t(0, "name"), t(1, "name")),
        what: "Load both teams from Rosters → Roster Manager (or type the names and logos on Match Control).".into(),
        done: if loaded { Light::Good } else if default_names { Light::Wait } else { Light::Good },
        note: if loaded { "Both teams loaded from the library".into() } else if lib == 0 { "No teams in the library yet".into() } else if default_names { "The away team is still called OPPONENT".into() } else { "Names set by hand".into() },
        go: ("OPEN ROSTERS", "roster"),
        optional: false,
    });
    // 3 rosters
    let n = players(&game["rosters"]) + players(&game["awayRosters"]);
    out.push(Step { title: "3. Players".into(), what: "Gamertags, names and photos for the roster overlay and player cards. The scoreboard readers use the gamertags.".into(), done: if n >= 2 { Light::Good } else { Light::Wait }, note: format!("{n} players entered"), go: ("OPEN ROSTERS", "roster"), optional: false });
    // 4 maps
    let rows = game["mapRows"].as_array().cloned().unwrap_or_default();
    let named = rows.iter().filter(|r| truthy(r.get("map"))).count();
    out.push(Step { title: "4. Maps / games".into(), what: "Set the series format and the maps (VALORANT: picks and bans).".into(), done: if named > 0 { Light::Good } else { Light::Wait }, note: format!("{named} of {} maps set", rows.len()), go: ("OPEN MAP POOL", "maps"), optional: false });
    // 5 game data
    let (gl, gn) = match key {
        "rocketleague" => {
            let on = truthy(st.pointer("/games/rocketleague/rocketLeague/enabled"));
            let stt = isu_core::game_config::text(st.pointer("/games/rocketleague/rocketLeague/live/status"));
            if !on { (Light::Wait, "Rocket League live data is off".to_string()) } else if stt == "connected" || stt == "simulating" { (Light::Good, "Receiving game data".into()) } else { (Light::Wait, "On, waiting for the game".into()) }
        }
        "valorant" | "overwatch" => {
            let rd = if key == "valorant" { app.svc.core.lock().valorant_board["status"].clone() } else { app.svc.core.lock().overwatch_ocr["status"].clone() };
            match rd["state"].as_str().unwrap_or("") {
                "reading" => (Light::Good, "Reading the scoreboard".into()),
                "disabled" | "" => (Light::Wait, "Scoreboard reader is off".into()),
                _ => (Light::Wait, isu_core::game_config::text(rd.get("message"))),
            }
        }
        _ => (Light::Off, "Scored by hand on Match Control".into()),
    };
    out.push(Step { title: "5. Live game data".into(), what: match key { "rocketleague" => "Turn on Rocket League live data on Match Control (on this PC, or on another PC with the Game Bridge app).", "valorant" | "overwatch" => "Turn on the scoreboard reader on Match Control. The observer PC keeps the scoreboard (Tab) open.", _ => "Nothing to set up: this game is scored by hand." }.into(), done: gl, note: gn, go: ("OPEN MATCH CONTROL", "control"), optional: !matches!(key, "rocketleague" | "valorant" | "overwatch") });
    // 6 OBS + stations
    let ds = app.svc.core.lock().display_status.clone();
    let online = ds["onlineCount"].as_u64().unwrap_or(0);
    out.push(Step { title: "6. Station screens".into(), what: "Only if the stage has screens for the players: start the Display Client on each station PC, then on Displays press SET UP OBS once.".into(), done: if online > 0 { Light::Good } else { Light::Off }, note: format!("{online} of 10 connected"), go: ("OPEN DISPLAYS", "stage"), optional: true });
    // 7 program output
    let open = app.svc.outputs.program_open.load(std::sync::atomic::Ordering::Acquire);
    out.push(Step { title: "7. Program output".into(), what: "Open the full-screen Fill + Key graphics for the video switcher, or add the overlay pages to OBS as browser sources.".into(), done: if open { Light::Good } else { Light::Wait }, note: if open { "Fill + Key open".into() } else { "Not open".into() }, go: ("OPEN OBS OUTPUTS", "outputs"), optional: false });
    out
}

pub fn view(app: &mut App, ui: &mut egui::Ui, st: &Value) {
    heading(ui, "", "Show setup", "Go through these steps before the broadcast. They tick themselves when the app sees it is done. Grey = not needed for this show.", |ui| {
        if ui.add(secondary_button("CLOSE")).clicked() {
            app.set_and_persist(|s| { s["activeView"] = json!("control"); s["setupSeen"] = json!(true); });
        }
    });
    for step in steps(app, st) {
        panel(ui, |ui| {
            ui.horizontal(|ui| {
                let (r, _) = ui.allocate_exact_size(egui::vec2(26.0, 26.0), egui::Sense::hover());
                let col = match step.done { Light::Good => Color32::from_rgb(0x70, 0xcd, 0x6a), Light::Wait => Color32::from_rgb(0xe8, 0xb3, 0x3c), Light::Bad => Color32::from_rgb(0xe5, 0x48, 0x4d), Light::Off => Color32::from_rgb(0x55, 0x55, 0x5c) };
                ui.painter().circle_stroke(r.center(), 11.0, egui::Stroke::new(2.0, col));
                ui.painter().text(r.center(), egui::Align2::CENTER_CENTER, if step.done == Light::Good { "✓" } else if step.done == Light::Off { "–" } else { "!" }, egui::FontId::proportional(13.0), col);
                ui.vertical(|ui| {
                    ui.set_width((ui.available_width() - 200.0).max(200.0));
                    ui.spacing_mut().item_spacing.y = 3.0;
                    ui.label(RichText::new(&step.title).strong().size(14.0).color(c::TEXT));
                    ui.add(egui::Label::new(RichText::new(&step.what).size(11.5).color(c::MUTED)).wrap());
                    if !step.note.is_empty() {
                        ui.label(RichText::new(format!("{}{}", step.note, if step.optional { " · optional" } else { "" })).size(10.5).color(col));
                    }
                });
                if !step.go.0.is_empty() {
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        let b = if step.done == Light::Good || step.done == Light::Off { secondary_button(step.go.0) } else { primary_button(step.go.0) };
                        if ui.add(b).clicked() {
                            let v = step.go.1.to_string();
                            app.set_and_persist(|s| s["activeView"] = json!(v));
                        }
                    });
                }
            });
        });
    }
}
