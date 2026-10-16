//! Saved controller state: src/store.js (loadState repairs / upgrades a saved document,
//! saveState stamps updatedAt). The Rust controller keeps the same JSON document in a file
//! instead of localStorage.
use serde_json::{Value, json};

use crate::game_config::{config, game_order, initial_state, to_number, truthy};

fn spread(base: &Value, over: Option<&Value>) -> Value {
    let mut b = if base.is_object() { base.clone() } else { json!({}) };
    if let Some(Value::Object(o)) = over {
        for (k, v) in o {
            b[k] = v.clone();
        }
    }
    b
}

fn is_isu_short(short: &str) -> bool {
    let c: Vec<char> = short.to_uppercase().chars().collect();
    (0..c.len()).any(|i| c[i..].starts_with(&['I', 'S', 'U']) && (i == 0 || c[i - 1].is_whitespace()) && (i + 3 == c.len() || c[i + 3].is_whitespace()))
}

/// loadState(raw JSON text or None): createInitialState() when missing / invalid / too old.
pub fn load_state(raw: Option<&str>) -> Value {
    let fresh = || initial_state();
    let Some(mut parsed) = raw.and_then(|r| serde_json::from_str::<Value>(r).ok()) else { return fresh() };
    let ver = parsed.get("version").and_then(Value::as_f64);
    if !parsed.is_object() || !ver.is_some_and(|v| [1.0, 2.0, 3.0, 4.0].contains(&v)) || !truthy(parsed.get("games")) || !parsed["games"].is_object() {
        return fresh();
    }
    let fallback = fresh();
    for game in game_order() {
        let fb = &fallback["games"][game];
        if !truthy(parsed["games"].get(game)) {
            parsed["games"][game] = fb.clone();
            continue;
        }
        let saved_first = parsed["games"][game].get("rosterFirstSide").cloned();
        let mut g = spread(fb, parsed["games"].get(game));
        let cfg = config(game).unwrap();
        let def_len = cfg["defaultSeriesLength"].as_f64().filter(|x| *x != 0.0);
        let saved_len = to_number(g.get("seriesLength")).filter(|x| *x != 0.0).or(def_len).unwrap_or_else(|| fb["seriesLength"].as_f64().unwrap_or(0.0));
        let opts: Vec<f64> = cfg["formatOptions"].as_array().into_iter().flatten().filter_map(Value::as_f64).collect();
        let len = if !opts.is_empty() && !opts.contains(&saved_len) { def_len.unwrap_or_else(|| fb["seriesLength"].as_f64().unwrap_or(0.0)) } else { saved_len };
        g["seriesLength"] = crate::game_config::jnum(len);
        let mut m = spread(&fb["match"], g.get("match").filter(|v| truthy(Some(v))));
        m["format"] = if def_len.is_some() {
            json!(format!("Best of {}", crate::game_config::num_to_js(len)))
        } else {
            g.pointer("/match/format").filter(|v| truthy(Some(v))).cloned().unwrap_or_else(|| fb["match"]["format"].clone())
        };
        g["match"] = m;
        let saved_rows = g.get("mapRows").and_then(Value::as_array).cloned().unwrap_or_default();
        let modes: Vec<Value> = cfg["modes"].as_array().cloned().unwrap_or_default();
        g["mapRows"] = Value::Array(
            modes
                .iter()
                .enumerate()
                .map(|(i, mode)| {
                    let mut r = spread(fb["mapRows"].get(i).unwrap_or(&Value::Null), saved_rows.get(i));
                    let saved_mode = saved_rows.get(i).and_then(|x| x.get("mode"));
                    r["mode"] = if saved_mode.is_some_and(|sm| modes.contains(sm)) {
                        saved_mode.unwrap().clone()
                    } else {
                        fb["mapRows"].get(i).and_then(|x| x.get("mode")).filter(|v| !v.is_null()).cloned().unwrap_or_else(|| mode.clone())
                    };
                    r
                })
                .collect(),
        );
        let rows = g["mapRows"].as_array().unwrap().len() as f64;
        g["activeMap"] = crate::game_config::jnum(to_number(g.get("activeMap")).filter(|x| !x.is_nan()).unwrap_or(0.0).min(rows - 1.0).max(0.0));
        g["teams"] = Value::Array(fb["teams"].as_array().unwrap().iter().enumerate().map(|(i, t)| spread(t, parsed["games"][game].pointer(&format!("/teams/{i}")))).collect());
        g["rosterFirstSide"] = match saved_first.as_ref().and_then(Value::as_str) {
            Some(s @ ("home" | "away")) => json!(s),
            _ => {
                let idx = g["teams"].as_array().unwrap().iter().position(|t| is_isu_short(t.get("shortName").and_then(Value::as_str).unwrap_or("")) || t.get("name").and_then(Value::as_str).unwrap_or("").to_uppercase().contains("IDAHO STATE"));
                json!(if idx == Some(1) { "away" } else { "home" })
            }
        };
        for coll in ["rosters", "awayRosters"] {
            if !truthy(g.get(coll)) {
                g[coll] = fb[coll].clone();
            }
            for rt in ["varsity", "jv"] {
                let saved = g[coll].get(rt).and_then(Value::as_array).cloned().unwrap_or_default();
                let fbr = fb[coll][rt].as_array().cloned().unwrap_or_default();
                let n = saved.len().max(fbr.len());
                g[coll][rt] = Value::Array((0..n).map(|i| spread(fbr.get(i).or(fbr.first()).unwrap_or(&Value::Null), saved.get(i).filter(|v| truthy(Some(v))))).collect());
            }
        }
        let empty = json!({});
        let ca = g.get("characterArt").filter(|v| truthy(Some(v))).unwrap_or(&empty).clone();
        let fca = fb.get("characterArt").filter(|v| truthy(Some(v))).unwrap_or(&empty).clone();
        g["characterArt"] = if game == "overwatch" { spread(&ca, Some(&fca)) } else { spread(&fca, Some(&ca)) };
        let ma = g.get("mapArt").filter(|v| truthy(Some(v))).unwrap_or(&empty).clone();
        g["mapArt"] = if ["overwatch", "valorant", "rocketleague"].contains(&game) { spread(&ma, fb.get("mapArt")) } else { ma };
        let wa = g.get("weaponArt").filter(|v| truthy(Some(v))).unwrap_or(&empty).clone();
        g["weaponArt"] = if game == "valorant" { spread(&wa, fb.get("weaponArt")) } else { wa };
        if game == "rocketleague" {
            let art = g["characterArt"].clone();
            for coll in ["rosters", "awayRosters"] {
                for rt in ["varsity", "jv"] {
                    for p in g[coll][rt].as_array_mut().unwrap() {
                        let shared = p.get("character").and_then(|c| art.get(crate::game_config::js_string(Some(c))));
                        if !truthy(p.get("characterImage")) {
                            if let Some(sh) = shared.filter(|s| truthy(s.get("url"))) {
                                p["characterImage"] = sh["url"].clone();
                                p["characterImageName"] = if truthy(sh.get("name")) { sh["name"].clone() } else { json!("") };
                            }
                        }
                    }
                }
            }
            let mut rl = spread(&fb["rocketLeague"], g.get("rocketLeague").filter(|v| truthy(Some(v))));
            rl["live"] = fb["rocketLeague"]["live"].clone();
            g["rocketLeague"] = rl;
        }
        if game == "valorant" {
            let mut o = spread(&fb["valorantOcr"], g.get("valorantOcr").filter(|v| truthy(Some(v))));
            o["live"] = fb["valorantOcr"]["live"].clone();
            g["valorantOcr"] = o;
        }
        if truthy(g.get("veto")) {
            let mut used: Vec<String> = Vec::new();
            if let Some(bans) = g["veto"].get_mut("bans").and_then(Value::as_array_mut) {
                for b in bans.iter_mut() {
                    let name = b.as_str().unwrap_or("").to_string();
                    if !truthy(Some(b)) || used.contains(&name) {
                        *b = json!("");
                    } else {
                        used.push(name);
                    }
                }
            }
            if let Some(picks) = g["veto"].get_mut("picks").and_then(Value::as_array_mut) {
                for p in picks.iter_mut() {
                    let name = p.get("map").map(|m| crate::game_config::js_string(Some(m))).unwrap_or_default();
                    if !truthy(p.get("map")) || used.contains(&name) {
                        p["map"] = json!("");
                    } else {
                        used.push(name);
                    }
                }
            }
        }
        parsed["games"][game] = g;
    }
    crate::display_presets::ensure_display_state(&mut parsed);
    let mut out = spread(&fallback, Some(&parsed));
    let t = to_number(parsed.get("programTransitionSeconds").filter(|v| !v.is_null()).or(fallback.get("programTransitionSeconds"))).filter(|x| *x != 0.0 && !x.is_nan()).unwrap_or(1.0);
    out["programTransitionSeconds"] = crate::game_config::jnum(t.clamp(0.1, 5.0));
    out["version"] = json!(4);
    out
}

/// saveState(state): { ...state, updatedAt } (the caller writes it).
pub fn save_state(state: &Value, iso_now: &str) -> Value {
    let mut s = state.clone();
    s["updatedAt"] = json!(iso_now);
    s
}
