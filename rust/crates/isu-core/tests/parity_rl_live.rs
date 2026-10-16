//! Rocket League live handling = the real src/app.js handleRocketLeagueEvent, step by step
//! (parity-rl-live.json, rust/scripts/parity-rl-live.mjs): match created, live updates with
//! roster sync + car art + event badges, clock + overtime, MatchEnded (twice = ignored), unknown guid.
use isu_core::rocket_league::{handle_event, name_similarity, normalize_gamer_name};
use isu_core::{Value, json};

#[test]
fn rocket_league_live_matches_app_js() {
    let c: Value = serde_json::from_str(include_str!("parity-rl-live.json")).unwrap();
    let mut state = c["initial"].clone();
    for (i, st) in c["steps"].as_array().unwrap().iter().enumerate() {
        let out = handle_event(&mut state, &st["event"], st["now"].as_f64().unwrap());
        let label = format!("step {i} {}", st["event"]["Event"]);
        assert_eq!(state["games"]["rocketleague"], st["game"], "{label}: game state");
        let renders: Vec<Value> = out.renders.iter().map(|r| r.2["name"].clone()).collect();
        assert_eq!(Value::Array(renders), st["renders"], "{label}: car renders");
        let log = st["log"].as_array().unwrap();
        assert_eq!(out.live_update, log.iter().any(|l| l == "live"), "{label}: live update");
        let ended = log.iter().find(|l| l.as_str().is_some_and(|s| s.ends_with("game win received"))).cloned();
        assert_eq!(out.match_ended.map(Value::String), ended, "{label}: match ended");
        assert_eq!(json!(out.advance_later), st["advanceLater"], "{label}: auto advance");
    }
    for n in c["names"].as_array().unwrap() {
        let (a, b) = (n[0].as_str().unwrap(), n[1].as_str().unwrap());
        assert_eq!(name_similarity(a, b), n[2].as_f64().unwrap(), "nameSimilarity({a}, {b})");
        assert_eq!(json!(normalize_gamer_name(a)), n[3], "normalizeGamerName({a})");
    }
}
