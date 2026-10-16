//! The controller core (no UI): what src/app.js does outside rendering plus the electron/main.cjs
//! wiring. One Core per app; the egui window and the services all go through it.
//!   state + history (30 undo steps) + commit (save 120 ms later, then publish)  app.js commit/persistState
//!   publish -> overlay hub + Companion + spectate candidates                     main.cjs publishBroadcastState
//!   Companion actions                                                            app.js executeCompanionAction
//!   Rocket League events / status                                                app.js handleRocketLeagueEvent
//!   VALORANT board / Overwatch snapshots -> roster + round score                 app.js onValorantBoardState / onOverwatchOcrState
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use isu_core::game_config::{js_string, truthy};
use serde_json::{Value, json};

use crate::settings::Files;

pub const HISTORY: usize = 30;

/// Parts of the state that only live feeds write; Undo keeps their current value.
const LIVE_PATHS: [&str; 4] = ["/games/rocketleague/rocketLeague/live", "/games/valorant/valorantBoard", "/games/valorant/valorantOcr/live/match", "/games/overwatch/overwatchOcr"];

pub fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

#[derive(Default)]
pub struct Inner {
    pub state: Value,
    pub history: Vec<Value>,
    pub save_status: String,
    pub save_at: Option<Instant>,
    pub publish_at: Option<Instant>,
    /// the VALORANT reader's own view (status, settings, decision) next to the published board
    pub valorant_board: Value,
    pub overwatch_ocr: Value,
    pub rl_status: Value,
    pub display_status: Value,
    pub spectate: Value,
    pub rl_advance_at: Option<Instant>,
    /// roster gamertags for the VALORANT reader (app.js setValorantBoardKnownNames), last one sent
    pub known_names_sent: String,
    pub dirty_ui: bool,
}

pub struct Core {
    pub inner: Mutex<Inner>,
    pub files: Files,
    pub store: Arc<isu_server::Store>,
    /// called with every published state (overlay + Companion + spectate candidates are wired by app.rs)
    pub on_publish: Mutex<Vec<Box<dyn Fn(&Value) + Send + Sync>>>,
    pub repaint: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

fn clone(v: &Value) -> Value {
    v.clone()
}

impl Core {
    pub fn new(files: Files, store: Arc<isu_server::Store>) -> Arc<Self> {
        let state = files.load_state();
        Arc::new(Self {
            inner: Mutex::new(Inner {
                state,
                save_status: "Ready".into(),
                valorant_board: json!({ "status": { "state": "disabled", "message": "" }, "settings": {} }),
                overwatch_ocr: json!({ "settings": { "enabled": false, "windowName": "Overwatch", "intervalMs": 500 }, "status": { "state": "disabled", "message": "Overwatch OCR is off" }, "live": null }),
                rl_status: json!({ "state": "disabled", "message": "Live data is off" }),
                display_status: json!({ "port": 3178, "onlineCount": 0, "stations": [] }),
                spectate: json!({ "settings": {}, "status": {}, "spectated": {} }),
                ..Default::default()
            }),
            files,
            store,
            on_publish: Mutex::new(Vec::new()),
            repaint: Mutex::new(None),
        })
    }

    pub fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn state(&self) -> Value {
        self.lock().state.clone()
    }

    pub(crate) fn repaint(&self) {
        // egui may already be rendering while a service requests a repaint. Never hold
        // our callback lock while entering egui: the UI also requests repaints on edits.
        let repaint = self.repaint.lock().unwrap().clone();
        if let Some(r) = repaint {
            r();
        }
    }

    /// commit(mutator, message): undo point, change, save + publish 120 ms later.
    pub fn commit(&self, message: &str, f: impl FnOnce(&mut Value)) {
        let mut g = self.lock();
        let snap = clone(&g.state);
        g.history.push(snap);
        if g.history.len() > HISTORY {
            g.history.remove(0);
        }
        f(&mut g.state);
        g.save_at = Some(Instant::now() + Duration::from_millis(120));
        g.save_status = message.to_string();
        g.dirty_ui = true;
        drop(g);
        self.repaint();
    }

    pub fn undo(&self) -> bool {
        let mut g = self.lock();
        let Some(mut prev) = g.history.pop() else { return false };
        // Undo is for the operator's edits. Live readings (Rocket League feed, scoreboard readers)
        // always stay at their newest value, so Undo mid-game never rolls back the live clock/board.
        for p in LIVE_PATHS {
            if let Some(now) = g.state.pointer(p).cloned() {
                if let Some(slot) = prev.pointer_mut(p) {
                    *slot = now;
                }
            }
        }
        g.state = prev;
        g.save_status = "Undid last change".into();
        drop(g);
        self.persist();
        true
    }

    /// persistState(): clamp the transition, stamp updatedAt, write, publish.
    pub fn persist(&self) {
        let snapshot = {
            let mut g = self.lock();
            let t = isu_core::game_config::to_number(g.state.get("programTransitionSeconds")).filter(|x| *x != 0.0 && !x.is_nan()).unwrap_or(1.0);
            g.state["programTransitionSeconds"] = isu_core::game_config::jnum(t.clamp(0.1, 5.0));
            g.state = isu_core::store::save_state(&g.state, &isu_server::store::iso_now());
            g.save_at = None;
            g.state.clone()
        };
        self.files.save_state(&snapshot);
        self.publish_now(&snapshot);
    }

    /// publishState(state) without saving (live updates).
    pub fn publish_now(&self, state: &Value) {
        if state.get("selectedGame").and_then(Value::as_str) == Some("rocketleague") {
            let sp = isu_ocr::spectate::rocket_league_spectated(state, now_ms());
            self.store.lock().spectated = isu_server::store::Spectated {
                name: isu_core::game_config::text(sp.get("name")),
                station: sp.get("station").and_then(Value::as_f64),
                side: sp.get("side").and_then(Value::as_str).unwrap_or("").into(),
                team: sp.get("team").and_then(Value::as_str).unwrap_or("").into(),
                received_at: sp.get("receivedAt").and_then(Value::as_f64).unwrap_or(0.0),
            };
        }
        for f in self.on_publish.lock().unwrap().iter() {
            f(state);
        }
        self.store.publish(state.clone());
    }

    /// scheduleLiveUpdate(): publish within updateIntervalMs (1..50, default 33).
    pub fn schedule_live(&self) {
        let mut g = self.lock();
        if g.publish_at.is_none() {
            let ms = isu_core::game_config::to_number(g.state.pointer("/games/rocketleague/rocketLeague/updateIntervalMs")).filter(|x| *x != 0.0).unwrap_or(33.0).clamp(1.0, 50.0);
            g.publish_at = Some(Instant::now() + Duration::from_millis(ms as u64));
        }
        g.dirty_ui = true;
    }

    /// The timers app.js keeps with setTimeout. Call often (every ~10 ms) from a background thread.
    pub fn tick(&self) {
        let now = Instant::now();
        let (save, publish, advance) = {
            let g = self.lock();
            (g.save_at.is_some_and(|t| now >= t), g.publish_at.is_some_and(|t| now >= t), g.rl_advance_at.is_some_and(|t| now >= t))
        };
        if save {
            self.persist();
        } else if publish {
            let s = { let mut g = self.lock(); g.publish_at = None; g.state.clone() };
            self.publish_now(&s);
        }
        if advance {
            self.lock().rl_advance_at = None;
            self.commit("Advanced to the next game", |st| {
                let n = isu_core::rocket_league::advance_after_win(&mut st["games"]["rocketleague"]);
                let _ = n;
            });
        }
        if save || publish {
            self.repaint();
        }
    }

    // ---- Companion (app.js executeCompanionAction) ----
    pub fn companion_action(&self, request: &Value) -> Result<Value, (u16, String)> {
        let mut next = self.state();
        let r = isu_core::actions::apply_companion_action(&mut next, request, now_ms()).map_err(|e| (e.status, e.message))?;
        let res = r.to_json();
        if truthy(res.get("teamsSwapped")) && res.get("gameKey") == next.get("selectedGame") {
            next["activeRosterSide"] = json!(if next["activeRosterSide"] == "away" { "home" } else { "away" });
        }
        {
            let mut g = self.lock();
            let snap = clone(&g.state);
            g.history.push(snap);
            if g.history.len() > HISTORY {
                g.history.remove(0);
            }
            g.state = next;
            g.save_status = format!("Companion: {}", js_string(res.get("message")));
            g.dirty_ui = true;
        }
        self.persist();
        self.repaint();
        Ok(res)
    }

    // ---- Rocket League ----
    pub fn rl_event(&self, env: &Value) -> Vec<(String, usize, Value)> {
        let (out, roster_msg) = {
            let mut g = self.lock();
            let before = g.state.pointer("/games/rocketleague/rosters").cloned();
            let before_away = g.state.pointer("/games/rocketleague/awayRosters").cloned();
            let snap = clone(&g.state);
            let out = isu_core::rocket_league::handle_event(&mut g.state, env, now_ms());
            let roster_changed = g.state.pointer("/games/rocketleague/rosters").cloned() != before || g.state.pointer("/games/rocketleague/awayRosters").cloned() != before_away;
            if out.match_ended.is_some() || roster_changed {
                g.history.push(snap);
                if g.history.len() > HISTORY {
                    g.history.remove(0);
                }
            }
            if out.advance_later {
                g.rl_advance_at = Some(Instant::now() + Duration::from_secs(3));
            }
            (out, roster_changed)
        };
        if let Some(m) = &out.match_ended {
            self.lock().save_status = m.clone();
            self.persist();
        } else if roster_msg {
            let mut g = self.lock();
            g.save_status = "Roster synced from live players".into();
            g.save_at = Some(Instant::now() + Duration::from_millis(120));
        }
        if out.live_update {
            self.schedule_live();
        }
        self.repaint();
        out.renders
    }

    pub fn rl_status(&self, status: &Value) {
        let mut g = self.lock();
        let live = &mut g.state["games"]["rocketleague"]["rocketLeague"]["live"];
        for (k, v) in status.as_object().cloned().unwrap_or_default() {
            live[k] = v;
        }
        let st = status.get("state").or(status.get("status")).filter(|v| truthy(Some(v))).cloned().unwrap_or_else(|| live["status"].clone());
        live["status"] = st;
        g.rl_status = status.clone();
        drop(g);
        self.schedule_live();
        self.repaint();
    }

    /// syncRocketLeagueConnection(): the settings the RL service should run with.
    pub fn rl_connection(&self) -> Value {
        let g = self.lock();
        let mut rl = g.state.pointer("/games/rocketleague/rocketLeague").cloned().unwrap_or(json!({}));
        rl["savedEnabled"] = json!(truthy(rl.get("enabled")));
        rl["enabled"] = json!(g.state["selectedGame"] == "rocketleague" && truthy(rl.get("enabled")));
        rl
    }

    // ---- VALORANT board (app.js onValorantBoardState) ----
    pub fn valorant_board_snapshot(&self, snap: &Value) -> Option<Value> {
        let mut roster_msg = None;
        let mut score_msg = None;
        let hint = {
            let mut g = self.lock();
            // mergeValorantBoardSnapshot
            let mut board = snap.clone();
            let status = board.as_object_mut().and_then(|o| o.remove("status"));
            let align = board.as_object_mut().and_then(|o| o.remove("align")).unwrap_or(Value::Null);
            board["align"] = align;
            g.valorant_board["live"] = board;
            if let Some(s) = status.filter(|s| truthy(Some(s))) {
                g.valorant_board["status"] = s;
            }
            if let Some(m) = snap.get("match").filter(|m| truthy(Some(m))) {
                let ocr = &mut g.state["games"]["valorant"]["valorantOcr"];
                if !ocr["live"].is_object() {
                    ocr["live"] = json!({});
                }
                ocr["live"]["match"] = json!({ "timerSeconds": m.pointer("/timer/seconds").cloned().unwrap_or(Value::Null), "timerDisplay": m.pointer("/timer/display").filter(|v| truthy(Some(v))).cloned().unwrap_or(json!("")), "lowTime": truthy(m.pointer("/timer/lowTime")), "spikePlanted": truthy(m.get("spikePlanted")), "updatedAt": m.get("updatedAt").filter(|v| truthy(Some(v))).cloned().unwrap_or(json!(0)) });
                if let (Some(h), Some(a)) = (m.get("homeScore").and_then(Value::as_f64), m.get("awayScore").and_then(Value::as_f64)) {
                    let mut st = g.state.clone();
                    if isu_core::boards::sync_valorant_ocr_scores(&mut st["games"]["valorant"], &json!({ "teams": { "home": { "score": h }, "away": { "score": a } } }), now_ms()) {
                        let snapb = std::mem::replace(&mut g.state, st);
                        g.history.push(snapb);
                        if g.history.len() > HISTORY { g.history.remove(0); }
                        score_msg = Some(format!("Round score {}-{}", isu_core::game_config::num_to_js(h), isu_core::game_config::num_to_js(a)));
                    } else {
                        g.state = st;
                    }
                }
            }
            // publishValorantBoard: blocks -> teams
            let game = &g.state["games"]["valorant"];
            let prev_top = game.pointer("/valorantBoard/live/blocks/top").filter(|v| truthy(Some(v))).cloned();
            let live = g.valorant_board["live"].clone();
            let hint = if live.get("teams").is_some_and(|t| truthy(Some(t))) {
                let (mapped, decision) = isu_core::boards::map_board_to_teams(game, &live, prev_top.map(|t| json!({ "top": t })).as_ref());
                g.valorant_board["decision"] = decision.clone();
                g.state["games"]["valorant"]["valorantBoard"] = json!({ "live": mapped });
                let tags = |r: &Value| -> Vec<String> { ["varsity", "jv"].iter().flat_map(|k| r.get(*k).and_then(Value::as_array).cloned().unwrap_or_default()).map(|p| isu_core::game_config::text(p.get("handle")).trim().to_string()).filter(|s| !s.is_empty()).collect() };
                let game = &g.state["games"]["valorant"];
                let top_home = decision["top"] == "home";
                Some((tags(if top_home { &game["rosters"] } else { &game["awayRosters"] }), tags(if top_home { &game["awayRosters"] } else { &game["rosters"] })))
            } else {
                g.state["games"]["valorant"]["valorantBoard"] = json!({ "live": live });
                None
            };
            // roster autofill
            if g.state["games"]["valorant"].get("valorantAgentAutofill") != Some(&json!(false)) {
                let key = { let r = js_string(g.state.get("activeRoster")); if r.is_empty() || r == "null" { "varsity".to_string() } else { r } };
                let mut preview = g.state["games"]["valorant"].clone();
                let ch = isu_core::boards::sync_valorant_roster(&mut preview, &key, true);
                if !ch.is_empty() {
                    let snapb = clone(&g.state);
                    g.history.push(snapb);
                    if g.history.len() > HISTORY { g.history.remove(0); }
                    g.state["games"]["valorant"] = preview;
                    roster_msg = Some(format!("Roster: {}", ch.iter().map(change_label).collect::<Vec<_>>().join(", ")));
                }
            }
            hint
        };
        if let Some(m) = roster_msg.or(score_msg) {
            let mut g = self.lock();
            g.save_status = m;
            g.save_at = Some(Instant::now() + Duration::from_millis(120));
        }
        {
            let mut g = self.lock();
            if g.publish_at.is_none() {
                g.publish_at = Some(Instant::now() + Duration::from_millis(100));
            }
            g.dirty_ui = true;
        }
        self.repaint();
        hint.map(|(h, a)| json!({ "home": h, "away": a }))
    }

    pub fn valorant_board_status(&self, status: &Value) {
        let mut g = self.lock();
        g.valorant_board["status"] = status.clone();
        g.dirty_ui = true;
    }

    // ---- Overwatch OCR (app.js onOverwatchOcrState) ----
    pub fn overwatch_snapshot(&self, snap: &Value) {
        if !snap.get("teams").is_some_and(|t| truthy(Some(t))) {
            return;
        }
        let strip = |side: &str| -> Value {
            Value::Array(snap.pointer(&format!("/teams/{side}/players")).and_then(Value::as_array).into_iter().flatten().map(|p| {
                let mut o = json!({});
                for k in ["side", "slot", "name", "hero", "ultimate", "elims", "assists", "deaths", "damage", "healing", "mitigation"] {
                    if let Some(v) = p.get(k) { o[k] = v.clone(); }
                }
                o["nameManual"] = json!(truthy(p.get("nameManual")));
                o
            }).collect())
        };
        let mut msg = None;
        {
            let mut g = self.lock();
            let updated = snap.get("updatedAt").filter(|v| truthy(Some(v))).cloned().unwrap_or_else(|| isu_core::game_config::jnum(now_ms()));
            let live = json!({ "teams": { "home": { "players": strip("home") }, "away": { "players": strip("away") } }, "updatedAt": updated });
            g.overwatch_ocr["live"] = live.clone();
            if let Some(s) = snap.get("status").filter(|s| truthy(Some(s))) {
                g.overwatch_ocr["status"] = s.clone();
            }
            if g.state["games"].get("overwatch").is_some() {
                g.state["games"]["overwatch"]["overwatchOcr"] = json!({ "live": live });
                if g.state["games"]["overwatch"].get("overwatchHeroAutofill") != Some(&json!(false)) {
                    let key = { let r = js_string(g.state.get("activeRoster")); if r.is_empty() || r == "null" { "varsity".to_string() } else { r } };
                    let mut preview = g.state["games"]["overwatch"].clone();
                    let ch = isu_core::boards::sync_roster_from_ocr(&mut preview, &key, true);
                    if !ch.is_empty() {
                        let snapb = clone(&g.state);
                        g.history.push(snapb);
                        if g.history.len() > HISTORY { g.history.remove(0); }
                        g.state["games"]["overwatch"] = preview;
                        msg = Some(format!("Roster: {}", ch.iter().map(change_label).collect::<Vec<_>>().join(", ")));
                    }
                }
            }
            if g.publish_at.is_none() {
                g.publish_at = Some(Instant::now() + Duration::from_millis(100));
            }
            if let Some(m) = &msg {
                g.save_status = m.clone();
                g.save_at = Some(Instant::now() + Duration::from_millis(120));
            }
            g.dirty_ui = true;
        }
        self.repaint();
    }

    pub fn overwatch_status(&self, status: &Value) {
        let mut g = self.lock();
        g.overwatch_ocr["status"] = status.clone();
        g.dirty_ui = true;
    }
}

/// label(c) of the roster autofill messages in app.js.
fn change_label(c: &Value) -> String {
    let (f, h, to) = (js_string(c.get("field")), js_string(c.get("handle")), js_string(c.get("to")));
    match f.as_str() {
        "handle" => format!("added {to}"),
        "role" => format!("{h} role → {to}"),
        _ => format!("{h} → {to}"),
    }
}
