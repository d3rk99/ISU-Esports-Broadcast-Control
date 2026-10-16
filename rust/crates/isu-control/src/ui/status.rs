//! Status strip under the top bar: one light per system, in plain words. Green = working,
//! yellow = waiting / not set up, red = problem, grey = not used. Click a light to open the page
//! that fixes it.
use eframe::egui::{self, Color32, RichText};
use isu_core::game_config::truthy;
use serde_json::{Value, json};

use super::{App, c};

#[derive(Clone, Copy, PartialEq)]
pub enum Light { Good, Wait, Bad, Off }

impl Light {
    fn color(self) -> Color32 {
        match self {
            Light::Good => Color32::from_rgb(0x70, 0xcd, 0x6a),
            Light::Wait => Color32::from_rgb(0xe8, 0xb3, 0x3c),
            Light::Bad => Color32::from_rgb(0xe5, 0x48, 0x4d),
            Light::Off => Color32::from_rgb(0x55, 0x55, 0x5c),
        }
    }
}

pub struct Item {
    pub name: &'static str,
    pub light: Light,
    pub text: String,
    /// page to open when clicked (activeView)
    pub view: &'static str,
}

fn s(v: Option<&Value>) -> String {
    isu_core::game_config::text(v)
}

/// The lights for the current state (pure, so it can be tested).
pub fn items(app: &App, st: &Value) -> Vec<Item> {
    let game = st["selectedGame"].as_str().unwrap_or("overwatch");
    let mut out = Vec::new();
    // overlays (OBS browser sources read port 3174)
    let overlay_err = app.svc.overlay_error.lock().unwrap().clone();
    out.push(Item { name: "Overlays", light: if overlay_err.is_empty() { Light::Good } else { Light::Bad }, text: if overlay_err.is_empty() { "OBS pages are being served".into() } else { "Port 3174 is busy: close the other copy of the app".into() }, view: "outputs" });
    // program output windows
    let open = app.svc.outputs.program_open.load(std::sync::atomic::Ordering::Acquire);
    out.push(Item { name: "Program", light: if open { Light::Good } else { Light::Wait }, text: if open { "Fill + Key screens are open".into() } else { "Program screens are closed (OBS Outputs → OPEN PROGRAM)".into() }, view: "outputs" });
    // game data
    match game {
        "rocketleague" => {
            let live = st.pointer("/games/rocketleague/rocketLeague/live").cloned().unwrap_or(json!({}));
            let on = truthy(st.pointer("/games/rocketleague/rocketLeague/enabled"));
            let status = s(live.get("status"));
            let (light, text) = if !on { (Light::Off, "Live data is off (scores by hand)".to_string()) } else {
                match status.as_str() {
                    "connected" | "simulating" => (Light::Good, if status == "simulating" { "Test feed running".into() } else { "Receiving game data".into() }),
                    "error" => (Light::Bad, s(live.get("message"))),
                    _ => (Light::Wait, "Waiting for Rocket League / a match".into()),
                }
            };
            out.push(Item { name: "Game data", light, text, view: "control" });
        }
        "valorant" | "overwatch" => {
            let rd = if game == "valorant" { app.svc.core.lock().valorant_board["status"].clone() } else { app.svc.core.lock().overwatch_ocr["status"].clone() };
            let state = s(rd.get("state"));
            let (light, text) = match state.as_str() {
                "reading" => (Light::Good, "Reading the scoreboard".to_string()),
                "error" => (Light::Bad, s(rd.get("message"))),
                "no-board" => (Light::Wait, "Game found, scoreboard (Tab) not open".into()),
                "disabled" | "" => (Light::Off, "Scoreboard reader is off".into()),
                _ => (Light::Wait, s(rd.get("message"))),
            };
            out.push(Item { name: "Scoreboard", light, text, view: "control" });
        }
        _ => out.push(Item { name: "Game data", light: Light::Off, text: "This game is scored by hand".into(), view: "control" }),
    }
    // stations
    let ds = app.svc.core.lock().display_status.clone();
    let online = ds["onlineCount"].as_u64().unwrap_or(0);
    let derr = s(ds.get("error"));
    out.push(Item { name: "Stations", light: if !derr.is_empty() { Light::Bad } else if online > 0 { Light::Good } else { Light::Off }, text: if !derr.is_empty() { derr } else { format!("{online} of 10 station screens connected") }, view: "stage" });
    // stream deck
    let cs = app.svc.companion.status();
    let cen = app.svc.companion.settings().enabled;
    out.push(Item { name: "Stream Deck", light: if !cen { Light::Off } else if cs["listening"] == true { Light::Good } else { Light::Bad }, text: if !cen { "Off".into() } else if cs["listening"] == true { format!("On · {} connected", cs["clients"].as_u64().unwrap_or(0)) } else { "Could not start (port in use?)".into() }, view: "settings" });
    out
}

pub fn strip(app: &mut App, ui: &mut egui::Ui, st: &Value) {
    let list = items(app, st);
    egui::Frame::NONE.fill(Color32::from_rgb(0x10, 0x10, 0x12)).inner_margin(egui::Margin { left: 36, right: 36, top: 7, bottom: 7 }).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 18.0;
            for it in list {
                let g = ui.painter().layout_no_wrap(it.name.to_string(), egui::FontId::proportional(11.0), c::TEXT);
                let (r, resp) = ui.allocate_exact_size(egui::vec2(g.size().x + 18.0, 20.0), egui::Sense::click());
                let p = ui.painter();
                if resp.hovered() {
                    p.rect_filled(r.expand(3.0), 3.0, Color32::from_rgb(0x1c, 0x1c, 0x1f));
                }
                p.circle_filled(egui::pos2(r.left() + 5.0, r.center().y), 4.5, it.light.color());
                p.galley(egui::pos2(r.left() + 16.0, r.center().y - g.size().y / 2.0), g, c::TEXT);
                let resp = resp.on_hover_text(format!("{} — click to open its page", it.text));
                resp.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Button, true, format!("status {}", it.name)));
                if resp.clicked() {
                    let v = it.view.to_string();
                    app.set_and_persist(|s| s["activeView"] = json!(v));
                }
            }
        });
    });
    let r = ui.max_rect();
    ui.painter().hline(r.x_range(), ui.cursor().top(), egui::Stroke::new(1.0, Color32::from_rgb(0x22, 0x22, 0x25)));
    let _ = RichText::new("");
}
