//! Companion variables + capabilities: electron/companion-api-service.cjs
//! buildCompanionVariables / buildStageVariables / buildCompanionCapabilities.
use serde_json::{Map, Value, json};

use crate::game_config::{jnum, num_or_zero, to_number, truthy};

/// scalar(value, fallback): strings / numbers / booleans pass, anything else -> fallback.
fn scalar(v: Option<&Value>, fallback: &str) -> Value {
    match v {
        Some(x @ (Value::String(_) | Value::Number(_) | Value::Bool(_))) => x.clone(),
        _ => json!(fallback),
    }
}

fn winner_label(v: Option<&Value>) -> Value {
    match v.and_then(Value::as_f64) {
        Some(x) if x == 0.0 => json!("home"),
        Some(x) if x == 1.0 => json!("away"),
        _ => json!(""),
    }
}

fn at<'a>(v: &'a Value, i: usize) -> Option<&'a Value> {
    v.as_array().and_then(|a| a.get(i))
}

/// buildCompanionVariables(state).
pub fn build_companion_variables(state: &Value) -> Map<String, Value> {
    let game_key = state.get("selectedGame").filter(|v| truthy(Some(v))).and_then(Value::as_str).unwrap_or("").to_string();
    let empty = json!({});
    let game = state.get("games").and_then(|g| g.get(&game_key)).filter(|g| truthy(Some(g))).unwrap_or(&empty);
    let teams = game.get("teams").filter(|t| t.is_array()).cloned().unwrap_or(json!([]));
    let home = at(&teams, 0).filter(|v| truthy(Some(v))).cloned().unwrap_or(json!({}));
    let away = at(&teams, 1).filter(|v| truthy(Some(v))).cloned().unwrap_or(json!({}));
    let rows = game.get("mapRows").filter(|t| t.is_array()).cloned().unwrap_or(json!([]));
    // Number.isInteger(game.activeMap) ? game.activeMap : 0
    let active_index = game.get("activeMap").and_then(Value::as_f64).filter(|x| *x == x.trunc() && x.is_finite()).unwrap_or(0.0);
    let active = if active_index >= 0.0 { at(&rows, active_index as usize) } else { None }.filter(|v| truthy(Some(v))).cloned().unwrap_or(json!({}));
    let m = |k: &str| game.get("match").and_then(|x| x.get(k));
    let mut v = Map::new();
    let mut put = |k: &str, x: Value| {
        v.insert(k.into(), x);
    };
    put("selected_game", json!(game_key));
    put("active_output_overlay", scalar(state.get("activeOutputOverlay"), "scoreboard"));
    put("event", scalar(m("event"), ""));
    put("round", scalar(m("round"), ""));
    put("format", scalar(m("format"), ""));
    put("live", json!(truthy(m("live"))));
    for (p, t) in [("home", &home), ("away", &away)] {
        put(&format!("{p}_name"), scalar(t.get("name"), ""));
        put(&format!("{p}_short_name"), scalar(t.get("shortName"), ""));
        put(&format!("{p}_color"), scalar(t.get("color"), ""));
        put(&format!("{p}_secondary_color"), scalar(t.get("secondaryColor"), ""));
        put(&format!("{p}_score"), jnum(num_or_zero(t.get("score"))));
        put(&format!("{p}_detail_score"), jnum(num_or_zero(t.get("detailScore"))));
    }
    put("active_match_number", jnum(active_index + 1.0));
    put("active_match_index", jnum(active_index));
    put("active_mode", scalar(active.get("mode"), ""));
    put("active_map", scalar(active.get("map"), ""));
    put("active_status", scalar(active.get("status"), ""));
    put("active_winner", winner_label(active.get("winner")));
    put("show_away_roster", json!(truthy(game.get("showAwayRoster"))));
    put("updated_at", scalar(state.get("updatedAt"), ""));

    for (i, row) in rows.as_array().into_iter().flatten().enumerate() {
        let n = i + 1;
        put(&format!("match_{n}_mode"), scalar(row.get("mode"), ""));
        put(&format!("match_{n}_map"), scalar(row.get("map"), ""));
        put(&format!("match_{n}_status"), scalar(row.get("status"), ""));
        put(&format!("match_{n}_winner"), winner_label(row.get("winner")));
        put(&format!("match_{n}_home_score"), scalar(row.get("score").and_then(|s| at(s, 0)), ""));
        put(&format!("match_{n}_away_score"), scalar(row.get("score").and_then(|s| at(s, 1)), ""));
    }

    put("rl_spectated_team", json!(""));
    put("rl_spectated_slot", json!(""));
    let rl = game.get("rocketLeague");
    let live = rl.and_then(|r| r.get("live"));
    for side in ["home", "away"] {
        let blue = num_or_zero(rl.and_then(|r| r.get("blueTeam")));
        let team_num = if side == "home" { blue } else { 1.0 - blue };
        let mut players: Vec<Value> = if game_key == "rocketleague" {
            live.and_then(|l| l.get("players")).and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter(|p| to_number(p.get("teamNum")) == Some(team_num)).collect()
        } else {
            Vec::new()
        };
        // sort: (Number(shortcut) || 99) then String(id || name).localeCompare
        let key = |p: &Value| to_number(p.get("shortcut")).filter(|x| *x != 0.0).unwrap_or(99.0);
        let idn = |p: &Value| {
            let x = p.get("id").filter(|v| truthy(Some(v))).or_else(|| p.get("name"));
            crate::game_config::js_string(x)
        };
        players.sort_by(|a, b| key(a).partial_cmp(&key(b)).unwrap_or(std::cmp::Ordering::Equal).then_with(|| idn(a).cmp(&idn(b))));
        for slot in 1..=3 {
            let p = players.get(slot - 1);
            put(&format!("rl_{side}_player_{slot}_name"), scalar(p.and_then(|x| x.get("name")), ""));
            let status = live.and_then(|l| l.get("status")).and_then(Value::as_str);
            let age = live.and_then(|l| l.get("dataAgeMs")).filter(|v| !v.is_null()).map(|v| to_number(Some(v)).unwrap_or(f64::NAN)).unwrap_or(0.0);
            let spectated = p.is_some_and(|x| truthy(x.get("spectated")))
                && !truthy(live.and_then(|l| l.get("replay")))
                && matches!(status, Some("connected" | "simulating"))
                && age < 3000.0;
            put(&format!("rl_{side}_player_{slot}_spectated"), json!(spectated));
            if spectated {
                put("rl_spectated_team", json!(side));
                put("rl_spectated_slot", json!(format!("{side}_{slot}")));
            }
        }
    }
    if game_key == "rocketleague" && live.is_some_and(|l| truthy(Some(l))) {
        let l = live.unwrap();
        put("rl_connection_status", scalar(l.get("status"), ""));
        put("rl_clock_seconds", jnum(num_or_zero(l.get("timeSeconds"))));
        put("rl_overtime", json!(truthy(l.get("overtime"))));
        put("rl_arena", scalar(l.get("arena"), ""));
        put("rl_spectated_player", scalar(l.get("spectatedPlayer"), ""));
        put("rl_packet_rate", jnum(num_or_zero(l.get("packetRate"))));
        put("rl_packets", jnum(num_or_zero(l.get("packets"))));
        for (i, p) in l.get("players").and_then(Value::as_array).into_iter().flatten().enumerate() {
            let n = i + 1;
            put(&format!("rl_player_{n}_name"), scalar(p.get("name"), ""));
            put(&format!("rl_player_{n}_team"), json!(if to_number(p.get("teamNum")) == Some(0.0) { "blue" } else { "orange" }));
            let boost = match p.get("boost") {
                None | Some(Value::Null) => json!(""),
                b => jnum(num_or_zero(b)),
            };
            put(&format!("rl_player_{n}_boost"), boost);
            for f in ["goals", "assists", "saves", "shots"] {
                put(&format!("rl_player_{n}_{f}"), jnum(num_or_zero(p.get(f))));
            }
        }
    }
    if game_key == "valorant" && game.get("veto").is_some_and(|x| truthy(Some(x))) {
        let veto = &game["veto"];
        for (i, b) in veto.get("bans").and_then(Value::as_array).into_iter().flatten().enumerate() {
            put(&format!("veto_ban_{}", i + 1), scalar(Some(b), ""));
        }
        for (i, p) in veto.get("picks").and_then(Value::as_array).into_iter().flatten().enumerate() {
            let n = i + 1;
            put(&format!("veto_pick_{n}_map"), scalar(p.get("map"), ""));
            put(&format!("veto_pick_{n}_attackers"), json!(if to_number(p.get("attackers")) == Some(0.0) { "home" } else { "away" }));
            put(&format!("veto_pick_{n}_home_score"), scalar(p.get("score").and_then(|s| at(s, 0)), ""));
            put(&format!("veto_pick_{n}_away_score"), scalar(p.get("score").and_then(|s| at(s, 1)), ""));
            put(&format!("veto_pick_{n}_winner"), winner_label(p.get("winner")));
        }
    }
    v
}

/// buildStageVariables(status, state). now_ms = Date.now().
pub fn build_stage_variables(status: &Value, state: &Value, now_ms: f64) -> Map<String, Value> {
    let mut v = Map::new();
    v.insert("display_online_count".into(), jnum(num_or_zero(status.get("onlineCount"))));
    let stations = status.get("stations").and_then(Value::as_array).cloned().unwrap_or_default();
    let empty = json!({});
    let presets = state.get("displays").and_then(|d| d.get("stations")).filter(|x| truthy(Some(x))).unwrap_or(&empty);
    for i in 1..=10 {
        let st = stations.iter().find(|s| to_number(s.get("station")) == Some(i as f64)).cloned().unwrap_or(json!({}));
        let online = truthy(st.get("online"));
        v.insert(format!("display_{i}_online"), json!(online));
        v.insert(format!("display_{i}_mode"), if online { scalar(st.get("mode"), "offline") } else { json!("offline") });
        let mode = st.get("mode").and_then(Value::as_str);
        v.insert(format!("display_{i}_receiving"), json!(online && (mode == Some("mirror") || st.get("state").and_then(Value::as_str) == Some("receiving"))));
        v.insert(format!("display_{i}_hostname"), scalar(st.get("hostname"), ""));
        v.insert(format!("display_{i}_preset"), scalar(presets.get(i.to_string()).and_then(|p| p.get("preset")), "idle"));
        v.insert(format!("display_{i}_noise"), json!(truthy(st.get("noise"))));
        v.insert(format!("display_{i}_noise_playing"), json!(online && truthy(st.get("noise")) && st.get("noiseState").and_then(Value::as_str) == Some("playing")));
    }
    let sp = status.get("spectated").filter(|x| truthy(Some(x))).cloned().unwrap_or(json!({}));
    let fresh = truthy(sp.get("receivedAt")) && now_ms - num_or_zero_nan(sp.get("receivedAt")) < 10000.0;
    let named = fresh && truthy(sp.get("name"));
    v.insert("spectated_name".into(), if fresh { scalar(sp.get("name"), "") } else { json!("") });
    // JS: Number(sp.station) || 0 (no rounding).
    v.insert("spectated_station".into(), if named { jnum(num_or_zero(sp.get("station"))) } else { json!(0) });
    v.insert("spectated_side".into(), if named { scalar(sp.get("side"), "") } else { json!("") });
    v.insert("spectated_team".into(), if named { scalar(sp.get("team"), "") } else { json!("") });
    v.insert("spectated_known".into(), json!(named));
    v
}

/// Number(x) where NaN must keep failing comparisons (Date.now() - NaN < 10000 is false).
fn num_or_zero_nan(v: Option<&Value>) -> f64 {
    to_number(v).unwrap_or(f64::NAN)
}

/// buildCompanionCapabilities(state).
pub fn build_companion_capabilities(state: &Value) -> Value {
    let game_key = state.get("selectedGame").filter(|v| truthy(Some(v))).and_then(Value::as_str).unwrap_or("");
    let rows = state.pointer(&format!("/games/{game_key}/mapRows")).and_then(Value::as_array).map_or(0, Vec::len);
    let a = |id: &str, label: &str, p: &[&str]| json!({ "id": id, "label": label, "parameters": p });
    let mut actions = vec![
        a("score.increment", "Increase team series score", &["team", "amount?", "game?"]),
        a("score.decrement", "Decrease team series score", &["team", "amount?", "game?"]),
        a("score.set", "Set team series score", &["team", "value", "game?"]),
        a("detail_score.increment", "Increase current map/game score", &["team", "amount?", "game?"]),
        a("detail_score.decrement", "Decrease current map/game score", &["team", "amount?", "game?"]),
        a("detail_score.set", "Set current map/game score", &["team", "value", "game?"]),
        a("match.next", "Advance to the next map/game", &["game?"]),
        a("scores.reset", "Reset series and current scores", &["game?"]),
        a("match.live.toggle", "Toggle live/off-air", &["game?"]),
        a("match.live.set", "Set live/off-air", &["value", "game?"]),
        a("teams.swap", "Swap home and away sides", &["game?"]),
        a("game.select", "Select the active game", &["game"]),
        a("output.select", "Select Program output HTML: scoreboard, roster, map-pool, or clean", &["output"]),
        a("map.activate", "Activate a map/game number", &["number", "game?"]),
        a("map.winner.set", "Set or clear a map/game winner", &["number", "team", "game?"]),
        a("maps.reset", "Clear all map/game results", &["game?"]),
    ];
    if game_key == "valorant" {
        actions.push(a("veto.reset", "Reset VALORANT veto selections", &["game?"]));
    }
    actions.extend([
        a("overwatch.ban", "Overwatch: hero ban for the active map", &["team", "hero"]),
        a("statcards.set", "Player stat cards (VALORANT / Overwatch): show, hide or toggle", &["value (show/hide/toggle)", "game?"]),
        a("stage.display.mode", "Displays: game mirror or NDI", &["mode", "station?", "source?"]),
        a("stage.display.noise", "Displays: pink noise on the player headsets", &["on (on/off/toggle)", "station?", "volume?"]),
        a("display.preset", "Displays: NDI preset (idle, intro, player, banner, score, black)", &["preset", "station?", "team?"]),
    ]);
    let games: Vec<Value> = state.get("games").and_then(Value::as_object).map(|g| g.keys().map(|k| json!(k)).collect()).unwrap_or_default();
    json!({
        "apiVersion": 1,
        "selectedGame": game_key,
        "games": games,
        "matchCount": rows,
        "teams": ["home", "away"],
        "actions": actions,
        "transports": { "actions": "HTTP POST", "variables": "HTTP GET", "liveUpdates": "SSE" }
    })
}
