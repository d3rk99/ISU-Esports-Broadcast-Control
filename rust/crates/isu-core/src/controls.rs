//! The controller window's own buttons (src/app.js click handler `actions` + syncFormat,
//! clearSeriesMapResults, seriesLength/Target, visibleMapRows). Pure state changes, so the egui
//! window and the parity test share them. Each takes the whole state like app.js does.
use serde_json::{Value, json};

use crate::game_config::{config, initial_state, jnum, num_or_zero, to_number};

fn sel(state: &Value) -> String {
    state.get("selectedGame").and_then(Value::as_str).unwrap_or("overwatch").to_string()
}

fn roster_key(state: &Value) -> String {
    state.get("activeRoster").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("varsity").to_string()
}

/// seriesLength(game, config).
pub fn series_length(game: &Value, game_key: &str) -> f64 {
    let cfg = config(game_key).unwrap();
    let allowed: Vec<f64> = cfg["formatOptions"].as_array().into_iter().flatten().filter_map(Value::as_f64).collect();
    let fallback = cfg["defaultSeriesLength"].as_f64().filter(|x| *x != 0.0).unwrap_or(game["mapRows"].as_array().map_or(0, Vec::len) as f64);
    let requested = to_number(game.get("seriesLength")).filter(|x| *x != 0.0 && !x.is_nan()).unwrap_or(fallback);
    if allowed.is_empty() || allowed.contains(&requested) { requested } else { fallback }
}

pub fn series_target(game: &Value, game_key: &str) -> f64 {
    (series_length(game, game_key) / 2.0).ceil()
}

pub fn visible_rows(game: &Value, game_key: &str) -> usize {
    (game["mapRows"].as_array().map_or(0, Vec::len) as f64).min(series_length(game, game_key)).max(0.0) as usize
}

fn recount(game: &mut Value, game_key: &str) {
    let vis = visible_rows(game, game_key);
    let rows = game["mapRows"].as_array().cloned().unwrap_or_default();
    for (ti, t) in game["teams"].as_array_mut().into_iter().flatten().enumerate() {
        t["score"] = json!(rows.iter().take(vis).filter(|r| r.get("winner").and_then(Value::as_f64) == Some(ti as f64)).count());
    }
}

/// clearSeriesMapResults(game, gameKey).
pub fn clear_series_map_results(game: &mut Value, game_key: &str) {
    for (i, row) in game["mapRows"].as_array_mut().into_iter().flatten().enumerate() {
        row["score"] = json!(["", ""]);
        row["winner"] = Value::Null;
        row["overtime"] = json!(false);
        row["overtimeSeconds"] = json!(0);
        if game_key == "overwatch" {
            row["map"] = json!("");
            row["mode"] = json!("");
        }
        row["status"] = json!(if i == 0 { "ready" } else { "upcoming" });
    }
    if game_key == "valorant" {
        for p in game.pointer_mut("/veto/picks").and_then(Value::as_array_mut).into_iter().flatten() {
            p["score"] = json!(["", ""]);
            p["winner"] = Value::Null;
        }
    }
    game["activeMap"] = json!(0);
}

/// syncFormat(game, length) (the "Series format" select).
pub fn sync_format(state: &mut Value, length: f64) {
    let key = sel(state);
    let game = &mut state["games"][key.as_str()];
    game["seriesLength"] = jnum(length);
    game["match"]["format"] = json!(format!("Best of {}", crate::game_config::num_to_js(length)));
    let vis = visible_rows(game, &key) as f64;
    game["activeMap"] = jnum(num_or_zero(game.get("activeMap")).min(vis - 1.0));
    if key == "rocketleague" {
        game["activeMap"] = json!(0);
        for (i, row) in game["mapRows"].as_array_mut().into_iter().flatten().enumerate() {
            row["winner"] = Value::Null;
            row["score"] = json!(["", ""]);
            row["overtime"] = json!(false);
            row["overtimeSeconds"] = json!(0);
            row["status"] = json!(if i == 0 { "ready" } else { "upcoming" });
        }
        for t in game["teams"].as_array_mut().into_iter().flatten() {
            t["score"] = json!(0);
        }
        return;
    }
    let active = num_or_zero(game.get("activeMap"));
    let n = length;
    for (i, row) in game["mapRows"].as_array_mut().into_iter().flatten().enumerate() {
        let st = if i as f64 >= n { "upcoming" } else if !row.get("winner").is_none_or(Value::is_null) { "complete" } else if i as f64 == active { "ready" } else { "upcoming" };
        row["status"] = json!(st);
    }
    recount(game, &key);
}

/// One control button (app.js data-action) on the selected game. `index` = data-index,
/// `winner` = data-winner. Returns the save message (commit's message), or None if unknown.
pub fn apply(state: &mut Value, action: &str, index: usize, winner: Option<f64>, now_ms: f64) -> Option<String> {
    let key = sel(state);
    let rk = roster_key(state);
    let target = series_target(&state["games"][key.as_str()], &key);
    let msg = "Changes saved".to_string();
    let game = &mut state["games"][key.as_str()];
    match action {
        "score-plus" => {
            let t = &mut game["teams"][index];
            t["score"] = jnum(target.min(num_or_zero(t.get("score")) + 1.0));
            Some(msg)
        }
        "score-minus" => {
            let t = &mut game["teams"][index];
            t["score"] = jnum((num_or_zero(t.get("score")) - 1.0).max(0.0));
            Some(msg)
        }
        "detail-plus" => {
            let t = &mut game["teams"][index];
            t["detailScore"] = jnum(num_or_zero(t.get("detailScore")) + 1.0);
            Some(msg)
        }
        "detail-minus" => {
            let t = &mut game["teams"][index];
            t["detailScore"] = jnum((num_or_zero(t.get("detailScore")) - 1.0).max(0.0));
            Some(msg)
        }
        "swap-teams" => {
            if key == "valorant" {
                crate::actions::swap_game_teams_preserving_side_scores(game);
            } else {
                crate::actions::swap_game_teams(game);
            }
            state["activeRosterSide"] = json!(if state["activeRosterSide"] == "away" { "home" } else { "away" });
            Some("Team sides swapped".into())
        }
        "reset-scores" => {
            for t in game["teams"].as_array_mut().into_iter().flatten() {
                t["score"] = json!(0);
                t["detailScore"] = json!(if key == "smash" { 12 } else { 0 });
            }
            if key == "valorant" || key == "rocketleague" {
                clear_series_map_results(game, &key);
            }
            if key == "valorant" {
                crate::boards::reset_round_history(game);
            }
            Some("Scores reset".into())
        }
        "next-match" => {
            let vis = visible_rows(game, &key).max(1);
            let next = (num_or_zero(game.get("activeMap")) as usize + 1) % vis;
            crate::actions::advance_game_match(game, &key, &rk, now_ms);
            if key == "valorant" {
                crate::boards::reset_round_history(game);
            }
            Some(format!("Advanced to {} {}", if key == "rocketleague" || key == "smash" { "game" } else { "map" }, next + 1))
        }
        "activate-map" => {
            game["activeMap"] = json!(index);
            for (i, row) in game["mapRows"].as_array_mut().into_iter().flatten().enumerate() {
                if row.get("winner") == Some(&Value::Null) {
                    row["status"] = json!(if i == index { "ready" } else { "upcoming" });
                }
            }
            Some(format!("Map {} active", index + 1))
        }
        "map-winner" => {
            let w = winner.unwrap_or(f64::NAN);
            let row = &mut game["mapRows"][index];
            let cur = row.get("winner").and_then(Value::as_f64);
            row["winner"] = if cur == Some(w) { Value::Null } else { jnum(w) };
            row["status"] = json!(if row["winner"].is_null() { "ready" } else { "complete" });
            recount(game, &key);
            Some("Map result saved".into())
        }
        "clear-maps" => {
            clear_series_map_results(game, &key);
            for t in game["teams"].as_array_mut().into_iter().flatten() {
                t["score"] = json!(0);
            }
            if key == "valorant" {
                crate::boards::reset_round_history(game);
            }
            Some("Map results cleared".into())
        }
        "reset-veto" => {
            for b in game.pointer_mut("/veto/bans").and_then(Value::as_array_mut).into_iter().flatten() {
                *b = json!("");
            }
            for p in game.pointer_mut("/veto/picks").and_then(Value::as_array_mut).into_iter().flatten() {
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
            game["activeMap"] = json!(0);
            for t in game["teams"].as_array_mut().into_iter().flatten() {
                t["score"] = json!(0);
            }
            // app.js resetValorantRoundHistory() always works on the VALORANT game
            crate::boards::reset_round_history(&mut state["games"]["valorant"]);
            Some("Veto map selections reset".into())
        }
        "add-player" => {
            let coll = if state["activeRosterSide"] == "away" { "awayRosters" } else { "rosters" };
            let cfg = config(&key).unwrap().clone();
            let roster = &mut state["games"][key.as_str()][coll][rk.as_str()];
            let n = roster.as_array().map_or(0, Vec::len);
            roster.as_array_mut()?.push(crate::rocket_league::create_player(&cfg, n));
            Some("Roster slot added".into())
        }
        "remove-player" => {
            let coll = if state["activeRosterSide"] == "away" { "awayRosters" } else { "rosters" };
            let roster = state["games"][key.as_str()][coll][rk.as_str()].as_array_mut()?;
            if index < roster.len() {
                roster.remove(index);
            }
            Some("Player removed".into())
        }
        "reset-game" => {
            state["games"][key.as_str()] = initial_state()["games"][key.as_str()].clone();
            Some("Active game reset".into())
        }
        _ => None,
    }
}

/// One field edit of the controller window (app.js 'change' handler), on the selected game.
pub enum Field<'a> {
    /// data-map-index + data-map-prop (mode / map)
    MapProp { row: usize, prop: &'a str, value: &'a str },
    /// data-map-index + data-map-score (0 / 1)
    MapScore { row: usize, side: usize, value: &'a str },
    /// data-veto-ban
    VetoBan { index: usize, value: &'a str },
    /// data-veto-pick + data-veto-prop (map / attackers)
    VetoPick { index: usize, prop: &'a str, value: &'a str },
    /// data-player + data-player-prop on the active roster (writes back to the library)
    Player { index: usize, prop: &'a str, value: &'a str },
    /// data-away-roster-toggle
    AwayRoster { on: bool },
    /// data-roster-first-side
    RosterFirstSide { value: &'a str },
}

/// Returns the commit message app.js uses (None = the default 'Changes saved').
pub fn set_field(state: &mut Value, f: Field<'_>) -> Option<String> {
    let key = sel(state);
    match f {
        Field::MapProp { row, prop, value } => {
            let g = &mut state["games"][key.as_str()];
            g["mapRows"][row][prop] = json!(value);
            if key == "valorant" && prop == "map" && g.pointer(&format!("/veto/picks/{row}")).is_some_and(|p| crate::game_config::truthy(Some(p))) {
                g["veto"]["picks"][row]["map"] = json!(value);
            }
            None
        }
        Field::MapScore { row, side, value } => {
            state["games"][key.as_str()]["mapRows"][row]["score"][side] = json!(value);
            None
        }
        Field::VetoBan { index, value } => {
            state["games"][key.as_str()]["veto"]["bans"][index] = json!(value);
            None
        }
        Field::VetoPick { index, prop, value } => {
            let v = if prop == "attackers" { jnum(crate::game_config::js_number(value).unwrap_or(f64::NAN)) } else { json!(value) };
            let g = &mut state["games"][key.as_str()];
            g["veto"]["picks"][index][prop] = v.clone();
            if key == "valorant" && prop == "map" && g["mapRows"].get(index).is_some_and(|r| crate::game_config::truthy(Some(r))) {
                g["mapRows"][index]["map"] = v;
            }
            None
        }
        Field::Player { index, prop, value } => {
            let side = if state["activeRosterSide"] == "away" { "away" } else { "home" };
            let coll = if side == "away" { "awayRosters" } else { "rosters" };
            let rk = roster_key(state);
            state["games"][key.as_str()][coll][rk.as_str()][index][prop] = json!(value);
            crate::roster_manager::write_back_from_match(&mut state["games"][key.as_str()], side);
            None
        }
        Field::AwayRoster { on } => {
            state["games"][key.as_str()]["showAwayRoster"] = json!(on);
            if !on {
                let first = state["games"][key.as_str()]["rosterFirstSide"] == "away";
                state["activeRosterSide"] = json!(if first { "away" } else { "home" });
            }
            Some(if on { "Second roster enabled" } else { "First-team-only roster enabled" }.into())
        }
        Field::RosterFirstSide { value } => {
            let side = if value == "away" { "away" } else { "home" };
            state["games"][key.as_str()]["rosterFirstSide"] = json!(side);
            state["activeRosterSide"] = json!(side);
            let name = crate::game_config::js_string(state["games"][key.as_str()].pointer(&format!("/teams/{}/name", if value == "away" { 1 } else { 0 })));
            Some(format!("{name} will show first on the roster overlay"))
        }
    }
}
