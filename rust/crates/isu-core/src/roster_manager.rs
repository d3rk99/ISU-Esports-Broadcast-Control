//! Roster Manager (team library = source of truth): src/roster-manager.js, 1:1.
//! game.rosterLibrary.teams[] { id, name, shortName, isISU, color, logoImage, logoImageName, players[] },
//! game.rosterAssign { home, away }, game.coaches { home, away }.
use serde_json::{Value, json};

use crate::game_config::{js_string, truthy};
use crate::tags::tag_similarity;

pub const STATUSES: [&str; 4] = ["starter", "sixth", "sub", "coach"];
pub const PROGRAMS: [&str; 2] = ["varsity", "jv"];

fn order(status: &str) -> usize {
    STATUSES.iter().position(|s| *s == status).unwrap_or(3)
}

/// clean(v, n): String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n).
fn clean(v: Option<&Value>, n: usize) -> String {
    let s = match v {
        None | Some(Value::Null) => String::new(),
        x => js_string(x),
    };
    let joined = s.split_whitespace().collect::<Vec<_>>().join(" ");
    String::from_utf16_lossy(&joined.encode_utf16().take(n).collect::<Vec<u16>>())
}

/// uid(prefix): prefix + time (base 36) + 5 random base-36 chars.
pub fn uid(prefix: &str, now_ms: u64, rand: f64) -> String {
    let b36 = |mut n: u64| {
        let d = b"0123456789abcdefghijklmnopqrstuvwxyz";
        let mut o = Vec::new();
        loop {
            o.push(d[(n % 36) as usize]);
            n /= 36;
            if n == 0 {
                break;
            }
        }
        o.reverse();
        String::from_utf8(o).unwrap()
    };
    let r = b36((rand * 36f64.powi(5)) as u64);
    format!("{prefix}{}{}", b36(now_ms), &format!("{r:0>5}")[..5])
}

fn new_id(prefix: &str) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    uid(prefix, now, rand_unit())
}

fn rand_unit() -> f64 {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut h = RandomState::new().build_hasher();
    h.write_u64(0);
    (h.finish() >> 11) as f64 / (1u64 << 53) as f64
}

fn normalize_player(p: &mut Value) {
    if !truthy(p.get("id")) {
        p["id"] = json!(new_id("p"));
    }
    p["handle"] = json!(clean(p.get("handle"), 24));
    p["name"] = json!(clean(p.get("name"), 40));
    if !p.get("status").and_then(Value::as_str).is_some_and(|s| STATUSES.contains(&s)) {
        p["status"] = json!("sub");
    }
    if !p.get("program").and_then(Value::as_str).is_some_and(|s| PROGRAMS.contains(&s)) {
        p["program"] = json!("varsity");
    }
    for k in ["playerImage", "playerImageName", "role"] {
        if !truthy(p.get(k)) {
            p[k] = json!("");
        }
    }
    if p.get("stageStation").is_none_or(Value::is_null) {
        p["stageStation"] = json!("");
    }
}

/// ensureLibrary(game).
pub fn ensure_library(game: &mut Value) {
    if !game.get("rosterLibrary").is_some_and(|l| l.get("teams").is_some_and(Value::is_array)) {
        game["rosterLibrary"] = json!({ "teams": [] });
    }
    if !truthy(game.get("rosterAssign")) {
        game["rosterAssign"] = json!({ "home": "", "away": "" });
    }
    for t in game["rosterLibrary"]["teams"].as_array_mut().unwrap() {
        if !t["players"].is_array() {
            t["players"] = json!([]);
        }
        for p in t["players"].as_array_mut().unwrap() {
            normalize_player(p);
        }
    }
}

/// createTeam(game, { name, shortName, isISU, color }) -> team id.
pub fn create_team(game: &mut Value, name: &str, short: &str, is_isu: bool, color: &str) -> String {
    ensure_library(game);
    let id = new_id("t");
    let n = clean(Some(&json!(name)), 40);
    let color = if color.is_empty() { if is_isu { "#f47920" } else { "#5e6673" } } else { color };
    game["rosterLibrary"]["teams"].as_array_mut().unwrap().push(json!({ "id": id, "name": if n.is_empty() { "NEW TEAM".into() } else { n }, "shortName": clean(Some(&json!(short)), 6).to_uppercase(), "isISU": is_isu, "color": color, "logoImage": "", "logoImageName": "", "players": [] }));
    id
}

/// findTeam(game, id) index.
pub fn find_team(game: &mut Value, id: &str) -> Option<usize> {
    ensure_library(game);
    game["rosterLibrary"]["teams"].as_array().unwrap().iter().position(|t| t["id"].as_str() == Some(id))
}

/// addPlayer(team, fields).
pub fn add_player(team: &mut Value, fields: &Value) -> Value {
    let mut p = json!({ "status": "sub", "program": "varsity" });
    for (k, v) in fields.as_object().cloned().unwrap_or_default() {
        p[k] = v;
    }
    p["id"] = json!("");
    normalize_player(&mut p);
    team["players"].as_array_mut().unwrap().push(p.clone());
    p
}

/// parseBulk(text).
pub fn parse_bulk(text: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for line in text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)) {
        if line.trim().is_empty() {
            continue;
        }
        let cells: Vec<String> = line.split(['\t', ',', ';']).map(|c| c.trim().to_string()).collect();
        let mut p = json!({ "handle": cells.first().cloned().unwrap_or_default(), "name": cells.get(1).cloned().unwrap_or_default() });
        for c in cells.iter().skip(2) {
            let w = c.to_lowercase();
            match w.as_str() {
                "starter" | "start" | "s" => p["status"] = json!("starter"),
                "6th" | "sixth" | "6" | "6th man" | "sixth man" => p["status"] = json!("sixth"),
                "sub" | "substitute" | "reserve" | "bench" => p["status"] = json!("sub"),
                "coach" | "c" | "head coach" | "assistant coach" => p["status"] = json!("coach"),
                "jv" | "junior varsity" => p["program"] = json!("jv"),
                "v" | "varsity" => p["program"] = json!("varsity"),
                _ => {}
            }
        }
        if p["handle"] != "" || p["name"] != "" {
            out.push(p);
        }
    }
    out
}

pub fn bulk_add(team: &mut Value, text: &str) -> Vec<Value> {
    parse_bulk(text).iter().map(|p| add_player(team, p)).collect()
}

/// setForPlayers(team, ids, field, value) -> count.
pub fn set_for_players(team: &mut Value, ids: &[String], field: &str, value: &Value) -> usize {
    let mut n = 0;
    for p in team["players"].as_array_mut().into_iter().flatten() {
        if p["id"].as_str().is_some_and(|i| ids.iter().any(|x| x == i)) && p.get(field) != Some(value) {
            p[field] = value.clone();
            n += 1;
        }
    }
    n
}

pub fn remove_players(team: &mut Value, ids: &[String]) -> usize {
    let arr = team["players"].as_array_mut().unwrap();
    let before = arr.len();
    arr.retain(|p| !p["id"].as_str().is_some_and(|i| ids.iter().any(|x| x == i)));
    before - arr.len()
}

/// sortedPlayers(team, program): status order, then original order.
pub fn sorted_players(team: &Value, program: Option<&str>) -> Vec<Value> {
    let mut v: Vec<(usize, Value)> = team["players"].as_array().into_iter().flatten().cloned().enumerate().filter(|(_, p)| program.is_none_or(|pr| p["program"].as_str() == Some(pr))).collect();
    v.sort_by(|a, b| order(a.1["status"].as_str().unwrap_or("")).cmp(&order(b.1["status"].as_str().unwrap_or(""))).then(a.0.cmp(&b.0)));
    v.into_iter().map(|(_, p)| p).collect()
}

/// buildMatchRoster(team, program, previous, emptyPlayer, minSlots).
pub fn build_match_roster(team: &Value, program: &str, previous: &[Value], empty: &dyn Fn(usize) -> Value, min_slots: usize) -> Vec<Value> {
    let keep = |h: &str| previous.iter().rev().find(|p| truthy(p.get("handle")) && js_string(p.get("handle")).to_lowercase() == h.to_lowercase()).cloned();
    let mut out: Vec<Value> = sorted_players(team, Some(program))
        .into_iter()
        .filter(|p| p["status"] != "coach")
        .enumerate()
        .map(|(i, lp)| {
            let handle = js_string(lp.get("handle"));
            let old = keep(&handle).unwrap_or(json!({}));
            let mut p = empty(i);
            for (k, v) in old.as_object().cloned().unwrap_or_default() {
                p[k] = v;
            }
            let or = |a: &Value, b: Option<&Value>| if truthy(Some(a)) { a.clone() } else if b.is_some_and(|x| truthy(Some(x))) { b.unwrap().clone() } else { json!("") };
            p["handle"] = lp["handle"].clone();
            p["name"] = lp["name"].clone();
            p["playerImage"] = or(&lp["playerImage"], old.get("playerImage"));
            p["playerImageName"] = or(&lp["playerImageName"], old.get("playerImageName"));
            p["role"] = if truthy(lp.get("role")) { lp["role"].clone() } else if truthy(old.get("role")) { old["role"].clone() } else { empty(i)["role"].clone() };
            p["stageStation"] = if lp["stageStation"] != "" { lp["stageStation"].clone() } else { old.get("stageStation").filter(|v| !v.is_null()).cloned().unwrap_or(json!("")) };
            p["libraryId"] = lp["id"].clone();
            p["libraryStatus"] = lp["status"].clone();
            p["autoAdded"] = json!(false);
            p
        })
        .collect();
    while out.len() < min_slots {
        let n = out.len();
        out.push(empty(n));
    }
    out
}

/// loadTeamIntoMatch(game, side, teamId, { emptyPlayer, rosterSize }).
pub fn load_team_into_match(game: &mut Value, side: &str, team_id: &str, empty: &dyn Fn(usize) -> Value, roster_size: usize) -> bool {
    let Some(ti) = find_team(game, team_id) else { return false };
    let team = game["rosterLibrary"]["teams"][ti].clone();
    let key = if side == "away" { "awayRosters" } else { "rosters" };
    if !truthy(game.get(key)) {
        game[key] = json!({ "varsity": [], "jv": [] });
    }
    for program in PROGRAMS {
        let prev = game[key][program].as_array().cloned().unwrap_or_default();
        game[key][program] = Value::Array(build_match_roster(&team, program, &prev, empty, roster_size));
    }
    let t = &mut game["teams"][if side == "away" { 1 } else { 0 }];
    t["name"] = team["name"].clone();
    if truthy(team.get("shortName")) {
        t["shortName"] = team["shortName"].clone();
    }
    if truthy(team.get("color")) {
        t["color"] = team["color"].clone();
    }
    if truthy(team.get("logoImage")) {
        t["logoImage"] = team["logoImage"].clone();
        t["logoImageName"] = team["logoImageName"].clone();
    }
    if !truthy(game.get("coaches")) {
        game["coaches"] = json!({ "home": [], "away": [] });
    }
    game["coaches"][side] = Value::Array(team["players"].as_array().into_iter().flatten().filter(|p| p["status"] == "coach").map(|p| json!({ "handle": p["handle"], "name": p["name"], "playerImage": p["playerImage"], "program": p["program"] })).collect());
    game["rosterAssign"][side] = json!(team_id);
    if side == "away" && team["players"].as_array().is_some_and(|p| !p.is_empty()) {
        game["showAwayRoster"] = json!(true);
    }
    true
}

/// isuSide(game): 'home' | 'away' | ''.
pub fn isu_side(game: &mut Value) -> &'static str {
    for side in ["home", "away"] {
        let id = game.pointer(&format!("/rosterAssign/{side}")).and_then(Value::as_str).unwrap_or("").to_string();
        if let Some(i) = find_team(game, &id) {
            if truthy(game["rosterLibrary"]["teams"][i].get("isISU")) {
                return side;
            }
        }
    }
    let is_isu = |t: &Value| {
        let short = t.get("shortName").and_then(Value::as_str).unwrap_or("").to_uppercase();
        let name = t.get("name").and_then(Value::as_str).unwrap_or("").to_uppercase();
        // /(^|\s)ISU($|\s)/i: ISU bounded by start/whitespace and end/whitespace; /IDAHO STATE/i
        let c: Vec<char> = short.chars().collect();
        let word = (0..c.len()).any(|i| {
            c[i..].starts_with(&['I', 'S', 'U']) && (i == 0 || c[i - 1].is_whitespace()) && (i + 3 == c.len() || c[i + 3].is_whitespace())
        });
        word || name.contains("IDAHO STATE")
    };
    match game["teams"].as_array().and_then(|t| t.iter().position(is_isu)) {
        Some(1) => "away",
        Some(0) => "home",
        _ => "",
    }
}

/// writeBackFromMatch(game, side): portrait / station / name edits flow back to the library.
pub fn write_back_from_match(game: &mut Value, side: &str) -> usize {
    let id = game.pointer(&format!("/rosterAssign/{side}")).and_then(Value::as_str).unwrap_or("").to_string();
    let Some(ti) = find_team(game, &id) else { return 0 };
    let key = if side == "away" { "awayRosters" } else { "rosters" };
    let mut n = 0;
    for program in PROGRAMS {
        let mps = game[key][program].as_array().cloned().unwrap_or_default();
        for mp in mps {
            let players = game["rosterLibrary"]["teams"][ti]["players"].as_array_mut().unwrap();
            let Some(lp) = players.iter_mut().find(|p| mp.get("libraryId").is_some_and(|l| *l == p["id"])) else { continue };
            for f in ["playerImage", "playerImageName", "stageStation", "name"] {
                if let Some(v) = mp.get(f) {
                    if lp.get(f) != Some(v) && v != "" {
                        lp[f] = v.clone();
                        n += 1;
                    }
                }
            }
        }
    }
    n
}

#[derive(Debug, Clone, PartialEq)]
pub struct Link {
    pub name: String,
    pub row: Value,
    pub block: String,
    pub agent: String,
    pub score: f64,
    pub linked: bool,
}

/// liveLinks(roster, boardPlayers, tagSimilarity, threshold = 0.9): roster index -> link.
pub fn live_links(roster: &[Value], board: &[Value], threshold: f64) -> Vec<(usize, Link)> {
    let rows: Vec<&Value> = board.iter().filter(|r| truthy(r.get("name"))).collect();
    let mut pairs = Vec::new();
    for (pi, p) in roster.iter().enumerate() {
        if truthy(p.get("handle")) {
            for (ri, r) in rows.iter().enumerate() {
                pairs.push((pi, ri, tag_similarity(&js_string(p.get("handle")), &js_string(r.get("name")))));
            }
        }
    }
    pairs.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    let (mut up, mut ur, mut out) = (Vec::new(), Vec::new(), Vec::new());
    for (pi, ri, sc) in pairs {
        if up.contains(&pi) || ur.contains(&ri) || sc < 0.5 {
            continue;
        }
        up.push(pi);
        ur.push(ri);
        let r = rows[ri];
        out.push((pi, Link { name: js_string(r.get("name")), row: r.get("row").cloned().unwrap_or(Value::Null), block: if truthy(r.get("block")) { js_string(r.get("block")) } else { String::new() }, agent: if truthy(r.get("agent")) { js_string(r.get("agent")) } else { String::new() }, score: sc, linked: sc >= threshold }));
    }
    out
}
