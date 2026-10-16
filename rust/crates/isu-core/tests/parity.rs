//! Parity: the Rust port must give the SAME result as the JS controller on every case in
//! parity-cases.json (written by `node rust/scripts/parity-cases.mjs` from the real JS code).
use isu_core::actions::apply_companion_action;
use isu_core::variables::{build_companion_capabilities, build_companion_variables, build_stage_variables};
use isu_core::{Value, json, tags::tag_similarity};

fn cases() -> Value {
    serde_json::from_str(include_str!("parity-cases.json")).unwrap()
}

/// JSON-pointer diff, same as diff() in parity-cases.mjs.
fn diff(a: &Value, b: &Value, path: &str, out: &mut serde_json::Map<String, Value>) {
    if a == b {
        return;
    }
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            let mut keys: Vec<&String> = x.keys().chain(y.keys()).collect();
            keys.dedup();
            let mut seen = std::collections::HashSet::new();
            for k in keys {
                if !seen.insert(k) {
                    continue;
                }
                let p = format!("{path}/{}", k.replace('~', "~0").replace('/', "~1"));
                diff(x.get(k).unwrap_or(&Value::Null), y.get(k).unwrap_or(&json!("__removed__")), &p, out);
            }
        }
        (Value::Array(x), Value::Array(y)) => {
            for i in 0..x.len().max(y.len()) {
                diff(x.get(i).unwrap_or(&Value::Null), y.get(i).unwrap_or(&json!("__removed__")), &format!("{path}/{i}"), out);
            }
        }
        _ => {
            out.insert(path.to_string(), b.clone());
        }
    }
}

fn same(label: &str, want: &Value, got: &Value, fails: &mut Vec<String>) {
    if want != got {
        fails.push(format!("{label}\n   js:   {}\n   rust: {}", trunc(want), trunc(got)));
    }
}

fn trunc(v: &Value) -> String {
    let s = v.to_string();
    if s.len() > 600 { format!("{}…", &s[..600]) } else { s }
}

#[test]
fn rust_matches_js_on_every_case() {
    let all = cases();
    let now = all["now"].as_f64().unwrap();
    let states = &all["states"];
    let mut fails = Vec::new();
    let mut n = 0;
    for c in all["cases"].as_array().unwrap() {
        let st = &states[c["state"].as_str().unwrap_or("base")];
        match c["kind"].as_str().unwrap() {
            "action" => {
                n += 1;
                let mut s = st.clone();
                let label = format!("[{}] {}", c["state"], c["request"]);
                match apply_companion_action(&mut s, &c["request"], now) {
                    Ok(r) => {
                        same(&format!("{label} result"), &c["result"], &r.to_json(), &mut fails);
                        if !c["error"].is_null() {
                            fails.push(format!("{label}: js threw {}, rust ok", c["error"]));
                        }
                    }
                    Err(e) => same(&format!("{label} error"), &c["error"], &json!({ "message": e.message, "status": e.status }), &mut fails),
                }
                let mut changes = serde_json::Map::new();
                diff(st, &s, "", &mut changes);
                same(&format!("{label} changes"), &c["changes"], &Value::Object(changes), &mut fails);
            }
            "chain" => {
                let mut s = st.clone();
                for step in c["steps"].as_array().unwrap() {
                    n += 1;
                    let r = apply_companion_action(&mut s, &step["request"], now);
                    let err = r.err().map(|e| json!(e.message)).unwrap_or(Value::Null);
                    same(&format!("chain {} error", step["request"]), &step["error"], &err, &mut fails);
                }
                same("chain final state", &c["final"], &s, &mut fails);
            }
            "variables" => {
                n += 1;
                same(&format!("[{}] variables", c["state"]), &c["variables"], &Value::Object(build_companion_variables(st)), &mut fails);
                same(&format!("[{}] capabilities", c["state"]), &c["capabilities"], &build_companion_capabilities(st), &mut fails);
            }
            "stage" => {
                n += 1;
                same(&format!("[{}] stage variables", c["state"]), &c["variables"], &Value::Object(build_stage_variables(&c["status"], st, now)), &mut fails);
            }
            "tags" => {
                for p in c["pairs"].as_array().unwrap() {
                    n += 1;
                    let (a, b) = (p[0].as_str().unwrap(), p[1].as_str().unwrap());
                    let want = p[2].as_f64().unwrap();
                    let got = tag_similarity(a, b);
                    if (want - got).abs() > 1e-12 {
                        fails.push(format!("tagSimilarity({a:?}, {b:?}) js {want} rust {got}"));
                    }
                }
            }
            k => panic!("unknown case kind {k}"),
        }
    }
    assert!(fails.is_empty(), "{} of {n} checks differ from the JS controller:\n{}", fails.len(), fails.iter().take(25).cloned().collect::<Vec<_>>().join("\n"));
    eprintln!("{n} checks identical to the JS controller");
}

#[test]
fn game_config_json_is_current() {
    // The embedded tables must equal what src/game-config.js exports right now.
    let out = std::process::Command::new("node").arg("-e").arg(
        "import('../../../src/game-config.js').then(m=>{const s=m.createInitialState();delete s.updatedAt;process.stdout.write(JSON.stringify({order:m.GAME_ORDER,arenaNames:m.ROCKET_LEAGUE_ARENA_NAMES,initialState:s}))})"
    ).current_dir(env!("CARGO_MANIFEST_DIR")).output();
    let Ok(out) = out else { eprintln!("node not found: skipped"); return };
    let js: Value = serde_json::from_slice(&out.stdout).expect("node output");
    let d = isu_core::game_config::data();
    assert_eq!(js["order"], d["order"], "run node rust/scripts/export-game-config.mjs");
    assert_eq!(js["arenaNames"], d["arenaNames"], "run node rust/scripts/export-game-config.mjs");
    assert_eq!(js["initialState"], d["initialState"], "run node rust/scripts/export-game-config.mjs");
}
