//! Rocket League live state in the controller: src/app.js handleRocketLeagueEvent (+ the helpers
//! it uses: mapRocketLeagueTeam, applyRocketLeagueScores, updateRocketLeagueOvertime,
//! rocketLeaguePlayerId, normalizeLivePlayers, updateRocketLeagueRecentEvents), src/rl-loadout.js
//! (normalizeLoadout, loadoutKey, resolveCarArt, updateCarArt) and src/rl-roster-sync.js.
use serde_json::{Map, Value, json};
use unicode_normalization::UnicodeNormalization;

use crate::game_config::{jnum, js_string, num_or_zero, rocket_league_arena_name, to_number, truthy};

pub const EVENT_BADGE_MS: f64 = 5500.0;
pub const EVENT_FADE_MS: f64 = 850.0;
/// ROCKET_LEAGUE_STAT_EVENTS: (key, label, title, priority).
pub const STAT_EVENTS: [(&str, &str, &str, i64); 5] = [("goals", "G", "Goal", 5), ("assists", "A", "Assist", 4), ("saves", "V", "Save", 3), ("shots", "S", "Shot", 2), ("demos", "D", "Demo", 1)];

fn s(v: Option<&Value>) -> String {
    if truthy(v) { js_string(v) } else { String::new() }
}

/// mapRocketLeagueTeam(teamNum, rl).
pub fn map_team(team_num: Option<&Value>, rl: &Value) -> f64 {
    let blue = to_number(rl.get("blueTeam")).unwrap_or(f64::NAN);
    if to_number(team_num) == Some(0.0) { blue } else { 1.0 - blue }
}

/// applyRocketLeagueScores(game).
pub fn apply_scores(game: &mut Value) {
    let rl = game["rocketLeague"].clone();
    if !truthy(rl.get("syncGoals")) {
        return;
    }
    let Some(scores) = rl.pointer("/live/teamScores").and_then(Value::as_array) else { return };
    for (team_num, score) in scores.iter().enumerate() {
        let idx = map_team(Some(&json!(team_num)), &rl);
        if idx.is_finite() && idx >= 0.0 {
            if let Some(t) = game["teams"].get_mut(idx as usize) {
                t["detailScore"] = jnum(num_or_zero(Some(score)));
            }
        }
    }
}

/// updateRocketLeagueOvertime(live, overtime, seconds).
pub fn update_overtime(live: &mut Value, overtime: bool, seconds: Option<&Value>) {
    live["overtime"] = json!(overtime);
    if !overtime {
        live["overtimeSeconds"] = json!(0);
        return;
    }
    let a = num_or_zero(live.get("overtimeSeconds")).floor().max(0.0);
    let b = num_or_zero(seconds).floor().max(0.0);
    live["overtimeSeconds"] = jnum(a.max(b));
}

/// normalizeLoadout(value).
pub fn normalize_loadout(v: Option<&Value>) -> Value {
    match v {
        Some(Value::Array(a)) => Value::Array(
            a.iter()
                .take(32)
                .map(|x| match x {
                    Value::String(t) => json!(String::from_utf16_lossy(&t.trim().encode_utf16().take(256).collect::<Vec<_>>())),
                    Value::Number(_) => json!(String::from_utf16_lossy(&js_string(Some(x)).trim().encode_utf16().take(256).collect::<Vec<_>>())),
                    _ => json!(""),
                })
                .collect(),
        ),
        _ => json!([]),
    }
}

/// loadoutKey(value, scope).
pub fn loadout_key(v: Option<&Value>, body: bool) -> String {
    let items: Vec<String> = normalize_loadout(v).as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_lowercase()).collect();
    if items.first().is_none_or(|f| f.is_empty() || f == "none") {
        return String::new();
    }
    if body { format!("body:{}", items[0]) } else { format!("loadout:{}", Value::from(items)) }
}

/// resolveCarArt(player, library) -> (url, scope).
pub fn resolve_car_art(player: &Value, lib: &Value) -> Option<(String, &'static str)> {
    if !truthy(lib.get("enabled")) {
        return None;
    }
    let exact = lib.get("renders").and_then(|r| r.get(loadout_key(player.get("loadout"), false))).filter(|v| truthy(Some(v)));
    let body = lib.get("renders").and_then(|r| r.get(loadout_key(player.get("loadout"), true))).filter(|v| truthy(Some(v)));
    let entry = exact.or(body)?;
    let url = entry.get("url").filter(|u| truthy(Some(u)))?;
    Some((js_string(Some(url)), if exact.is_some() { "loadout" } else { "body" }))
}

/// updateCarArt(game).
pub fn update_car_art(game: &mut Value) {
    let lib = game.pointer("/rocketLeague/carRenderer").cloned().unwrap_or(Value::Null);
    for p in game.pointer_mut("/rocketLeague/live/players").and_then(Value::as_array_mut).into_iter().flatten() {
        let art = resolve_car_art(p, &lib);
        p["carImage"] = json!(art.as_ref().map_or("", |a| a.0.as_str()));
        p["carImageScope"] = json!(art.map_or("", |a| a.1));
    }
}

/// rocketLeaguePlayerId(player).
fn player_id(p: &Value) -> String {
    let primary = s(p.get("PrimaryId")).trim().to_string();
    if !primary.is_empty() && primary != "Unknown|0|0" {
        return primary;
    }
    let shortcut = match p.get("Shortcut") {
        None | Some(Value::Null) => String::new(),
        v => js_string(v),
    };
    let name = { let n = s(p.get("Name")); if n.is_empty() { "Unknown Player".into() } else { n } };
    format!("{}|{shortcut}|{name}", crate::game_config::num_to_js(num_or_zero(p.get("TeamNum"))))
}

/// normalizeLivePlayers(data, rl): sorted by mapped team (stable).
fn normalize_players(data: &Value, rl: &Value) -> Vec<Value> {
    let target = s(data.pointer("/Game/Target/Name"));
    let mut out: Vec<Value> = data
        .get("Players")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|p| {
            let name = { let n = s(p.get("Name")); if n.is_empty() { "Unknown Player".into() } else { n } };
            let mut m = Map::new();
            m.insert("id".into(), json!(player_id(p)));
            m.insert("name".into(), json!(name));
            m.insert("loadout".into(), normalize_loadout(p.get("Loadout")));
            m.insert("teamNum".into(), jnum(num_or_zero(p.get("TeamNum"))));
            // shortcut: player.Shortcut as is (undefined -> missing)
            if let Some(sc) = p.get("Shortcut") {
                m.insert("shortcut".into(), sc.clone());
            }
            for (k, src) in [("score", "Score"), ("goals", "Goals"), ("assists", "Assists"), ("saves", "Saves"), ("shots", "Shots"), ("demos", "Demos")] {
                m.insert(k.into(), jnum(num_or_zero(p.get(src))));
            }
            m.insert("boost".into(), match p.get("Boost") {
                None => Value::Null,
                b => to_number(b).map_or(Value::Null, jnum),
            });
            m.insert("demolished".into(), json!(truthy(p.get("bDemolished"))));
            // player.Name === target (target = data.Game?.Target?.Name || ''): a missing Name never equals ''
            m.insert("spectated".into(), json!(p.get("Name").is_some_and(|n| n.as_str() == Some(target.as_str()))));
            Value::Object(m)
        })
        .collect();
    out.sort_by(|a, b| map_team(a.get("teamNum"), rl).partial_cmp(&map_team(b.get("teamNum"), rl)).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// updateRocketLeagueRecentEvents(live, players). now = Date.now().
fn update_recent_events(live: &mut Value, now: f64) {
    let players = live["players"].as_array().cloned().unwrap_or_default();
    let prev = live.get("playerStats").filter(|v| v.is_object()).cloned().unwrap_or(json!({}));
    let mut next = Map::new();
    let mut recent: Vec<Value> = live.get("recentEvents").and_then(Value::as_array).into_iter().flatten().filter(|e| num_or_zero(e.get("removeAt")) > now).cloned().collect();
    for p in &players {
        let id = { let i = s(p.get("id")); if i.is_empty() { format!("{}|{}|{}", js_string(p.get("teamNum")), js_string(p.get("shortcut")), js_string(p.get("name"))) } else { i } };
        let cur: Map<String, Value> = STAT_EVENTS.iter().map(|(k, ..)| (k.to_string(), jnum(num_or_zero(p.get(*k)).max(0.0)))).collect();
        let has_old = prev.as_object().unwrap().contains_key(&id);
        let old = prev.get(&id).cloned().unwrap_or(json!({}));
        let mut changes: Vec<(&str, &str, &str, i64, f64, f64)> = STAT_EVENTS
            .iter()
            .map(|(k, l, t, pr)| (*k, *l, *t, *pr, num_or_zero(cur.get(*k)), num_or_zero(old.get(*k)).max(0.0)))
            .filter(|c| has_old && c.4 > c.5)
            .collect();
        changes.sort_by(|a, b| b.3.cmp(&a.3));
        if let Some(c) = changes.first() {
            recent.retain(|r| r.get("playerId").and_then(Value::as_str) != Some(id.as_str()));
            recent.push(json!({ "id": format!("{id}-{}-{}", c.0, crate::game_config::num_to_js(now)), "playerId": id, "playerName": p["name"], "key": c.0, "label": c.1, "title": c.2, "count": jnum(c.4 - c.5), "createdAt": jnum(now), "expiresAt": jnum(now + EVENT_BADGE_MS), "removeAt": jnum(now + EVENT_BADGE_MS + EVENT_FADE_MS) }));
        }
        next.insert(id, Value::Object(cur));
    }
    live["playerStats"] = Value::Object(next);
    recent.sort_by(|a, b| num_or_zero(b.get("createdAt")).partial_cmp(&num_or_zero(a.get("createdAt"))).unwrap_or(std::cmp::Ordering::Equal));
    live["recentEvents"] = Value::Array(recent);
}

// ------------------------------------------------------------------ roster sync ---

pub const MATCH_THRESHOLD: f64 = 0.74;

/// normalizeGamerName(value): lower, drop short [tags] (ISU), NFKD, strip marks, keep [a-z0-9].
pub fn normalize_gamer_name(v: &str) -> String {
    let lower = v.to_lowercase();
    // /[[({<][^\])}>]{1,8}[\])}>]/g -> ' '
    let chars: Vec<char> = lower.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if "[({<".contains(chars[i]) {
            let mut j = i + 1;
            while j < chars.len() && j - i <= 8 && !"])}>".contains(chars[j]) {
                j += 1;
            }
            if j < chars.len() && "])}>".contains(chars[j]) && (2..=9).contains(&(j - i)) {
                out.push(' ');
                i = j + 1;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out.nfkd().filter(|c| !('\u{0300}'..='\u{036f}').contains(c)).filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect()
}

fn lev(a: &[char], b: &[char]) -> usize {
    if a == b {
        return 0;
    }
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut next = vec![i];
        for j in 1..=b.len() {
            next.push((prev[j] + 1).min(next[j - 1] + 1).min(prev[j - 1] + usize::from(a[i - 1] != b[j - 1])));
        }
        prev = next;
    }
    prev[b.len()]
}

/// nameSimilarity(apiName, label).
pub fn name_similarity(api: &str, label: &str) -> f64 {
    let (a, b) = (normalize_gamer_name(api), normalize_gamer_name(label));
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }
    let (ac, bc): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let shorter = ac.len().min(bc.len());
    let longer = ac.len().max(bc.len());
    if shorter >= 4 && (a.contains(&b) || b.contains(&a)) {
        return 0.85 + 0.1 * (shorter as f64 / longer as f64);
    }
    1.0 - lev(&ac, &bc) as f64 / longer as f64
}

pub fn roster_entry_score(api: &str, entry: &Value) -> f64 {
    name_similarity(api, &s(entry.get("handle"))).max(name_similarity(api, &s(entry.get("name"))) * 0.97)
}

fn is_empty_slot(e: &Value) -> bool {
    s(e.get("handle")).trim().is_empty() && s(e.get("name")).trim().is_empty()
}

/// pairPlayers(apiPlayers, roster, threshold) -> (pairs (p, r), unmatched p).
pub fn pair_players(api: &[Value], roster: &[Value], threshold: f64) -> (Vec<(usize, usize)>, Vec<usize>) {
    let mut cand: Vec<(usize, usize, f64)> = Vec::new();
    for (p, player) in api.iter().enumerate() {
        for (r, entry) in roster.iter().enumerate() {
            if is_empty_slot(entry) {
                continue;
            }
            let linked = truthy(entry.get("rlPlayerId")) && truthy(player.get("id")) && entry.get("rlPlayerId") == player.get("id");
            let score = if linked { 2.0 } else { roster_entry_score(&s(player.get("name")), entry) };
            if score >= threshold {
                cand.push((p, r, score));
            }
        }
    }
    cand.sort_by(|x, y| y.2.partial_cmp(&x.2).unwrap_or(std::cmp::Ordering::Equal));
    let (mut up, mut ur, mut pairs) = (Vec::new(), Vec::new(), Vec::new());
    for (p, r, _) in cand {
        if up.contains(&p) || ur.contains(&r) {
            continue;
        }
        up.push(p);
        ur.push(r);
        pairs.push((p, r));
    }
    let unmatched = (0..api.len()).filter(|p| !up.contains(p)).collect();
    (pairs, unmatched)
}

/// liveLoadoutKey(loadout).
pub fn live_loadout_key(l: Option<&Value>) -> String {
    l.and_then(Value::as_array).into_iter().flatten().take(3).map(|x| if truthy(Some(x)) { js_string(Some(x)).to_lowercase() } else { String::new() }).collect::<Vec<_>>().join("|")
}

/// needsAutoCar(entry, player).
pub fn needs_auto_car(entry: &Value, player: &Value) -> bool {
    let first = player.pointer("/loadout/0").map(|v| s(Some(v))).unwrap_or_default();
    if !player["loadout"].is_array() || first.trim().is_empty() || first.eq_ignore_ascii_case("none") {
        return false;
    }
    if !truthy(entry.get("characterImage")) {
        return true;
    }
    if !truthy(entry.get("characterImageAuto")) {
        return false;
    }
    entry.get("characterImageLoadout").map(|v| js_string(Some(v))) != Some(live_loadout_key(player.get("loadout")))
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct SyncResult {
    pub changed: bool,
    pub added: Vec<(String, usize, String)>,
    pub linked: Vec<(String, usize, String)>,
    pub renders: Vec<(String, usize, Value)>,
}

/// syncRosterSides(sides, makeSlot, { addMissing }) with sides = (side, roster, players).
pub fn sync_roster_sides(sides: &mut [(String, &mut Vec<Value>, Vec<Value>)], make_slot: &dyn Fn(usize) -> Value, add_missing: bool) -> SyncResult {
    let mut res = SyncResult::default();
    for (side, roster, players) in sides.iter_mut() {
        if players.is_empty() {
            continue;
        }
        let (pairs, unmatched) = pair_players(players, roster, MATCH_THRESHOLD);
        for (p, r) in pairs {
            let id = players[p]["id"].clone();
            if roster[r].get("rlPlayerId") != Some(&id) {
                roster[r]["rlPlayerId"] = id.clone();
                res.changed = true;
            }
            res.linked.push((side.clone(), r, js_string(Some(&id))));
        }
        if add_missing {
            for p in unmatched {
                let player = &players[p];
                let idx = match roster.iter().position(|e| is_empty_slot(e) && !truthy(e.get("characterImage"))) {
                    Some(i) => i,
                    None => {
                        let n = roster.len();
                        roster.push(make_slot(n));
                        n
                    }
                };
                let name = s(player.get("name"));
                roster[idx]["handle"] = json!(String::from_utf16_lossy(&name.encode_utf16().take(24).collect::<Vec<_>>()));
                roster[idx]["rlPlayerId"] = player["id"].clone();
                roster[idx]["autoAdded"] = json!(true);
                res.changed = true;
                res.added.push((side.clone(), idx, js_string(player.get("name"))));
            }
        }
        for (i, e) in roster.iter().enumerate() {
            if !truthy(e.get("rlPlayerId")) {
                continue;
            }
            if let Some(pl) = players.iter().find(|x| x.get("id") == e.get("rlPlayerId")) {
                if needs_auto_car(e, pl) {
                    res.renders.push((side.clone(), i, pl.clone()));
                }
            }
        }
    }
    res
}

/// What handleRocketLeagueEvent asks the controller to do next.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct EventOutcome {
    /// publish live state (scheduleLiveUpdate)
    pub live_update: bool,
    /// a MatchEnded was applied (commit + persist + render)
    pub match_ended: Option<String>,
    /// autoAdvance: advance to the next game after 3 s
    pub advance_later: bool,
    /// car renders wanted (syncRosterFromLive)
    pub renders: Vec<(String, usize, Value)>,
}

/// handleRocketLeagueEvent(envelope) on state (mutates). now = Date.now().
pub fn handle_event(state: &mut Value, env: &Value, now: f64) -> EventOutcome {
    let mut out = EventOutcome::default();
    let roster_key = { let r = s(state.get("activeRoster")); if r.is_empty() { "varsity".to_string() } else { r } };
    let game = &mut state["games"]["rocketleague"];
    let data = env.get("Data").filter(|d| truthy(Some(d))).cloned().unwrap_or(json!({}));
    let ev = env.get("Event").and_then(Value::as_str).unwrap_or("");
    let live_guid = |g: &Value| g.pointer("/rocketLeague/live/matchGuid").cloned().unwrap_or(Value::Null);
    match ev {
        "UpdateState" => {
            let gd = data.get("Game").filter(|v| truthy(Some(v))).cloned().unwrap_or(json!({}));
            let guid = if truthy(data.get("MatchGuid")) { data["MatchGuid"].clone() } else { live_guid(game) };
            let rl_snapshot = game["rocketLeague"].clone();
            let live = &mut game["rocketLeague"]["live"];
            live["matchGuid"] = guid;
            if truthy(rl_snapshot.get("syncClock")) {
                let ts = to_number(gd.get("TimeSeconds").filter(|v| !v.is_null()).or(live.get("timeSeconds"))).unwrap_or(f64::NAN);
                live["timeSeconds"] = if ts.is_nan() { Value::Null } else { jnum(ts) };
                let ot = match gd.get("bOvertime") { None => truthy(live.get("overtime")), v => truthy(v) };
                update_overtime(live, ot, Some(&live["timeSeconds"].clone()));
            }
            let arena = { let a = s(gd.get("Arena")); if a.is_empty() { s(live.get("arena")) } else { a } };
            live["arena"] = json!(rocket_league_arena_name(&arena));
            live["replay"] = json!(truthy(gd.get("bReplay")));
            live["spectatedPlayer"] = json!(s(gd.pointer("/Target/Name")));
            let mut scores = live.get("teamScores").filter(|v| truthy(Some(v))).cloned().unwrap_or(json!([0, 0]));
            for t in gd.get("Teams").and_then(Value::as_array).into_iter().flatten() {
                let n = to_number(t.get("TeamNum")).unwrap_or(f64::NAN);
                if n.is_finite() && n >= 0.0 && n == n.trunc() {
                    let idx = n as usize;
                    let arr = scores.as_array_mut().unwrap();
                    while arr.len() <= idx {
                        arr.push(Value::Null);
                    }
                    arr[idx] = jnum(num_or_zero(t.get("Score")));
                }
            }
            live["teamScores"] = scores;
            apply_scores(game);
            if truthy(game.pointer("/rocketLeague/syncPlayers")) {
                let rl = game["rocketLeague"].clone();
                game["rocketLeague"]["live"]["players"] = Value::Array(normalize_players(&data, &rl));
                update_car_art(game);
                update_recent_events(&mut game["rocketLeague"]["live"], now);
                out.renders = sync_roster_from_live(game, &roster_key);
            }
            out.live_update = true;
        }
        "ClockUpdatedSeconds" if truthy(game.pointer("/rocketLeague/syncClock")) => {
            let guid = if truthy(data.get("MatchGuid")) { data["MatchGuid"].clone() } else { live_guid(game) };
            let live = &mut game["rocketLeague"]["live"];
            live["matchGuid"] = guid;
            let ts = to_number(data.get("TimeSeconds").filter(|v| !v.is_null()).or(live.get("timeSeconds"))).unwrap_or(f64::NAN);
            live["timeSeconds"] = if ts.is_nan() { Value::Null } else { jnum(ts) };
            let ot = match data.get("bOvertime") { None => truthy(live.get("overtime")), v => truthy(v) };
            update_overtime(live, ot, Some(&live["timeSeconds"].clone()));
            out.live_update = true;
        }
        "MatchCreated" => {
            let live = &mut game["rocketLeague"]["live"];
            live["matchGuid"] = json!(s(data.get("MatchGuid")));
            live["timeSeconds"] = json!(300);
            live["overtime"] = json!(false);
            live["overtimeSeconds"] = json!(0);
            live["players"] = json!([]);
            live["recentEvents"] = json!([]);
            live["playerStats"] = json!({});
            live["teamScores"] = json!([0, 0]);
            if truthy(game.pointer("/rocketLeague/syncGoals")) {
                for t in game["teams"].as_array_mut().into_iter().flatten() {
                    t["detailScore"] = json!(0);
                }
            }
            out.live_update = true;
        }
        "MatchEnded" => {
            let guid = { let a = s(data.get("MatchGuid")); if !a.is_empty() { a } else { let b = s(game.pointer("/rocketLeague/live/matchGuid")); if b.is_empty() { format!("MATCH-{}", crate::game_config::num_to_js(now)) } else { b } } };
            if game.pointer("/rocketLeague/processedMatches").and_then(Value::as_array).is_some_and(|a| a.iter().any(|g| g.as_str() == Some(guid.as_str()))) {
                return out;
            }
            let ts = game.pointer("/rocketLeague/live/teamScores").cloned().unwrap_or(Value::Null);
            let winner_rl = match data.get("WinnerTeamNum").and_then(Value::as_f64).filter(|x| *x == x.trunc()) {
                Some(w) => w,
                None => f64::from(u8::from(num_or_zero(ts.get(1)) > num_or_zero(ts.get(0)))),
            };
            let rl = game["rocketLeague"].clone();
            let winner = map_team(Some(&jnum(winner_rl)), &rl);
            crate::actions::save_last_game_stats(game, "rocketleague", &roster_key, now);
            let pm = &mut game["rocketLeague"]["processedMatches"];
            if !pm.is_array() {
                *pm = json!([]);
            }
            let arr = pm.as_array_mut().unwrap();
            arr.push(json!(guid));
            let skip = arr.len().saturating_sub(30);
            *arr = arr.split_off(skip);
            let active = to_number(game.get("activeMap")).map(|x| x as usize);
            let live = game.pointer("/rocketLeague/live").cloned().unwrap_or(json!({}));
            let d0 = js_string(game.pointer("/teams/0/detailScore"));
            let d1 = js_string(game.pointer("/teams/1/detailScore"));
            if let Some(row) = active.and_then(|i| game["mapRows"].get_mut(i)).filter(|r| truthy(Some(r))) {
                let arena = { let a = s(data.pointer("/Game/Arena")); rocket_league_arena_name(if a.is_empty() { live.get("arena").and_then(Value::as_str).unwrap_or("") } else { &a }) };
                if !arena.is_empty() {
                    row["map"] = json!(arena);
                }
                let ot_flag = match data.pointer("/Game/bOvertime") { None | Some(Value::Null) => truthy(live.get("overtime")), v => truthy(v) };
                let ended_ot = ot_flag || num_or_zero(live.get("overtimeSeconds")) > 0.0;
                row["overtime"] = json!(ended_ot);
                let pick = data.pointer("/Game/OvertimeSeconds").filter(|v| !v.is_null()).or(live.get("overtimeSeconds").filter(|v| !v.is_null())).or(data.pointer("/Game/TimeSeconds").filter(|v| !v.is_null())).or(live.get("timeSeconds"));
                row["overtimeSeconds"] = if ended_ot { jnum(num_or_zero(pick).floor().max(0.0)) } else { json!(0) };
                row["winner"] = jnum(winner);
                row["status"] = json!("complete");
                row["score"] = json!([d0, d1]);
            }
            let target = (series_length(game) / 2.0).ceil();
            if truthy(game.pointer("/rocketLeague/autoSeriesScore")) && winner.is_finite() && winner >= 0.0 {
                let w = winner as usize;
                let cur = num_or_zero(game.pointer(&format!("/teams/{w}/score")));
                game["teams"][w]["score"] = jnum(target.min(cur + 1.0));
            }
            let short = s(game.pointer(&format!("/teams/{}/shortName", winner as i64)));
            out.match_ended = Some(format!("{short} game win received"));
            let max_score = game["teams"].as_array().into_iter().flatten().map(|t| num_or_zero(t.get("score"))).fold(f64::NEG_INFINITY, f64::max);
            out.advance_later = truthy(game.pointer("/rocketLeague/autoAdvance")) && max_score < target;
        }
        _ => {}
    }
    out
}

/// After MatchEnded with autoAdvance: the 3 s later step.
pub fn advance_after_win(game: &mut Value) -> usize {
    let vis = visible_len(game);
    let next = ((to_number(game.get("activeMap")).unwrap_or(0.0) + 1.0) as usize).min(vis.saturating_sub(1));
    game["activeMap"] = json!(next);
    for t in game["teams"].as_array_mut().into_iter().flatten() {
        t["detailScore"] = json!(0);
    }
    for (i, row) in game["mapRows"].as_array_mut().into_iter().flatten().enumerate() {
        if row.get("winner") == Some(&Value::Null) {
            row["status"] = json!(if i == next { "ready" } else { "upcoming" });
        }
    }
    next
}

/// app.js seriesLength(game, GAME_CONFIGS.rocketleague): the requested length if it is one of
/// formatOptions, else defaultSeriesLength || mapRows.length.
fn series_length(game: &Value) -> f64 {
    let cfg = crate::game_config::config("rocketleague").unwrap();
    let allowed: Vec<f64> = cfg["formatOptions"].as_array().into_iter().flatten().filter_map(Value::as_f64).collect();
    let fallback = cfg["defaultSeriesLength"].as_f64().filter(|x| *x != 0.0).unwrap_or(game["mapRows"].as_array().map_or(0, Vec::len) as f64);
    let requested = to_number(game.get("seriesLength")).filter(|x| *x != 0.0).unwrap_or(fallback);
    if allowed.is_empty() { requested } else if allowed.contains(&requested) { requested } else { fallback }
}

fn visible_len(game: &Value) -> usize {
    (game["mapRows"].as_array().map_or(0, Vec::len) as f64).min(series_length(game)) as usize
}

/// syncRosterFromLive(game): pairs live players with roster slots; returns wanted car renders.
fn sync_roster_from_live(game: &mut Value, program: &str) -> Vec<(String, usize, Value)> {
    let rl = game["rocketLeague"].clone();
    if !truthy(rl.get("autoRoster")) || !truthy(rl.get("syncPlayers")) {
        return Vec::new();
    }
    let players: Vec<Value> = rl.pointer("/live/players").and_then(Value::as_array).into_iter().flatten().filter(|p| !s(p.get("name")).trim().is_empty()).cloned().collect();
    if players.is_empty() {
        return Vec::new();
    }
    let cfg = crate::game_config::config("rocketleague").unwrap().clone();
    let make = |i: usize| create_player(&cfg, i);
    let by_side = |idx: f64| players.iter().filter(|p| map_team(p.get("teamNum"), &rl) == idx).cloned().collect::<Vec<_>>();
    let (home_players, away_players) = (by_side(0.0), by_side(1.0));
    for coll in ["rosters", "awayRosters"] {
        if !game[coll][program].is_array() {
            game[coll][program] = json!([]);
        }
    }
    let mut home = std::mem::take(game["rosters"][program].as_array_mut().unwrap());
    let mut away = std::mem::take(game["awayRosters"][program].as_array_mut().unwrap());
    let res = {
        let mut sides = vec![("home".to_string(), &mut home, home_players), ("away".to_string(), &mut away, away_players)];
        sync_roster_sides(&mut sides, &make, true)
    };
    game["rosters"][program] = Value::Array(home);
    game["awayRosters"][program] = Value::Array(away);
    if res.added.iter().any(|a| a.0 == "away") {
        game["showAwayRoster"] = json!(true);
    }
    res.renders
}

/// createPlayer(config, index) from src/game-config.js (blank slot).
pub fn create_player(config: &Value, index: usize) -> Value {
    let roles = config["roles"].as_array().cloned().unwrap_or_default();
    let n = roles.len().min(3).max(1);
    json!({ "handle": "", "name": "", "role": roles.get(index % n).cloned().unwrap_or(json!("")), "character": "", "playerImage": "", "playerImageName": "", "characterImage": "", "characterImageName": "", "characterImageAuto": false, "characterImageLoadout": "", "rlPlayerId": "", "autoAdded": false, "stageStation": "" })
}
