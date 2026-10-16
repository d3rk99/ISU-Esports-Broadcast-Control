//! Audience display presets: src/display-presets.js.
use serde_json::{Map, Value, json};

/// DISPLAY_PRESETS ids, same order.
pub const PRESET_IDS: [&str; 6] = ["idle", "intro", "player", "banner", "score", "black"];

/// ensureDisplayState: state.displays.stations["1".."10"] = { preset, team } with valid values.
pub fn ensure_display_state(state: &mut Value) {
    let obj = state.as_object_mut().expect("state is an object");
    if !obj.get("displays").is_some_and(Value::is_object) {
        obj.insert("displays".into(), json!({}));
    }
    let displays = obj.get_mut("displays").unwrap().as_object_mut().unwrap();
    if !displays.get("stations").is_some_and(Value::is_object) {
        displays.insert("stations".into(), json!({}));
    }
    let stations = displays.get_mut("stations").unwrap().as_object_mut().unwrap();
    for n in 1..=10 {
        let key = n.to_string();
        let valid = stations
            .get(&key)
            .and_then(Value::as_object)
            .and_then(|s| s.get("preset"))
            .and_then(Value::as_str)
            .is_some_and(|p| PRESET_IDS.contains(&p));
        if !valid {
            stations.insert(key, json!({ "preset": "idle", "team": "" }));
        } else {
            let s = stations.get_mut(&key).unwrap().as_object_mut().unwrap();
            // JS: !['', 'home', 'away'].includes(s.team ?? '') -> ''. A missing team stays missing there.
            match s.get("team") {
                None | Some(Value::Null) => {}
                Some(Value::String(t)) if t.is_empty() || t == "home" || t == "away" => {}
                Some(_) => {
                    s.insert("team".into(), json!(""));
                }
            }
        }
    }
}

/// stationTargets: '' / 'all' / '1-5' / '6-10' / 1..10 (Math.round of a number) -> station list.
pub fn station_targets(station: &str) -> Result<Vec<u32>, String> {
    let key = station.trim().to_lowercase();
    match key.as_str() {
        "" | "all" => return Ok((1..=10).collect()),
        "1-5" => return Ok((1..=5).collect()),
        "6-10" => return Ok((6..=10).collect()),
        _ => {}
    }
    let n = crate::game_config::js_number(&key).map(crate::game_config::js_round);
    match n {
        Some(n) if (1.0..=10.0).contains(&n) => Ok(vec![n as u32]),
        _ => Err("station must be 1-10, 1-5, 6-10 or all".into()),
    }
}

/// applyDisplayPreset(state, station, preset, team).
pub fn apply_display_preset(state: &mut Value, station: &str, preset: &str, team: &str) -> Result<Vec<u32>, String> {
    ensure_display_state(state);
    if !PRESET_IDS.contains(&preset) {
        return Err(format!("Unknown display preset: {preset}"));
    }
    if !["", "home", "away"].contains(&team) {
        return Err("team must be home, away or blank".into());
    }
    let targets = station_targets(station)?;
    let stations: &mut Map<String, Value> = state["displays"]["stations"].as_object_mut().unwrap();
    for n in &targets {
        stations.insert(n.to_string(), json!({ "preset": preset, "team": team }));
    }
    Ok(targets)
}
