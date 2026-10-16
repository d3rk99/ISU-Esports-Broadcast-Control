//! isu-core::boards = the real JS (parity-boards.json, rust/scripts/parity-boards.mjs).
use isu_core::boards::*;
use isu_core::{Value, json};

fn cases() -> Value { serde_json::from_str(include_str!("parity-boards.json")).unwrap() }

#[test]
fn team_mapping_matches_js() {
    for (i, c) in cases()["teams"].as_array().unwrap().iter().enumerate() {
        assert_eq!(current_round(&c["game"]), c["round"].as_f64().unwrap(), "case {i} round");
        assert_eq!(json!(attacking_team_now(&c["game"])), c["attacking"], "case {i} attacking");
        let prev = (!c["prev"].is_null()).then(|| &c["prev"]);
        let (b, d) = map_board_to_teams(&c["game"], &c["board"], prev);
        assert_eq!(json!({ "board": b, "decision": d }), c["result"], "case {i} map");
    }
}

#[test]
fn roster_syncs_match_js() {
    let c = cases();
    for (i, v) in c["vsync"].as_array().unwrap().iter().enumerate() {
        let mut g = v["game"].clone();
        let ch = sync_valorant_roster(&mut g, "varsity", true);
        assert_eq!(Value::Array(ch), v["changes"], "valorant {i} changes");
        assert_eq!(g, v["after"], "valorant {i} roster");
    }
    for (i, v) in c["osync"].as_array().unwrap().iter().enumerate() {
        let mut g = v["game"].clone();
        let ch = sync_roster_from_ocr(&mut g, "varsity", v["fill"].as_bool().unwrap());
        assert_eq!(Value::Array(ch), v["changes"], "overwatch {i} changes");
        assert_eq!(g, v["after"], "overwatch {i} roster");
    }
    for s in c["slugs"].as_array().unwrap() { assert_eq!(json!(agent_name_from_slug(s[0].as_str().unwrap())), s[1]); }
}

#[test]
fn round_timeline_matches_app_js() {
    let c = cases();
    let mut g = c["timelineStart"].clone();
    for (i, st) in c["timeline"].as_array().unwrap().iter().enumerate() {
        let now = st["now"].as_f64().unwrap();
        if st["step"] == "reset" { reset_round_history(&mut g); } else {
            let changed = sync_valorant_ocr_scores(&mut g, &st["step"], now);
            assert_eq!(json!(changed), st["changed"], "step {i} {} changed", st["step"]);
        }
        assert_eq!(g, st["game"], "step {i} {}", st["step"]);
    }
}
