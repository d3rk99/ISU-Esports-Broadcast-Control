//! isu-core::controls = the real app.js click handler `actions` + syncFormat (parity-controls.json,
//! rust/scripts/parity-controls.mjs): a 31-button session on every game.
use isu_core::{Value, json};

#[test]
fn control_buttons_match_app_js() {
    let c: Value = serde_json::from_str(include_str!("parity-controls.json")).unwrap();
    for s in c["sessions"].as_array().unwrap() {
        let game = s["game"].as_str().unwrap();
        let opts: Vec<f64> = isu_core::game_config::config(game).unwrap()["formatOptions"].as_array().into_iter().flatten().filter_map(Value::as_f64).collect();
        let mut state = s["start"].clone();
        for (i, st) in s["steps"].as_array().unwrap().iter().enumerate() {
            let a = st["action"].as_str().unwrap();
            let idx = st["index"].as_f64().unwrap();
            let msg = if a == "format" {
                if opts.contains(&idx) || game != "rocketleague" { isu_core::controls::sync_format(&mut state, idx); }
                None
            } else {
                isu_core::controls::apply(&mut state, a, idx as usize, st["winner"].as_f64(), st["now"].as_f64().unwrap())
            };
            assert_eq!(msg.map(Value::String).unwrap_or(Value::Null), st["msg"], "{game} step {i} {a} message");
            assert_eq!(state, st["state"], "{game} step {i} {a} {idx}");
        }
        let _ = json!(null);
    }
}
