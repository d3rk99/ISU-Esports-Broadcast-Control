//! Controller-side scoreboard logic (no UI): src/valorant-board-teams.js (team mapping),
//! src/valorant-board-panel.js (syncValorantRoster, agentNameFromSlug, emptyValorantBoard,
//! mergeValorantBoardSnapshot), src/overwatch-ocr-panel.js (matchRosterToOcr, syncRosterFromOcr),
//! and the VALORANT round timeline of src/app.js (syncValorantOcrScores and helpers).
use serde_json::{Map, Value, json};

use crate::game_config::{data, jnum, js_round, js_string, num_or_zero, to_number, truthy};
use crate::tags::{NAME_MATCH, tag_similarity};

fn s(v: Option<&Value>) -> String {
    if truthy(v) { js_string(v) } else { String::new() }
}

// ------------------------------------------------------------- team mapping ---

pub const TEAM_MATCH: f64 = 0.8;

fn roster_tags(game: &Value, side: &str) -> Vec<String> {
    let coll = if side == "home" { "rosters" } else { "awayRosters" };
    let mut out = Vec::new();
    for key in ["varsity", "jv"] {
        for p in game.get(coll).and_then(|r| r.get(key)).and_then(Value::as_array).into_iter().flatten() {
            let t = s(p.get("handle")).trim().to_string();
            if !t.is_empty() {
                out.push(t);
            }
        }
    }
    out
}

fn votes(block: &[Value], tags: &[String]) -> usize {
    block.iter().filter(|p| truthy(p.get("name")) && tags.iter().any(|t| tag_similarity(&js_string(p.get("name")), t) >= TEAM_MATCH)).count()
}

/// currentRound(game).
pub fn current_round(game: &Value) -> f64 {
    let active = to_number(game.get("activeMap")).filter(|x| *x != 0.0).unwrap_or(0.0) as i64;
    if let Some(o) = to_number(game.get("valorantRoundOverride").and_then(|o| o.get(active.to_string()))) {
        if o == o.trunc() && (1.0..=100.0).contains(&o) {
            return o;
        }
    }
    let m = game.pointer("/valorantBoard/live/match");
    if let (Some(h), Some(a)) = (m.and_then(|x| x.get("homeScore")).and_then(Value::as_f64), m.and_then(|x| x.get("awayScore")).and_then(Value::as_f64)) {
        return h + a + 1.0;
    }
    num_or_zero(game.pointer("/teams/0/detailScore")) + num_or_zero(game.pointer("/teams/1/detailScore")) + 1.0
}

/// attackingTeamNow(game): 'home' | 'away' | ''.
pub fn attacking_team_now(game: &Value) -> &'static str {
    let active = to_number(game.get("activeMap")).filter(|x| *x != 0.0).unwrap_or(0.0) as i64;
    let Some(pick) = game.pointer(&format!("/veto/picks/{active}")).filter(|p| truthy(Some(p))) else { return "" };
    let a = pick.get("attackers");
    let ok = matches!(a, Some(Value::Number(n)) if n.as_f64() == Some(0.0) || n.as_f64() == Some(1.0)) || matches!(a, Some(Value::String(x)) if x == "0" || x == "1");
    if !ok {
        return "";
    }
    let first = if to_number(a) == Some(1.0) { "away" } else { "home" };
    let r = current_round(game);
    let swapped = if r <= 12.0 { false } else if r <= 24.0 { true } else { ((r - 25.0) % 2.0) == 1.0 };
    if swapped { if first == "home" { "away" } else { "home" } } else { first }
}

/// decideBlocks(game, board, previous) -> { top, by, detail }.
pub fn decide_blocks(game: &Value, board: &Value, previous: Option<&Value>) -> Value {
    let top: Vec<Value> = board.pointer("/teams/home/players").and_then(Value::as_array).cloned().unwrap_or_default();
    let bottom: Vec<Value> = board.pointer("/teams/away/players").and_then(Value::as_array).cloned().unwrap_or_default();
    let (ht, at) = (roster_tags(game, "home"), roster_tags(game, "away"));
    let straight = votes(&top, &ht) + votes(&bottom, &at);
    let crossed = votes(&top, &at) + votes(&bottom, &ht);
    let detail = format!("names {straight}:{crossed}");
    if straight >= 2 && straight >= crossed + 2 {
        return json!({ "top": "home", "by": "names", "detail": detail });
    }
    if crossed >= 2 && crossed >= straight + 2 {
        return json!({ "top": "away", "by": "names", "detail": detail });
    }
    let attacking = attacking_team_now(game);
    let colors = board.get("colors").cloned().unwrap_or(json!({}));
    let (ch, ca) = (colors.get("home").and_then(Value::as_str).unwrap_or(""), colors.get("away").and_then(Value::as_str).unwrap_or(""));
    if !attacking.is_empty() && (ch == "red" || ca == "red" || ch == "teal" || ca == "teal") {
        let top_attackers = ch == "red" || ca == "teal";
        let top_team = if top_attackers { attacking } else if attacking == "home" { "away" } else { "home" };
        return json!({ "top": top_team, "by": "sides", "detail": format!("{detail}, {attacking} attacking, top block {}", if ch.is_empty() { "?" } else { ch }) });
    }
    if let Some(t) = previous.and_then(|p| p.get("top")).filter(|t| truthy(Some(t))) {
        return json!({ "top": t, "by": "kept", "detail": detail });
    }
    json!({ "top": "home", "by": "default", "detail": detail })
}

/// mapBoardToTeams(game, board, previous) -> (board by team, decision).
pub fn map_board_to_teams(game: &Value, board: &Value, previous: Option<&Value>) -> (Value, Value) {
    if !board.get("teams").is_some_and(|t| truthy(Some(t))) {
        return (board.clone(), previous.cloned().unwrap_or(json!({ "top": "home", "by": "default", "detail": "" })));
    }
    let decision = decide_blocks(game, board, previous);
    let tag = |block: &str| -> Value {
        Value::Array(board.pointer(&format!("/teams/{block}/players")).and_then(Value::as_array).into_iter().flatten().map(|p| { let mut q = p.clone(); q["block"] = json!(if block == "home" { "top" } else { "bottom" }); q }).collect())
    };
    let top_team = decision["top"].as_str().unwrap_or("home").to_string();
    let bottom_team = if top_team == "home" { "away" } else { "home" };
    let mut out = board.clone();
    let mut teams = Map::new();
    teams.insert(top_team.clone(), json!({ "players": tag("home") }));
    teams.insert(bottom_team.into(), json!({ "players": tag("away") }));
    out["teams"] = Value::Object(teams);
    out["blocks"] = json!({ "top": top_team, "bottom": bottom_team });
    (out, decision)
}

// ------------------------------------------------------------- roster sync ---

/// matchRosterToOcr(roster, rows, threshold): best one-to-one pairs (pi, ri, score).
pub fn match_roster_to_ocr(roster: &[Value], rows: &[Value], threshold: f64) -> Vec<(usize, usize, f64)> {
    let mut pairs = Vec::new();
    for (pi, p) in roster.iter().enumerate() {
        if !truthy(p.get("handle")) {
            continue;
        }
        for (ri, r) in rows.iter().enumerate() {
            if !truthy(r.get("name")) {
                continue;
            }
            let sc = tag_similarity(&js_string(p.get("handle")), &js_string(r.get("name")));
            if sc >= threshold {
                pairs.push((pi, ri, sc));
            }
        }
    }
    pairs.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    let (mut up, mut ur, mut out) = (Vec::new(), Vec::new(), Vec::new());
    for (pi, ri, sc) in pairs {
        if up.contains(&pi) || ur.contains(&ri) {
            continue;
        }
        up.push(pi);
        ur.push(ri);
        out.push((pi, ri, sc));
    }
    out
}

fn is_empty_slot(p: &Value) -> bool {
    s(p.get("handle")).trim().is_empty() && s(p.get("name")).trim().is_empty()
}

fn apply(changes: &mut Vec<Value>, side: &str, player: &mut Value, field: &str, value: &str) {
    if value.is_empty() || player.get(field).and_then(Value::as_str) == Some(value) {
        return;
    }
    changes.push(json!({ "side": side, "handle": s(player.get("handle")), "field": field, "from": s(player.get(field)), "to": value }));
    player[field] = json!(value);
}

fn role_of(table: &str, key: &str) -> String {
    data()[table].get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// agentNameFromSlug(s): 'kay-o' -> 'KAY/O'.
pub fn agent_name_from_slug(slug: &str) -> String {
    let sl = |n: &str| {
        let mut o = String::new();
        for c in n.to_lowercase().chars() {
            if c.is_ascii_lowercase() || c.is_ascii_digit() { o.push(c) } else if !o.ends_with('-') { o.push('-') }
        }
        o.trim_matches('-').to_string()
    };
    data()["valorantAgentRoles"].as_object().unwrap().keys().find(|n| sl(n) == slug).cloned().unwrap_or_default()
}

/// syncRosterFromOcr(game, rosterKey) (Overwatch) -> changes.
pub fn sync_roster_from_ocr(game: &mut Value, roster_key: &str, fill_empty: bool) -> Vec<Value> {
    let Some(live) = game.pointer("/overwatchOcr/live/teams").filter(|v| truthy(Some(v))).cloned() else { return Vec::new() };
    let mut changes = Vec::new();
    for (side, coll) in [("home", "rosters"), ("away", "awayRosters")] {
        let Some(roster) = game.get_mut(coll).and_then(|r| r.get_mut(roster_key)).and_then(Value::as_array_mut) else { continue };
        let rows = live.pointer(&format!("/{side}/players")).and_then(Value::as_array).cloned().unwrap_or_default();
        let pairs = match_roster_to_ocr(roster, &rows, NAME_MATCH);
        let matched: Vec<usize> = pairs.iter().map(|p| p.1).collect();
        for (pi, ri, _) in &pairs {
            let hero = s(rows[*ri].get("hero"));
            apply(&mut changes, side, &mut roster[*pi], "character", &hero);
            apply(&mut changes, side, &mut roster[*pi], "role", &role_of("overwatchHeroRoles", &hero));
        }
        if !fill_empty {
            continue;
        }
        for (ri, row) in rows.iter().enumerate() {
            if matched.contains(&ri) || !truthy(row.get("name")) {
                continue;
            }
            let Some(slot) = roster.iter_mut().find(|p| is_empty_slot(p)) else { break };
            let name = js_string(row.get("name"));
            changes.push(json!({ "side": side, "handle": name, "field": "handle", "from": "", "to": name }));
            slot["handle"] = json!(name);
            slot["autoAdded"] = json!(true);
            let hero = s(row.get("hero"));
            apply(&mut changes, side, slot, "character", &hero);
            apply(&mut changes, side, slot, "role", &role_of("overwatchHeroRoles", &hero));
        }
    }
    changes
}

/// syncValorantRoster(game, rosterKey): agents + roles by gamertag; a pre-set roster never gets
/// board names added; an empty one fills from the board but never with a near-copy (>= 60%).
pub fn sync_valorant_roster(game: &mut Value, roster_key: &str, fill_empty: bool) -> Vec<Value> {
    let Some(live) = game.pointer("/valorantBoard/live/teams").filter(|v| truthy(Some(v))).cloned() else { return Vec::new() };
    let mut changes = Vec::new();
    for (side, coll) in [("home", "rosters"), ("away", "awayRosters")] {
        let Some(roster) = game.get_mut(coll).and_then(|r| r.get_mut(roster_key)).and_then(Value::as_array_mut) else { continue };
        let rows: Vec<Value> = live.pointer(&format!("/{side}/players")).and_then(Value::as_array).into_iter().flatten().map(|r| { let mut q = r.clone(); q["agentName"] = json!(agent_name_from_slug(&s(r.get("agent")))); q }).collect();
        let pairs = match_roster_to_ocr(roster, &rows, NAME_MATCH);
        let matched: Vec<usize> = pairs.iter().map(|p| p.1).collect();
        for (pi, ri, _) in &pairs {
            let agent = s(rows[*ri].get("agentName"));
            apply(&mut changes, side, &mut roster[*pi], "character", &agent);
            apply(&mut changes, side, &mut roster[*pi], "role", &role_of("valorantAgentRoles", &agent));
        }
        if !fill_empty {
            continue;
        }
        let preset = roster.iter().any(|p| !s(p.get("handle")).trim().is_empty() && !truthy(p.get("autoAdded")));
        if preset {
            continue;
        }
        for (ri, row) in rows.iter().enumerate() {
            if matched.contains(&ri) || !truthy(row.get("name")) {
                continue;
            }
            let name = js_string(row.get("name"));
            if roster.iter().any(|p| truthy(p.get("handle")) && tag_similarity(&js_string(p.get("handle")), &name) >= 0.6) {
                continue;
            }
            let Some(slot) = roster.iter_mut().find(|p| is_empty_slot(p)) else { break };
            changes.push(json!({ "side": side, "handle": name, "field": "handle", "from": "", "to": name }));
            slot["handle"] = json!(name);
            slot["autoAdded"] = json!(true);
            let agent = s(row.get("agentName"));
            apply(&mut changes, side, slot, "character", &agent);
            apply(&mut changes, side, slot, "role", &role_of("valorantAgentRoles", &agent));
        }
    }
    changes
}

// ---------------------------------------------------------- round timeline ---

fn empty_round(round: usize) -> Value {
    json!({ "round": round, "winnerRow": null, "winnerRole": null, "method": null, "current": false, "locked": false, "manual": false, "confidence": 0, "updatedAt": null })
}

fn merge(base: Value, over: Option<&Value>) -> Value {
    let mut b = base;
    if let Some(Value::Object(o)) = over {
        for (k, v) in o {
            b[k] = v.clone();
        }
    }
    b
}

/// ensureValorantRoundTimeline() on game (valorantOcr.live.observer3.roundTimeline).
fn ensure_timeline(game: &mut Value) {
    let ocr = &mut game["valorantOcr"];
    let mut live = ocr.get("live").filter(|v| truthy(Some(v))).cloned().unwrap_or(json!({}));
    let mut o3 = live.get("observer3").filter(|v| truthy(Some(v))).cloned().unwrap_or(json!({}));
    let ex = o3.get("roundTimeline").filter(|v| truthy(Some(v))).cloned().unwrap_or(json!({}));
    let rounds: Vec<Value> = (0..24).map(|i| merge(empty_round(i + 1), ex.pointer(&format!("/rounds/{i}")).filter(|v| truthy(Some(v))))).collect();
    let current = match ex.get("currentRound") { None | Some(Value::Null) => Value::Null, Some(v) => v.clone() };
    o3["roundTimeline"] = json!({
        "currentRound": current,
        "topRole": if truthy(ex.get("topRole")) { ex["topRole"].clone() } else { json!("defense") },
        "bottomRole": if truthy(ex.get("bottomRole")) { ex["bottomRole"].clone() } else { json!("attack") },
        "sideSwapAfter": if truthy(ex.get("sideSwapAfter")) { ex["sideSwapAfter"].clone() } else { json!(12) },
        "rounds": rounds
    });
    live["observer3"] = o3;
    ocr["live"] = live;
}

fn timeline(game: &mut Value) -> &mut Value {
    &mut game["valorantOcr"]["live"]["observer3"]["roundTimeline"]
}

fn refresh_current(game: &mut Value, home: f64, away: f64) {
    ensure_timeline(game);
    let cur = (home + away + 1.0).clamp(1.0, 24.0);
    let t = timeline(game);
    t["currentRound"] = jnum(cur);
    let rounds: Vec<Value> = t["rounds"].as_array().unwrap().iter().enumerate().map(|(i, r)| {
        let mut x = merge(empty_round(i + 1), Some(r).filter(|v| truthy(Some(v))));
        x["current"] = json!(cur == (i + 1) as f64 && !truthy(r.get("winnerRole")));
        x
    }).collect();
    t["rounds"] = Value::Array(rounds);
}

fn round_swapped(round: f64) -> bool {
    let r = if round != 0.0 && round.is_finite() { round } else { 1.0 };
    if r <= 12.0 { false } else if r <= 24.0 { true } else { ((r - 25.0) % 2.0) == 1.0 }
}

fn role_for(winner: &str, round: f64) -> Option<&'static str> {
    if winner != "home" && winner != "away" {
        return None;
    }
    let home_role = if round_swapped(round) { "attack" } else { "defense" };
    Some(if winner == "home" { home_role } else if home_role == "defense" { "attack" } else { "defense" })
}

fn mark_winner(game: &mut Value, round_number: f64, winner: &str, now: f64) {
    ensure_timeline(game);
    let idx = (js_round(if round_number != 0.0 && round_number.is_finite() { round_number } else { 1.0 }) - 1.0).clamp(0.0, 23.0) as usize;
    let t = timeline(game);
    let existing = merge(empty_round(idx + 1), t.pointer(&format!("/rounds/{idx}")).filter(|v| truthy(Some(v))));
    if truthy(existing.get("manual")) {
        return;
    }
    let role = role_for(winner, (idx + 1) as f64);
    let mut r = existing;
    r["winnerSide"] = if winner == "home" || winner == "away" { json!(winner) } else { Value::Null };
    r["winnerRow"] = match winner { "home" => json!("top"), "away" => json!("bottom"), _ => Value::Null };
    r["winnerRole"] = role.map_or(Value::Null, |x| json!(x));
    r["method"] = Value::Null;
    r["current"] = json!(false);
    r["locked"] = json!(role.is_some());
    r["confidence"] = json!(if role.is_some() { 1 } else { 0 });
    r["updatedAt"] = jnum(now);
    t["rounds"][idx] = r;
}

fn history_from_score(game: &mut Value, ph: f64, pa: f64, nh: f64, na: f64, now: f64) {
    let (pt, nt) = (ph + pa, nh + na);
    if nt <= pt {
        return refresh_current(game, nh, na);
    }
    let (hd, ad) = (nh - ph, na - pa);
    let winner = if hd > 0.0 && ad == 0.0 { "home" } else if ad > 0.0 && hd == 0.0 { "away" } else { "" };
    if !winner.is_empty() {
        let mut r = pt + 1.0;
        while r <= nt {
            mark_winner(game, r, winner, now);
            r += 1.0;
        }
    }
    refresh_current(game, nh, na);
}

/// liveValorantScore(snapshot, side): 0..24 rounded, else None.
fn live_score(snap: &Value, side: &str) -> Option<f64> {
    let v = snap.pointer(&format!("/teams/{side}/score")).filter(|v| !v.is_null()).or_else(|| snap.pointer(&format!("/fields/{side}Score/value")));
    let n = to_number(v)?;
    (n.is_finite() && (0.0..=24.0).contains(&n)).then(|| js_round(n))
}

/// syncValorantOcrScores(snapshot) on the valorant game -> changed. Never goes backwards; a jump
/// from 0-0 to more than 2 rounds is ignored (a misread).
pub fn sync_valorant_ocr_scores(game: &mut Value, snap: &Value, now: f64) -> bool {
    let (Some(h), Some(a)) = (live_score(snap, "home"), live_score(snap, "away")) else { return false };
    let ch = num_or_zero(game.pointer("/teams/0/detailScore"));
    let ca = num_or_zero(game.pointer("/teams/1/detailScore"));
    if ch + ca == 0.0 && h + a > 2.0 {
        return false;
    }
    if h < ch || a < ca {
        return false;
    }
    let mut changed = false;
    if game["teams"][0]["detailScore"] != jnum(h) {
        game["teams"][0]["detailScore"] = jnum(h);
        changed = true;
    }
    if game["teams"][1]["detailScore"] != jnum(a) {
        game["teams"][1]["detailScore"] = jnum(a);
        changed = true;
    }
    if changed { history_from_score(game, ch, ca, h, a, now) } else { refresh_current(game, h, a) }
    changed
}

/// resetValorantRoundHistory() (the controller's own button).
pub fn reset_round_history(game: &mut Value) {
    let active = to_number(game.get("activeMap")).filter(|x| *x != 0.0).unwrap_or(0.0) as i64;
    if let Some(o) = game.get_mut("valorantRoundOverride").filter(|v| truthy(Some(v))).and_then(Value::as_object_mut) {
        o.remove(&active.to_string());
    }
    ensure_timeline(game);
    let t = timeline(game);
    t["currentRound"] = json!(1);
    t["rounds"] = Value::Array((0..24).map(|i| { let mut r = empty_round(i + 1); r["current"] = json!(i == 0); r }).collect());
}
