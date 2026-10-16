//! Game tables + JS value semantics. The tables come from src/game-config.js through
//! data/game-config.json (rust/scripts/export-game-config.mjs), so there is one source of truth.
use std::sync::OnceLock;

use serde_json::Value;

static DATA: OnceLock<Value> = OnceLock::new();

pub fn data() -> &'static Value {
    DATA.get_or_init(|| serde_json::from_str(include_str!("../data/game-config.json")).expect("game-config.json"))
}

/// GAME_CONFIGS[key] (None for an unknown game).
pub fn config(key: &str) -> Option<&'static Value> {
    data()["configs"].get(key).filter(|v| v.is_object())
}

pub fn game_order() -> Vec<&'static str> {
    data()["order"].as_array().unwrap().iter().filter_map(Value::as_str).collect()
}

/// createInitialState() without updatedAt (set by the caller).
pub fn initial_state() -> Value {
    data()["initialState"].clone()
}

/// rocketLeagueArenaName(value).
pub fn rocket_league_arena_name(value: &str) -> String {
    let raw = value.trim();
    if raw.is_empty() {
        return String::new();
    }
    if let Some(n) = data()["arenaNames"].get(raw).and_then(Value::as_str) {
        return n.to_string();
    }
    let mut s = raw.to_string();
    if s.len() >= 2 && s[s.len() - 2..].eq_ignore_ascii_case("_p") {
        s.truncate(s.len() - 2);
    }
    let s = s.replace('_', " ");
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    // \b\w -> upper: a word char after a non-word char (JS \w = [A-Za-z0-9_]).
    let mut out = String::with_capacity(s.len());
    let mut prev_word = false;
    for c in s.chars() {
        let word = c.is_ascii_alphanumeric() || c == '_';
        out.push(if word && !prev_word { c.to_ascii_uppercase() } else { c });
        prev_word = word;
    }
    out
}

// ---------------------------------------------------------------- JS semantics ---

/// Number(string) for the strings that reach the actions (trimmed decimal / hex / Infinity).
pub fn js_number(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return u64::from_str_radix(h, 16).ok().map(|v| v as f64);
    }
    match t {
        "Infinity" | "+Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    // Rust accepts "inf"/"nan"/"1e5"; JS accepts "1e5" but not "inf"/"nan".
    if t.chars().any(|c| c.is_ascii_alphabetic() && c != 'e' && c != 'E') {
        return None;
    }
    t.parse::<f64>().ok()
}

/// Number(value) for any JSON value. NaN -> None.
pub fn to_number(v: Option<&Value>) -> Option<f64> {
    let n = match v {
        None => return None, // undefined -> NaN
        Some(Value::Null) => Some(0.0),
        Some(Value::Bool(b)) => Some(f64::from(u8::from(*b))),
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => js_number(s),
        Some(Value::Array(a)) => match a.len() {
            0 => Some(0.0),
            1 => to_number(a.first()),
            _ => None,
        },
        Some(Value::Object(_)) => None,
    };
    n.filter(|x| !x.is_nan())
}

/// Number(v) || 0
pub fn num_or_zero(v: Option<&Value>) -> f64 {
    to_number(v).unwrap_or(0.0)
}

/// Math.round: halves round toward +Infinity.
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// JS truthiness.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// String(value) for scalars, as JS prints them (numbers without a trailing ".0").
pub fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => num_to_js(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::Array(a)) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(Some(x)) }).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// String(value ?? ''): missing / null -> "", everything else like js_string.
pub fn text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        x => js_string(x),
    }
}

pub fn num_to_js(x: f64) -> String {
    if x.is_nan() {
        "NaN".into()
    } else if x.is_infinite() {
        if x > 0.0 { "Infinity".into() } else { "-Infinity".into() }
    } else if x == x.trunc() && x.abs() < 1e21 {
        format!("{}", x as i64)
    } else {
        format!("{x}")
    }
}

/// A JSON number that prints like JS: integers as integers.
pub fn jnum(x: f64) -> Value {
    if x == x.trunc() && x.abs() < 9.0e15 {
        Value::from(x as i64)
    } else {
        serde_json::Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
    }
}
