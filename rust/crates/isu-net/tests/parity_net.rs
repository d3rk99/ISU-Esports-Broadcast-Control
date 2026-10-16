//! isu-net parity with the real JS (parity-net.json, rust/scripts/parity-net.cjs).
use isu_net::rocket_league::{self as rl, JsonStreamParser};
use isu_net::spectate::{self as sp, SpectateReceiver};
use serde_json::{Value, json};
use std::sync::Arc;

fn cases() -> Value { serde_json::from_str(include_str!("parity-net.json")).unwrap() }

#[test]
fn spectate_state_matches_js() {
    let c = cases();
    for s in c["states"].as_array().unwrap() {
        let st = &s["state"];
        assert_eq!(Value::Array(sp::candidates_from(st)), s["candidates"], "{} candidates", s["name"]);
        assert_eq!(sp::sides_from(st), s["sides"], "{} sides", s["name"]);
        for r in s["resolved"].as_array().unwrap() { assert_eq!(sp::resolve(st, &r["sp"]), r["out"], "{} resolve {}", s["name"], r["sp"]); }
    }
}

#[test]
fn rocket_league_pieces_match_js() {
    let c = cases();
    for s in c["rlSettings"].as_array().unwrap() { assert_eq!(rl::settings_json(&rl::normalize_settings(&s["in"])), s["out"], "normalizeSettings {}", s["in"]); }
    for s in c["streams"].as_array().unwrap() {
        let mut p = JsonStreamParser::default(); let mut got = Vec::new();
        for ch in s["chunks"].as_array().unwrap() { p.push(ch.as_str().unwrap(), |v| got.push(v)); }
        assert_eq!(Value::Array(got), s["values"], "stream {}", s["chunks"]);
    }
    for e in c["envelopes"].as_array().unwrap() { assert_eq!(rl::normalize_envelope(&e["in"]).unwrap_or(Value::Null), e["out"], "envelope {}", e["in"]); }
    // simulator: same messages (guid = SIM-<Date.now()>, the JS run used 1700000000000)
    let guid = "SIM-1700000000000";
    let mut all = vec![json!({ "Event": "MatchCreated", "Data": { "MatchGuid": guid } })];
    let (mut r, mut h, mut a) = (300i64, 0, 0);
    loop { let (m, end) = rl::simulator_tick(guid, &mut r, &mut h, &mut a); all.push(m); if let Some(e) = end { all.push(e); break; } }
    let want = c["sim"].as_array().unwrap();
    let pick: Vec<Value> = all.iter().enumerate().filter(|(i, m)| *i < 4 || m["Event"] != "UpdateState" || [14, 15, 29, 30, 100, 299].contains(&(300 - m["Data"]["Game"]["TimeSeconds"].as_i64().unwrap_or(-1))) || m["Data"]["Game"]["TimeSeconds"] == 0).map(|(_, m)| m.clone()).collect();
    assert_eq!(all.len() as u64, c["simCount"].as_u64().unwrap(), "simulator message count");
    assert_eq!(Value::Array(pick), Value::Array(want.clone()), "simulator messages");
}

#[tokio::test]
async fn receiver_cleaning_matches_js() {
    let c = cases();
    for s in c["recvSettings"].as_array().unwrap() {
        let n = sp::normalize_settings(&s["in"]);
        assert_eq!(json!({ "enabled": n.enabled, "port": n.port, "token": n.token }), s["out"], "receiver settings {}", s["in"]);
    }
    let r = SpectateReceiver::new(Arc::new(|_| {}), Arc::new(|_| {}));
    for s in c["recvCandidates"].as_array().unwrap() {
        let list: Vec<Value> = s["list"].as_array().unwrap().clone();
        assert_eq!(json!(r.set_candidates(&list, &s["sides"])), s["n"], "count");
    }
}
