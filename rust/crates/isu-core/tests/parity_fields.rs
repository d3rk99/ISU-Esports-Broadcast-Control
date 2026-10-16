//! isu-core::controls::set_field = the real app.js 'change' handler branches (parity-fields.json,
//! rust/scripts/parity-fields.mjs): map rows, veto, roster player edits (+ library write back),
//! away roster toggle, roster first side, on every game.
use isu_core::Value;
use isu_core::controls::{Field, set_field};

#[test]
fn field_edits_match_app_js() {
    let c: Value = serde_json::from_str(include_str!("parity-fields.json")).unwrap();
    for s in c["sessions"].as_array().unwrap() {
        let game = s["game"].as_str().unwrap();
        let mut state = s["start"].clone();
        for (i, st) in s["steps"].as_array().unwrap().iter().enumerate() {
            if st["skip"] == true { continue; }
            let a = st["step"].as_array().unwrap();
            let u = |k: usize| a[k].as_f64().unwrap() as usize;
            let t = |k: usize| a[k].as_str().unwrap().to_string();
            let msg = match a[0].as_str().unwrap() {
                "mapProp" => { let (p, v) = (t(2), t(3)); set_field(&mut state, Field::MapProp { row: u(1), prop: &p, value: &v }) }
                "mapScore" => { let v = t(3); set_field(&mut state, Field::MapScore { row: u(1), side: u(2), value: &v }) }
                "vetoBan" => { let v = t(2); set_field(&mut state, Field::VetoBan { index: u(1), value: &v }) }
                "vetoPick" => { let (p, v) = (t(2), t(3)); set_field(&mut state, Field::VetoPick { index: u(1), prop: &p, value: &v }) }
                "player" => { let (p, v) = (t(2), t(3)); set_field(&mut state, Field::Player { index: u(1), prop: &p, value: &v }) }
                "away" => set_field(&mut state, Field::AwayRoster { on: a[1].as_bool().unwrap() }),
                "firstSide" => { let v = t(1); set_field(&mut state, Field::RosterFirstSide { value: &v }) }
                _ => unreachable!(),
            };
            assert_eq!(msg.map(Value::String).unwrap_or(Value::Null), st["msg"], "{game} step {i} {:?} message", a);
            assert_eq!(state, st["state"], "{game} step {i} {:?}", a);
        }
    }
}
