//! Companion / controller actions: src/companion-actions.js, one function per JS function.
use serde_json::{Map, Value, json};

use crate::display_presets::apply_display_preset;
use crate::game_config::{config, jnum, js_round, js_string, num_or_zero, rocket_league_arena_name, to_number, truthy};
use crate::tags::{NAME_MATCH, tag_similarity};

/// actionError(message, statusCode).
#[derive(Debug, Clone, PartialEq)]
pub struct ActionError {
    pub message: String,
    pub status: u16,
}

impl ActionError {
    fn new(m: impl Into<String>) -> Self {
        Self { message: m.into(), status: 400 }
    }
}

type R<T> = Result<T, ActionError>;

/// teamIndex(value): 'home' | 0 | '0' -> 0, 'away' | 1 | '1' -> 1.
fn team_index(v: Option<&Value>) -> R<usize> {
    match v {
        Some(Value::String(s)) if s == "home" || s == "0" => Ok(0),
        Some(Value::String(s)) if s == "away" || s == "1" => Ok(1),
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => Ok(0),
        Some(Value::Number(n)) if n.as_f64() == Some(1.0) => Ok(1),
        _ => Err(ActionError::new("team must be home or away")),
    }
}

/// wholeNumber(value, label, { min, max, fallback }).
fn whole_number(v: Option<&Value>, label: &str, min: f64, max: f64, fallback: Option<f64>) -> R<f64> {
    let n = match (v, fallback) {
        (None, Some(f)) => Some(f),
        _ => to_number(v),
    };
    match n {
        Some(n) if n.is_finite() => Ok(js_round(n).clamp(min, max).max(min)),
        _ => Err(ActionError::new(format!("{label} must be a number"))),
    }
}

fn arr(v: &mut Value) -> &mut Vec<Value> {
    if !v.is_array() {
        *v = json!([]);
    }
    v.as_array_mut().unwrap()
}

/// winner 0/1 swap helper: row.winner === 0 ? 1 : 0 (null stays null).
fn is_null_winner(v: &Value) -> bool {
    v.is_null()
}

/// swapGameTeams(game).
pub fn swap_game_teams(game: &mut Value) {
    if let Some(t) = game.get_mut("teams").and_then(Value::as_array_mut) {
        t.reverse();
    }
    let rosters = game.get("rosters").cloned().unwrap_or(Value::Null);
    let away = game.get("awayRosters").cloned().unwrap_or(Value::Null);
    game["rosters"] = away;
    game["awayRosters"] = rosters;
    if let Some(board) = game.pointer_mut("/valorantBoard/live").filter(|b| b.get("teams").is_some_and(truthy_val)) {
        let teams = board["teams"].as_object_mut().unwrap();
        let h = teams.remove("home");
        let a = teams.remove("away");
        // JS destructuring swap: [home, away] = [away, home] (undefined stays undefined -> key present as undefined; dropped in JSON)
        if let Some(a) = a {
            teams.insert("home".into(), a);
        }
        if let Some(h) = h {
            teams.insert("away".into(), h);
        }
        if let Some(blocks) = board.get_mut("blocks").filter(|b| truthy_val(b)).and_then(Value::as_object_mut) {
            for block in ["top", "bottom"] {
                if let Some(v) = blocks.get(block).filter(|v| truthy_val(v)) {
                    let next = if v.as_str() == Some("home") { "away" } else { "home" };
                    blocks.insert(block.into(), json!(next));
                }
            }
        }
    }
    let first = game.get("rosterFirstSide").and_then(Value::as_str) == Some("away");
    game["rosterFirstSide"] = json!(if first { "home" } else { "away" });
    if let Some(rows) = game.get_mut("mapRows").and_then(Value::as_array_mut) {
        for row in rows {
            arr(&mut row["score"]).reverse();
            let w = row.get("winner").cloned().unwrap_or(Value::Null);
            // JS: if (row.winner !== null) — undefined counts as "not null" there.
            if row.get("winner").is_none() || !is_null_winner(&w) {
                row["winner"] = json!(if w.as_f64() == Some(0.0) { 1 } else { 0 });
            }
        }
    }
    if let Some(picks) = game.pointer_mut("/veto/picks").and_then(Value::as_array_mut) {
        for pick in picks {
            let zero = to_number(pick.get("attackers")) == Some(0.0);
            pick["attackers"] = json!(if zero { 1 } else { 0 });
        }
    }
}

fn truthy_val(v: &Value) -> bool {
    truthy(Some(v))
}

/// swapGameTeamsPreservingSideScores(game).
pub fn swap_game_teams_preserving_side_scores(game: &mut Value) {
    let side: Vec<(f64, f64)> = game["teams"]
        .as_array()
        .map(|t| t.iter().map(|x| (num_or_zero(x.get("score")), num_or_zero(x.get("detailScore")))).collect())
        .unwrap_or_default();
    swap_game_teams(game);
    if let Some(teams) = game.get_mut("teams").and_then(Value::as_array_mut) {
        for (i, team) in teams.iter_mut().enumerate() {
            if let Some((s, d)) = side.get(i) {
                team["score"] = jnum(*s);
                team["detailScore"] = jnum(*d);
            }
        }
    }
}

fn reset_detail_scores(game: &mut Value, game_key: &str) {
    let v = if game_key == "smash" { 12 } else { 0 };
    for team in game["teams"].as_array_mut().into_iter().flatten() {
        team["detailScore"] = json!(v);
    }
}

/// resetValorantRoundTimeline(game).
pub fn reset_valorant_round_timeline(game: &mut Value) {
    let active = active_map(game);
    if let Some(o) = game.get_mut("valorantRoundOverride").filter(|v| truthy_val(v)).and_then(Value::as_object_mut) {
        o.remove(&active.to_string());
    }
    let Some(ocr) = game.get_mut("valorantOcr").filter(|v| truthy_val(v)) else { return };
    let mut live = ocr.get("live").filter(|v| truthy_val(v)).cloned().unwrap_or(json!({}));
    let mut observer3 = live.get("observer3").filter(|v| truthy_val(v)).cloned().unwrap_or(json!({}));
    let mut timeline = observer3.get("roundTimeline").filter(|v| truthy_val(v)).cloned().unwrap_or(json!({}));
    let rounds: Vec<Value> = (0..24)
        .map(|i| {
            json!({ "round": i + 1, "winnerRow": null, "winnerRole": null, "winnerSide": null, "method": null,
                    "current": i == 0, "locked": false, "manual": false, "confidence": 0, "updatedAt": null })
        })
        .collect();
    if !timeline.is_object() {
        timeline = json!({});
    }
    timeline["currentRound"] = json!(1);
    timeline["rounds"] = Value::Array(rounds);
    if !observer3.is_object() {
        observer3 = json!({});
    }
    observer3["roundTimeline"] = timeline;
    if !live.is_object() {
        live = json!({});
    }
    live["observer3"] = observer3;
    ocr["live"] = live;
}

fn active_map(game: &Value) -> i64 {
    // game.activeMap || 0
    to_number(game.get("activeMap")).filter(|x| *x != 0.0).map(|x| x as i64).unwrap_or(0)
}

fn reset_all_scores(game: &mut Value, game_key: &str) {
    reset_detail_scores(game, game_key);
    for team in game["teams"].as_array_mut().into_iter().flatten() {
        team["score"] = json!(0);
    }
    if game_key == "valorant" || game_key == "rocketleague" {
        reset_map_results(game, game_key);
    }
    if game_key == "valorant" {
        reset_valorant_round_timeline(game);
    }
}

fn map_rows_len(game: &Value) -> usize {
    game["mapRows"].as_array().map_or(0, Vec::len)
}

/// seriesLength: Math.max(1, Number(game.seriesLength) || game.mapRows.length).
fn series_length(game: &Value) -> f64 {
    let n = to_number(game.get("seriesLength")).filter(|x| *x != 0.0).unwrap_or(map_rows_len(game) as f64);
    n.max(1.0)
}

fn series_target(game: &Value) -> f64 {
    (series_length(game) / 2.0).ceil()
}

/// visibleMapRows length: mapRows.slice(0, min(len, seriesLength)).
fn visible_len(game: &Value) -> usize {
    let len = map_rows_len(game);
    let sl = series_length(game);
    if sl.is_nan() { 0 } else { (len as f64).min(sl).max(0.0) as usize }
}

fn recount_series(game: &mut Value) {
    let vis = visible_len(game);
    let counts: Vec<usize> = (0..2)
        .map(|i| game["mapRows"].as_array().map_or(0, |r| r.iter().take(vis).filter(|row| row.get("winner").and_then(Value::as_f64) == Some(i as f64)).count()))
        .collect();
    for (i, team) in game["teams"].as_array_mut().into_iter().flatten().enumerate() {
        team["score"] = json!(counts.get(i).copied().unwrap_or(0));
    }
}

fn reset_valorant_pick_results(game: &mut Value) {
    if let Some(picks) = game.pointer_mut("/veto/picks").and_then(Value::as_array_mut) {
        for p in picks {
            p["score"] = json!(["", ""]);
            p["winner"] = Value::Null;
        }
    }
}

fn reset_map_results(game: &mut Value, game_key: &str) {
    for (i, row) in game["mapRows"].as_array_mut().into_iter().flatten().enumerate() {
        row["winner"] = Value::Null;
        row["score"] = json!(["", ""]);
        row["overtime"] = json!(false);
        row["overtimeSeconds"] = json!(0);
        if game_key == "overwatch" {
            row["map"] = json!("");
            row["mode"] = json!("");
        }
        row["status"] = json!(if i == 0 { "ready" } else { "upcoming" });
    }
    if game_key == "valorant" {
        reset_valorant_pick_results(game);
    }
    for team in game["teams"].as_array_mut().into_iter().flatten() {
        team["score"] = json!(0);
    }
    game["activeMap"] = json!(0);
}

fn save_active_map_result(game: &mut Value, game_key: &str) {
    let idx = to_number(game.get("activeMap"));
    let Some(i) = idx.filter(|x| *x >= 0.0 && *x == x.trunc()).map(|x| x as usize) else { return };
    if game["mapRows"].get(i).is_none_or(|r| !truthy_val(r)) {
        return;
    }
    let scores: Vec<f64> = game["teams"].as_array().map(|t| t.iter().map(|x| num_or_zero(x.get("detailScore"))).collect()).unwrap_or_default();
    if game_key == "rocketleague" {
        let live = game.pointer("/rocketLeague/live").cloned().unwrap_or(json!({}));
        let arena = rocket_league_arena_name(&live.get("arena").map(|v| js_string(Some(v))).filter(|_| truthy(live.get("arena"))).unwrap_or_default());
        let row = &mut game["mapRows"][i];
        if !arena.is_empty() {
            row["map"] = json!(arena);
        }
        let ot_secs = num_or_zero(live.get("overtimeSeconds")).floor().max(0.0);
        let went = truthy(live.get("overtime")) || ot_secs > 0.0;
        row["overtime"] = json!(went);
        let secs = if went {
            if ot_secs != 0.0 { ot_secs } else { num_or_zero(live.get("timeSeconds")).floor().max(0.0) }
        } else {
            0.0
        };
        row["overtimeSeconds"] = jnum(secs);
    }
    let row = &mut game["mapRows"][i];
    row["score"] = Value::Array(scores.iter().map(|s| json!(crate::game_config::num_to_js(*s))).collect());
    let (a, b) = (scores.first().copied(), scores.get(1).copied());
    let winner = if a == b { Value::Null } else { json!(u8::from(b.unwrap_or(f64::NAN) > a.unwrap_or(f64::NAN))) };
    row["status"] = json!(if winner.is_null() { "ready" } else { "complete" });
    row["winner"] = winner;
    recount_series(game);
}

/// LAST_GAME_FIELDS.
fn last_game_fields(game_key: &str) -> Option<&'static [&'static str]> {
    match game_key {
        "overwatch" => Some(&["elims", "deaths", "assists", "damage", "healing", "mitigation"]),
        "valorant" => Some(&["kills", "deaths", "assists"]),
        "rocketleague" => Some(&["score", "goals", "assists", "saves", "shots", "demos"]),
        _ => None,
    }
}

fn players_of(v: Option<&Value>) -> Vec<Value> {
    v.and_then(|x| x.get("players")).and_then(Value::as_array).cloned().unwrap_or_default()
}

fn last_game_rows(game: &Value, game_key: &str) -> Option<(Vec<Value>, Vec<Value>)> {
    match game_key {
        "overwatch" | "valorant" => {
            let p = if game_key == "overwatch" { "/overwatchOcr/live/teams" } else { "/valorantBoard/live/teams" };
            let t = game.pointer(p).filter(|v| truthy_val(v))?;
            Some((players_of(t.get("home")), players_of(t.get("away"))))
        }
        "rocketleague" => {
            let all = game.pointer("/rocketLeague/live/players").and_then(Value::as_array).cloned().unwrap_or_default();
            if all.is_empty() { None } else { Some((all.clone(), all)) }
        }
        _ => None,
    }
}

/// saveLastGameStats(game, gameKey, rosterKey) -> count. now_ms = Date.now().
pub fn save_last_game_stats(game: &mut Value, game_key: &str, roster_key: &str, now_ms: f64) -> usize {
    let Some(fields) = last_game_fields(game_key) else { return 0 };
    let Some((home, away)) = last_game_rows(game, game_key) else { return 0 };
    let active = to_number(game.get("activeMap")).map(|x| x as i64).unwrap_or(-1);
    let map = game["mapRows"].get(active.max(0) as usize).filter(|_| active >= 0).and_then(|r| r.get("map")).filter(|m| truthy(Some(m))).map(|m| js_string(Some(m))).unwrap_or_default();
    let base = game.get("lastGameStats").filter(|v| truthy_val(v)).or_else(|| if game_key == "overwatch" { game.get("overwatchLastMapStats").filter(|v| truthy_val(v)) } else { None }).cloned();
    let mut saved: Map<String, Value> = base.and_then(|v| v.as_object().cloned()).unwrap_or_default();
    let mut count = 0;
    let mut keys: Vec<&str> = Vec::new();
    for k in [roster_key, "varsity", "jv"] {
        if !keys.contains(&k) {
            keys.push(k);
        }
    }
    for key in keys {
        for (side, coll) in [("home", "rosters"), ("away", "awayRosters")] {
            let roster = game.get(coll).and_then(|r| r.get(key)).and_then(Value::as_array).cloned().unwrap_or_default();
            let rows = if side == "home" { &home } else { &away };
            for player in roster {
                let station = js_round(num_or_zero(player.get("stageStation")));
                let tag = player.get("handle").filter(|v| truthy(Some(v))).or_else(|| player.get("name").filter(|v| truthy(Some(v)))).map(|v| js_string(Some(v)));
                let Some(tag) = tag else { continue };
                if !(1.0..=10.0).contains(&station) {
                    continue;
                }
                let mut best = NAME_MATCH;
                let mut row: Option<&Value> = None;
                for r in rows {
                    let name = r.get("name").map(|v| if v.is_null() { String::new() } else { js_string(Some(v)) }).unwrap_or_default();
                    let sc = tag_similarity(&tag, &name);
                    if sc >= best {
                        row = Some(r);
                        best = sc;
                    }
                }
                let Some(row) = row else { continue };
                let mut stats = Map::new();
                for f in fields {
                    let v = row.get(*f);
                    let ok = !matches!(v, None | Some(Value::Null)) && v.and_then(Value::as_str) != Some("") && to_number(v).is_some_and(f64::is_finite);
                    stats.insert((*f).into(), if ok { jnum(to_number(v).unwrap()) } else { Value::Null });
                }
                if stats.values().all(Value::is_null) {
                    continue;
                }
                let pick = |k: &str| row.get(k).filter(|v| truthy(Some(v))).map(|v| js_string(Some(v))).unwrap_or_default();
                let character = match game_key {
                    "overwatch" => pick("hero"),
                    "valorant" => pick("agent"),
                    _ => player.get("character").filter(|v| truthy(Some(v))).map(|v| js_string(Some(v))).unwrap_or_default(),
                };
                let mut entry = json!({ "game": game_key, "handle": tag, "map": map, "character": character });
                if game_key == "overwatch" {
                    entry["hero"] = json!(character);
                }
                entry["stats"] = Value::Object(stats);
                entry["savedAt"] = jnum(now_ms);
                saved.insert(crate::game_config::num_to_js(station), entry);
                count += 1;
            }
        }
    }
    game["lastGameStats"] = Value::Object(saved.clone());
    if game_key == "overwatch" {
        game["overwatchLastMapStats"] = Value::Object(saved);
    }
    count
}

/// advanceGameMatch(game, gameKey, rosterKey) -> next index.
pub fn advance_game_match(game: &mut Value, game_key: &str, roster_key: &str, now_ms: f64) -> usize {
    save_last_game_stats(game, game_key, roster_key, now_ms);
    let len = visible_len(game);
    let active = to_number(game.get("activeMap")).unwrap_or(0.0);
    let next = if len == 0 { 0 } else { ((active + 1.0) as usize) % len };
    save_active_map_result(game, game_key);
    game["activeMap"] = json!(next);
    reset_detail_scores(game, game_key);
    if game_key == "valorant" {
        reset_valorant_round_timeline(game);
    }
    for (i, row) in game["mapRows"].as_array_mut().into_iter().flatten().enumerate() {
        let w = row.get("winner");
        let has = !matches!(w, Some(Value::Null));
        row["status"] = json!(if has { "complete" } else if i == next { "ready" } else { "upcoming" });
    }
    next
}

/// Result of an action, like the JS return object (`extra` holds the flags the JS returns).
#[derive(Debug, Clone, PartialEq)]
pub struct ActionResult {
    pub message: String,
    pub extra: Map<String, Value>,
}

impl ActionResult {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("message".into(), json!(self.message));
        m.extend(self.extra.clone());
        Value::Object(m)
    }
}

fn ok(message: String, extra: Value) -> R<ActionResult> {
    Ok(ActionResult { message, extra: extra.as_object().cloned().unwrap_or_default() })
}

fn s(v: Option<&Value>) -> String {
    // String(x || '')
    if truthy(v) { js_string(v) } else { String::new() }
}

/// applyCompanionAction(state, request). now_ms = Date.now() (for lastGameStats.savedAt).
pub fn apply_companion_action(state: &mut Value, request: &Value, now_ms: f64) -> R<ActionResult> {
    if !request.is_object() {
        return Err(ActionError::new("Action request must be a JSON object"));
    }
    let action = s(request.get("action"));
    if action.is_empty() {
        return Err(ActionError::new("action is required"));
    }
    match action.as_str() {
        "output.select" => {
            let out = s(request.get("output")).trim().to_string();
            let out = if out.is_empty() && !truthy(request.get("output")) { s(request.get("name")).trim().to_string() } else { out };
            if !["scoreboard", "roster", "map-pool", "clean"].contains(&out.as_str()) {
                return Err(ActionError::new("output must be scoreboard, roster, map-pool, or clean"));
            }
            state["activeOutputOverlay"] = json!(out);
            return ok(format!("Program output selected: {out}"), json!({ "outputChanged": true }));
        }
        "overwatch.ban" => {
            let side = {
                let t = s(request.get("team"));
                if t.is_empty() { s(request.get("side")) } else { t }
            };
            if side != "home" && side != "away" {
                return Err(ActionError::new("team must be home or away"));
            }
            let hero = s(request.get("hero")).trim().to_string();
            let heroes = config("overwatch").unwrap()["characters"].as_array().unwrap();
            let matched = if hero.is_empty() {
                String::new()
            } else {
                match heroes.iter().filter_map(Value::as_str).find(|h| h.to_lowercase() == hero.to_lowercase()) {
                    Some(h) => h.to_string(),
                    None => return Err(ActionError::new(format!("Unknown hero: {hero}"))),
                }
            };
            let game = &mut state["games"]["overwatch"];
            let i = to_number(game.get("activeMap")).map(|x| x as i64).unwrap_or(-1);
            if i < 0 || game["mapRows"].get(i as usize).is_none_or(|r| !truthy_val(r)) {
                return Err(ActionError::new("No active map"));
            }
            let row = &mut game["mapRows"][i as usize];
            if !row.get("heroBans").is_some_and(Value::is_object) {
                row["heroBans"] = json!({});
            }
            row["heroBans"][side.as_str()] = json!(matched);
            let msg = if matched.is_empty() { format!("{side} ban cleared") } else { format!("{side} ban: {matched}") };
            return ok(msg, json!({}));
        }
        "statcards.set" => {
            let gk = {
                let g = s(request.get("game"));
                if g.is_empty() { s(state.get("selectedGame")) } else { g }
            };
            let key = match gk.as_str() {
                "valorant" => "valorantShowStatCards",
                "overwatch" => "overwatchShowStatCards",
                _ => return Err(ActionError::new("statcards.set is for valorant or overwatch (game, or select one of them first)")),
            };
            let mode = match request.get("value").filter(|v| !v.is_null()).or_else(|| request.get("mode").filter(|v| !v.is_null())) {
                Some(v) => js_string(Some(v)).to_lowercase(),
                None => "toggle".into(),
            };
            let game = &mut state["games"][gk.as_str()];
            let current = if gk == "valorant" { game.get(key) != Some(&json!(false)) } else { truthy(game.get(key)) };
            let next = match mode.as_str() {
                "show" | "on" | "true" => true,
                "hide" | "off" | "false" => false,
                "toggle" => !current,
                _ => return Err(ActionError::new("value must be show, hide or toggle")),
            };
            game[key] = json!(next);
            let name = config(&gk).unwrap()["name"].as_str().unwrap();
            return ok(format!("{name} player stat cards {}", if next { "shown" } else { "hidden" }), json!({ "gameKey": gk }));
        }
        "display.preset" => {
            let station = match request.get("station") {
                None => "all".to_string(),
                Some(Value::String(x)) if x.is_empty() => "all".into(),
                Some(v) => js_string(Some(v)),
            };
            let preset = s(request.get("preset"));
            apply_display_preset(state, &station, &preset, &s(request.get("team"))).map_err(ActionError::new)?;
            let label = if !station.is_empty() && station.chars().all(|c| c.is_ascii_digit()) { format!("station {station}") } else { station };
            let p = match request.get("preset") {
                None => "undefined".into(),
                v => js_string(v),
            };
            return ok(format!("Displays {label}: {p}"), json!({}));
        }
        "game.select" => {
            let g = request.get("game").map(|v| js_string(Some(v))).unwrap_or_default();
            let Some(c) = config(&g).filter(|_| request.get("game").is_some_and(Value::is_string)) else {
                let shown = if truthy(request.get("game")) { js_string(request.get("game")) } else { "(empty)".into() };
                return Err(ActionError::new(format!("Unknown game: {shown}")));
            };
            state["selectedGame"] = json!(g);
            return ok(format!("Selected {}", c["name"].as_str().unwrap()), json!({ "selectedGameChanged": true }));
        }
        _ => {}
    }

    let game_key = if truthy(request.get("game")) { js_string(request.get("game")) } else { js_string(state.get("selectedGame")) };
    let roster_key = if truthy(state.get("activeRoster")) { js_string(state.get("activeRoster")) } else { "varsity".into() };
    let cfg = config(&game_key);
    if cfg.is_none() || state["games"].get(&game_key).is_none_or(|g| !truthy_val(g)) {
        return Err(ActionError::new(format!("Unknown game: {game_key}")));
    }
    let cfg = cfg.unwrap();
    let game = state["games"].get_mut(&game_key).unwrap();
    let amount = || whole_number(request.get("amount"), "amount", 1.0, f64::MAX, Some(1.0));
    match action.as_str() {
        "score.increment" => {
            let i = team_index(request.get("team"))?;
            let a = amount()?;
            let tgt = series_target(game);
            let t = &mut game["teams"][i];
            t["score"] = jnum(tgt.min(num_or_zero(t.get("score")) + a));
        }
        "score.decrement" => {
            let i = team_index(request.get("team"))?;
            let a = amount()?;
            let t = &mut game["teams"][i];
            t["score"] = jnum((num_or_zero(t.get("score")) - a).max(0.0));
        }
        "score.set" => {
            let i = team_index(request.get("team"))?;
            let v = whole_number(request.get("value"), "value", 0.0, series_target(game), None)?;
            game["teams"][i]["score"] = jnum(v);
        }
        "detail_score.increment" => {
            let i = team_index(request.get("team"))?;
            let a = amount()?;
            let t = &mut game["teams"][i];
            t["detailScore"] = jnum(num_or_zero(t.get("detailScore")) + a);
        }
        "detail_score.decrement" => {
            let i = team_index(request.get("team"))?;
            let a = amount()?;
            let t = &mut game["teams"][i];
            t["detailScore"] = jnum((num_or_zero(t.get("detailScore")) - a).max(0.0));
        }
        "detail_score.set" => {
            let i = team_index(request.get("team"))?;
            let v = whole_number(request.get("value"), "value", 0.0, f64::MAX, None)?;
            game["teams"][i]["detailScore"] = jnum(v);
        }
        "match.next" => {
            advance_game_match(game, &game_key, &roster_key, now_ms);
        }
        "scores.reset" => reset_all_scores(game, &game_key),
        "match.live.toggle" => {
            let live = truthy(game.pointer("/match/live"));
            game["match"]["live"] = json!(!live);
        }
        "match.live.set" => match request.get("value") {
            Some(Value::Bool(b)) => game["match"]["live"] = json!(*b),
            _ => return Err(ActionError::new("value must be true or false")),
        },
        "teams.swap" => {
            if game_key == "valorant" {
                swap_game_teams_preserving_side_scores(game)
            } else {
                swap_game_teams(game)
            }
        }
        "map.activate" => {
            let i = whole_number(request.get("number"), "number", 1.0, visible_len(game) as f64, None)? as usize - 1;
            game["activeMap"] = json!(i);
            for (ri, row) in game["mapRows"].as_array_mut().into_iter().flatten().enumerate() {
                if row.get("winner") == Some(&Value::Null) {
                    row["status"] = json!(if ri == i { "ready" } else { "upcoming" });
                }
            }
        }
        "map.winner.set" => {
            let i = whole_number(request.get("number"), "number", 1.0, visible_len(game) as f64, None)? as usize - 1;
            let t = request.get("team");
            let winner = match t {
                Some(Value::Null) => Value::Null,
                Some(Value::String(x)) if x.is_empty() || x == "clear" => Value::Null,
                _ => json!(team_index(t)?),
            };
            let active = to_number(game.get("activeMap"));
            let row = &mut game["mapRows"][i];
            row["status"] = json!(if winner.is_null() { if active == Some(i as f64) { "ready" } else { "upcoming" } } else { "complete" });
            row["winner"] = winner;
            recount_series(game);
        }
        "maps.reset" => reset_map_results(game, &game_key),
        "veto.reset" => {
            if game_key != "valorant" {
                return Err(ActionError::new("veto.reset is only available for VALORANT"));
            }
            for b in game["veto"]["bans"].as_array_mut().into_iter().flatten() {
                *b = json!("");
            }
            for p in game["veto"]["picks"].as_array_mut().into_iter().flatten() {
                p["map"] = json!("");
                p["score"] = json!(["", ""]);
                p["winner"] = Value::Null;
            }
            for (i, row) in game["mapRows"].as_array_mut().into_iter().flatten().enumerate() {
                row["map"] = json!("");
                row["score"] = json!(["", ""]);
                row["overtime"] = json!(false);
                row["overtimeSeconds"] = json!(0);
                row["winner"] = Value::Null;
                row["status"] = json!(if i == 0 { "ready" } else { "upcoming" });
            }
            for t in game["teams"].as_array_mut().into_iter().flatten() {
                t["score"] = json!(0);
            }
            game["activeMap"] = json!(0);
        }
        _ => return Err(ActionError { message: format!("Unknown action: {action}"), status: 404 }),
    }
    ok(
        format!("{action} applied to {}", cfg["name"].as_str().unwrap()),
        json!({ "selectedGameChanged": false, "gameKey": game_key, "teamsSwapped": action == "teams.swap" }),
    )
}
