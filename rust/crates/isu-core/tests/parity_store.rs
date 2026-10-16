//! isu-core::store::load_state = the real src/store.js loadState (parity-store.json from
//! rust/scripts/parity-store.mjs): current, old, damaged and legacy saved documents.
use isu_core::Value;

#[test]
fn load_state_matches_js() {
    let cases: Value = serde_json::from_str(include_str!("parity-store.json")).unwrap();
    for (i, c) in cases.as_array().unwrap().iter().enumerate() {
        let mut out = isu_core::store::load_state(c["raw"].as_str());
        out.as_object_mut().unwrap().remove("updatedAt");
        assert_eq!(out, c["out"], "case {i}: {}", c["raw"].as_str().map(|s| &s[..s.len().min(80)]).unwrap_or("null"));
    }
}
