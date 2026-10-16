//! Graphics PC side of the spectate link: electron/spectate-receiver.cjs (SpectateReceiver) and
//! electron/spectate-state.cjs (spectateCandidatesFrom, spectateSidesFrom, resolveSpectated).
use std::sync::{Arc, Mutex};

use isu_core::game_config::{js_round, js_string, num_or_zero, to_number, truthy};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::link::{accept_with_key, now_ms, serve_keepalive};

fn norm(v: &str) -> String {
    v.chars().filter(|c| c.is_ascii_alphanumeric()).flat_map(char::to_lowercase).collect()
}

fn sp_norm(s: &str) -> Vec<char> {
    // spectate-tracker.cjs norm (used by matchCandidates)
    s.to_lowercase()
        .chars()
        .map(|c| match c {
            'o' => '0',
            'i' | 'l' | '|' | '!' => '1',
            's' => '5',
            c => c,
        })
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect()
}

fn lev(x: &[char], y: &[char]) -> usize {
    let mut prev: Vec<usize> = (0..=y.len()).collect();
    for i in 1..=x.len() {
        let mut cur = vec![i];
        for j in 1..=y.len() {
            cur.push((prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + usize::from(x[i - 1] != y[j - 1])));
        }
        prev = cur;
    }
    prev[y.len()]
}

fn similarity(a: &str, b: &str) -> f64 {
    let (x, y) = (sp_norm(a), sp_norm(b));
    if x.is_empty() || y.is_empty() {
        return 0.0;
    }
    if x == y {
        return 1.0;
    }
    1.0 - lev(&x, &y) as f64 / x.len().max(y.len()) as f64
}

/// matchCandidates(name, players) best + runner-up score (players = { name, ... }).
fn match_scores(text: &str, players: &[Value]) -> Vec<(usize, f64)> {
    let t = sp_norm(text);
    let mut s: Vec<(usize, f64)> = players
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let name = p["name"].as_str().unwrap_or("");
            let n = sp_norm(name);
            let mut best = similarity(text, name);
            if !n.is_empty() && t.len() > n.len() {
                for w in (n.len() - 1).max(1)..=n.len() + 1 {
                    let mut k = 0;
                    while k + w <= t.len() {
                        let sl: String = t[k..k + w].iter().collect();
                        let n2: String = n.iter().collect();
                        let sc = similarity(&sl, &n2);
                        if sc > best {
                            best = sc;
                        }
                        k += 1;
                    }
                }
            }
            (i, best)
        })
        .collect();
    s.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    s
}

fn s_or(v: Option<&Value>) -> String {
    v.filter(|x| truthy(Some(x))).map(|x| js_string(Some(x))).unwrap_or_default()
}

/// spectateCandidatesFrom(state): roster players (+ their board side/agent) then unclaimed board names.
pub fn candidates_from(state: &Value) -> Vec<Value> {
    let sel = state.get("selectedGame").and_then(Value::as_str).unwrap_or("");
    let empty = json!({});
    let game = state.get("games").and_then(|g| g.get(sel)).unwrap_or(&empty);
    let live = match sel {
        "valorant" => game.pointer("/valorantBoard/live/teams"),
        "overwatch" => game.pointer("/overwatchOcr/live/teams"),
        _ => None,
    };
    let mut players: Vec<Value> = Vec::new();
    for side in ["home", "away"] {
        for p in live.and_then(|l| l.get(side)).and_then(|t| t.get("players")).and_then(Value::as_array).into_iter().flatten() {
            if truthy(p.get("name")) {
                let mut q = p.clone();
                q["side"] = json!(side);
                players.push(q);
            }
        }
    }
    let board_player = |name: &str| -> Option<Value> {
        let exact: Vec<&Value> = players.iter().filter(|p| norm(&s_or(p.get("name"))) == norm(name)).collect();
        if exact.len() == 1 {
            return Some(exact[0].clone());
        }
        let s = match_scores(name, &players);
        let best = s.first()?;
        let ru = s.get(1).map_or(0.0, |r| r.1);
        (best.1 >= 0.8 && best.1 - ru >= 0.15).then(|| players[best.0].clone())
    };
    let mut out: Vec<Value> = Vec::new();
    let mut claimed: Vec<(String, usize)> = Vec::new();
    for (side, coll, ti) in [("home", "rosters", 0), ("away", "awayRosters", 1)] {
        for key in ["varsity", "jv"] {
            for p in game.get(coll).and_then(|r| r.get(key)).and_then(Value::as_array).into_iter().flatten() {
                let name = { let h = s_or(p.get("handle")); if h.is_empty() { s_or(p.get("name")) } else { h } }.trim().to_string();
                if name.is_empty() {
                    continue;
                }
                let row = board_player(&name);
                let current_side = row.as_ref().map_or(side.to_string(), |r| s_or(r.get("side")));
                let ci = if current_side == "home" { 0 } else { 1 };
                let team = { let t = s_or(game.pointer(&format!("/teams/{ci}/name"))); if t.is_empty() { s_or(game.pointer(&format!("/teams/{ti}/name"))) } else { t } };
                let st = js_round(num_or_zero(p.get("stageStation")));
                let cand = json!({ "name": name, "station": if st != 0.0 { isu_core::game_config::jnum(st) } else { Value::Null }, "side": current_side, "team": team, "agent": row.as_ref().map(|r| s_or(r.get("agent"))).unwrap_or_default() });
                let row_key = row.as_ref().map(|r| format!("{}:{}", s_or(r.get("side")), norm(&s_or(r.get("name"))))).unwrap_or_default();
                let existing = claimed.iter().find(|(k, _)| !row_key.is_empty() && *k == row_key).map(|(_, i)| *i).or_else(|| out.iter().position(|c| norm(c["name"].as_str().unwrap()) == norm(&name)));
                match existing {
                    None => {
                        out.push(cand);
                        if !row_key.is_empty() {
                            claimed.push((row_key, out.len() - 1));
                        }
                    }
                    Some(i) => {
                        if out[i]["station"].is_null() && !cand["station"].is_null() {
                            out[i]["station"] = cand["station"].clone();
                        }
                    }
                }
            }
        }
    }
    for (si, side) in ["home", "away"].iter().enumerate() {
        for p in live.and_then(|l| l.get(*side)).and_then(|t| t.get("players")).and_then(Value::as_array).into_iter().flatten() {
            let name = s_or(p.get("name"));
            if name.is_empty() {
                continue;
            }
            let key = format!("{side}:{}", norm(&name));
            if claimed.iter().any(|(k, _)| *k == key) || out.iter().any(|c| norm(c["name"].as_str().unwrap()) == norm(&name)) {
                continue;
            }
            out.push(json!({ "name": name, "station": null, "side": side, "team": s_or(game.pointer(&format!("/teams/{si}/name"))), "agent": s_or(p.get("agent")) }));
        }
    }
    out
}

/// spectateSidesFrom(state): { round, red, teal } for VALORANT, else null.
pub fn sides_from(state: &Value) -> Value {
    let Some(game) = state.pointer("/games/valorant").filter(|_| state.get("selectedGame").and_then(Value::as_str) == Some("valorant")) else { return Value::Null };
    if !truthy(Some(game)) {
        return Value::Null;
    }
    let h = num_or_zero(game.pointer("/teams/0/detailScore"));
    let a = num_or_zero(game.pointer("/teams/1/detailScore"));
    let active = to_number(game.get("activeMap")).filter(|x| *x != 0.0).unwrap_or(0.0) as i64;
    let ov = to_number(game.get("valorantRoundOverride").and_then(|o| o.get(active.to_string())));
    let m = game.pointer("/valorantBoard/live/match");
    let (mh, ma) = (m.and_then(|x| x.get("homeScore")).and_then(Value::as_f64), m.and_then(|x| x.get("awayScore")).and_then(Value::as_f64));
    let score_round = match (mh, ma) {
        (Some(x), Some(y)) => x + y + 1.0,
        _ => h + a + 1.0,
    };
    let round = match ov {
        Some(o) if o == o.trunc() && (1.0..=100.0).contains(&o) => o,
        _ => score_round,
    };
    let board = game.pointer("/valorantBoard/live");
    for (block, raw) in [("top", "home"), ("bottom", "away")] {
        let team = board.and_then(|b| b.pointer(&format!("/blocks/{block}"))).and_then(Value::as_str);
        let color = board.and_then(|b| b.pointer(&format!("/colors/{raw}"))).and_then(Value::as_str);
        if let (Some(t @ ("home" | "away")), Some(c @ ("red" | "teal"))) = (team, color) {
            let other = if t == "home" { "away" } else { "home" };
            return json!({ "round": isu_core::game_config::jnum(round), "red": if c == "red" { t } else { other }, "teal": if c == "teal" { t } else { other } });
        }
    }
    let swapped = if round <= 12.0 { false } else if round <= 24.0 { true } else { ((round - 25.0) % 2.0) == 1.0 };
    let att = game.pointer(&format!("/veto/picks/{active}/attackers"));
    let first_red = match att {
        Some(v @ (Value::Number(_) | Value::String(_))) if ["0", "1"].contains(&js_string(Some(v)).as_str()) => {
            if to_number(Some(v)) == Some(0.0) { "home" } else { "away" }
        }
        _ => "away",
    };
    let red = if swapped { if first_red == "home" { "away" } else { "home" } } else { first_red };
    json!({ "round": isu_core::game_config::jnum(round), "red": red, "teal": if red == "home" { "away" } else { "home" } })
}

/// resolveSpectated(state, spectated): side/team/station from the current candidates.
pub fn resolve(state: &Value, sp: &Value) -> Value {
    let name = s_or(sp.get("name"));
    let game = s_or(sp.get("game"));
    if name.is_empty() || (!game.is_empty() && Some(game.as_str()) != state.get("selectedGame").and_then(Value::as_str)) {
        let mut o = sp.clone();
        o["name"] = json!("");
        return o;
    }
    match candidates_from(state).into_iter().find(|c| norm(c["name"].as_str().unwrap()) == norm(&name)) {
        Some(c) => {
            let mut o = sp.clone();
            o["side"] = c["side"].clone();
            o["team"] = c["team"].clone();
            o["station"] = c["station"].clone();
            o
        }
        None => sp.clone(),
    }
}

// ------------------------------------------------------------------ receiver ---

#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
}

/// normalizeSettings(s).
pub fn normalize_settings(v: &Value) -> Settings {
    let p = to_number(v.get("port")).map(js_round);
    Settings {
        enabled: truthy(v.get("enabled")),
        port: p.filter(|x| (1024.0..=65535.0).contains(x)).map_or(3175, |x| x as u16),
        token: s_or(v.get("token")).trim().chars().take(200).collect(),
    }
}

pub type Callback = Arc<dyn Fn(Value) + Send + Sync>;

struct Inner {
    settings: Settings,
    status: Value,
    clients: Vec<(u64, mpsc::UnboundedSender<String>)>,
    candidates: Value,
    sides: Value,
    server: Option<JoinHandle<()>>,
    next_id: u64,
}

pub struct SpectateReceiver {
    inner: Mutex<Inner>,
    on_spectated: Callback,
    on_status: Callback,
}

impl SpectateReceiver {
    pub fn new(on_spectated: Callback, on_status: Callback) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner { settings: normalize_settings(&json!({})), status: json!({ "state": "disabled", "message": "Spectated-player receiver is off", "clients": 0 }), clients: Vec::new(), candidates: json!([]), sides: Value::Null, server: None, next_id: 1 }),
            on_spectated,
            on_status,
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// getStatus(): token shown as '(set)'.
    pub fn status(&self) -> Value {
        let g = self.lock();
        let mut s = g.status.clone();
        s["settings"] = json!({ "enabled": g.settings.enabled, "port": g.settings.port, "token": if g.settings.token.is_empty() { "" } else { "(set)" } });
        s
    }

    fn set_status(&self, state: &str, message: &str) {
        {
            let mut g = self.lock();
            g.status = json!({ "state": state, "message": message, "clients": g.clients.len(), "port": g.settings.port });
        }
        (self.on_status)(self.status());
    }

    /// configure(next): restart on a new port / key or when turned off.
    pub fn configure(self: &Arc<Self>, next: &Value) -> Value {
        let mut merged = { let g = self.lock(); json!({ "enabled": g.settings.enabled, "port": g.settings.port, "token": g.settings.token }) };
        for (k, v) in next.as_object().cloned().unwrap_or_default() {
            merged[k] = v;
        }
        let before = self.lock().settings.clone();
        let s = normalize_settings(&merged);
        self.lock().settings = s.clone();
        let running = self.lock().server.is_some();
        if !running || before.port != s.port || before.token != s.token || !s.enabled {
            self.stop();
        }
        if s.enabled && self.lock().server.is_none() {
            self.start();
        }
        if !s.enabled {
            self.set_status("disabled", "Spectated-player receiver is off");
        }
        self.status()
    }

    fn start(self: &Arc<Self>) {
        let s = self.lock().settings.clone();
        if s.token.is_empty() {
            return self.set_status("error", "Generate a bridge key first");
        }
        let me = Arc::clone(self);
        let h = tokio::spawn(async move {
            let listener = match tokio::net::TcpListener::bind(("0.0.0.0", s.port)).await {
                Ok(l) => l,
                Err(e) => {
                    let code = if e.kind() == std::io::ErrorKind::AddrInUse { "EADDRINUSE".to_string() } else { e.to_string() };
                    return me.set_status("error", &format!("Port {}: {code}", s.port));
                }
            };
            me.set_status("listening", &format!("Waiting for the spectator Game Bridge on port {}", s.port));
            loop {
                let Ok((tcp, _)) = listener.accept().await else { continue };
                let me2 = Arc::clone(&me);
                let token = s.token.clone();
                let port = s.port;
                tokio::spawn(async move {
                    let Some(ws) = accept_with_key(tcp, &token).await else { return };
                    let (tx, rx) = mpsc::unbounded_channel::<String>();
                    let id = {
                        let mut g = me2.lock();
                        let id = g.next_id;
                        g.next_id += 1;
                        g.clients.push((id, tx.clone()));
                        id
                    };
                    me2.set_status("connected", "Spectator Game Bridge connected");
                    {
                        let g = me2.lock();
                        if g.candidates.as_array().is_some_and(|c| !c.is_empty()) {
                            let _ = tx.send(json!({ "type": "spectate-candidates", "candidates": g.candidates, "sides": g.sides }).to_string());
                        }
                    }
                    let _ = tx.send(json!({ "type": "welcome", "version": 1 }).to_string());
                    let me3 = Arc::clone(&me2);
                    serve_keepalive(ws, move |text| {
                        if let Ok(p) = serde_json::from_str::<Value>(text) {
                            if p["type"] == "spectated" && p["payload"].is_object() {
                                let mut sp = p["payload"].clone();
                                sp["game"] = json!(s_or(p.get("game")));
                                sp["receivedAt"] = isu_core::game_config::jnum(now_ms());
                                (me3.on_spectated)(sp);
                            }
                        }
                    }, Some(rx))
                    .await;
                    me2.lock().clients.retain(|(i, _)| *i != id);
                    me2.set_status("listening", &format!("Spectator Game Bridge disconnected; waiting on port {port}"));
                });
            }
        });
        self.lock().server = Some(h);
    }

    pub fn stop(&self) {
        let mut g = self.lock();
        g.clients.clear();
        if let Some(h) = g.server.take() {
            h.abort();
        }
    }

    /// setCandidates(list, sides): cleaned, sent to every bridge when changed.
    pub fn set_candidates(&self, list: &[Value], sides: &Value) -> usize {
        let next: Vec<Value> = list
            .iter()
            .filter(|c| c.is_object() && !s_or(c.get("name")).trim().is_empty())
            .take(40)
            .map(|c| {
                let side = c.get("side").and_then(Value::as_str);
                json!({
                    "name": s_or(c.get("name")).trim().chars().take(40).collect::<String>(),
                    "station": to_number(c.get("station")).filter(|x| *x != 0.0).map_or(Value::Null, isu_core::game_config::jnum),
                    "side": match side { Some("away") => "away", Some("home") => "home", _ => "" },
                    "team": s_or(c.get("team")).chars().take(60).collect::<String>(),
                    "agent": s_or(c.get("agent")).chars().filter(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || *ch == '-').take(20).collect::<String>(),
                })
            })
            .collect();
        let next_sides = match sides.get("red").and_then(Value::as_str) {
            Some("home" | "away") => json!({ "red": sides["red"], "teal": sides.get("teal").cloned().unwrap_or(Value::Null), "round": to_number(sides.get("round")).filter(|x| *x != 0.0).map_or(json!(0), isu_core::game_config::jnum) }),
            _ => Value::Null,
        };
        let n = next.len();
        let mut g = self.lock();
        if Value::Array(next.clone()) == g.candidates && next_sides == g.sides {
            return n;
        }
        g.candidates = Value::Array(next);
        g.sides = next_sides;
        let msg = json!({ "type": "spectate-candidates", "candidates": g.candidates, "sides": g.sides }).to_string();
        g.clients.retain(|(_, tx)| tx.send(msg.clone()).is_ok());
        n
    }
}
