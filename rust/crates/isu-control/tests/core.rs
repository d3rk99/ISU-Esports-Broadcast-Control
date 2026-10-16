//! Controller core: commit + undo (30 steps), save file + reload, Companion action, Rocket League
//! live feed from the real simulator ticks, MatchEnded -> series score + auto advance.
use std::sync::Arc;
use std::time::Duration;

use isu_control::core::Core;
use isu_control::settings::Files;
use serde_json::{Value, json};

fn core(tag: &str) -> (Arc<Core>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("isu-core-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    (Core::new(Files::new(dir.clone()), isu_server::Store::new()), dir)
}

fn wait_saves(c: &Core) { for _ in 0..40 { c.tick(); std::thread::sleep(Duration::from_millis(10)); } }

#[test]
fn commit_undo_save_reload() {
    let (c, dir) = core("undo");
    for i in 0..35 { c.commit("score", |s| s["games"]["valorant"]["teams"][0]["score"] = json!(i)); }
    assert_eq!(c.lock().history.len(), 30);
    assert!(c.undo());
    assert_eq!(c.state()["games"]["valorant"]["teams"][0]["score"], 33);
    wait_saves(&c);
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("control-state.json")).unwrap()).unwrap();
    assert_eq!(saved["games"]["valorant"]["teams"][0]["score"], 33);
    assert!(saved["updatedAt"].as_str().unwrap().ends_with('Z'));
    let again = Core::new(Files::new(dir.clone()), isu_server::Store::new());
    assert_eq!(again.state()["games"]["valorant"]["teams"][0]["score"], 33, "reloaded through store::load_state");
    assert_eq!(c.store.state()["games"]["valorant"]["teams"][0]["score"], 33, "published to the overlay store");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn companion_action_runs_on_state() {
    let (c, dir) = core("comp");
    let r = c.companion_action(&json!({ "action": "score.increment", "game": "valorant", "team": "home" }));
    assert!(r.is_ok(), "{r:?}");
    assert_eq!(c.state()["games"]["valorant"]["teams"][0]["score"], 1);
    assert_eq!(c.lock().history.len(), 1);
    let e = c.companion_action(&json!({ "action": "nope" })).unwrap_err();
    assert_eq!(e.0, 404, "{e:?}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn rocket_league_simulator_through_core() {
    let (c, dir) = core("rl");
    c.commit("rl on", |s| {
        s["selectedGame"] = json!("rocketleague");
        let rl = &mut s["games"]["rocketleague"]["rocketLeague"];
        for k in ["enabled", "syncClock", "syncGoals", "syncPlayers", "autoSeriesScore", "autoAdvance", "autoRoster"] { rl[k] = json!(true); }
    });
    assert_eq!(c.rl_connection()["enabled"], true);
    let guid = "SIM-1";
    c.rl_event(&json!({ "Event": "MatchCreated", "Data": { "MatchGuid": guid } }));
    let (mut rem, mut h, mut a) = (300i64, 0i64, 0i64);
    let mut ended = None;
    while ended.is_none() {
        let (upd, end) = isu_net::rocket_league::simulator_tick(guid, &mut rem, &mut h, &mut a);
        c.rl_event(&upd);
        ended = end;
    }
    let st = c.state();
    let g = &st["games"]["rocketleague"];
    assert_eq!(g["rocketLeague"]["live"]["timeSeconds"], 0);
    assert_eq!(g["rocketLeague"]["live"]["players"].as_array().unwrap().len(), 6);
    assert!(g["rosters"]["varsity"].as_array().unwrap().iter().any(|p| p["handle"] == "BengalOne"), "auto roster filled the home side");
    let detail: Vec<Value> = g["teams"].as_array().unwrap().iter().map(|t| t["detailScore"].clone()).collect();
    assert_eq!(detail, vec![json!(1), json!(1)]);
    c.rl_event(&ended.unwrap());
    let st = c.state();
    let g = &st["games"]["rocketleague"];
    let winner = g["mapRows"][0]["winner"].as_f64().unwrap() as usize;
    assert_eq!(g["teams"][winner]["score"], 1);
    assert_eq!(g["mapRows"][0]["status"], "complete");
    assert!(c.lock().rl_advance_at.is_some());
    c.lock().rl_advance_at = Some(std::time::Instant::now());
    c.tick();
    assert_eq!(c.state()["games"]["rocketleague"]["activeMap"], 1, "advanced after the win");
    let _ = std::fs::remove_dir_all(dir);
}
