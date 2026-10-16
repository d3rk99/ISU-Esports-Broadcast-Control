//! Game PC side: electron/game-bridge.cjs (normalizeBridgeSettings, normalizeSpectateSettings,
//! createGameEnvelope, UniversalGameBridge). The spectate tracker and capture are passed in as a
//! `Spectator` so this crate does not depend on OCR (isu-bridge wires isu-ocr in).
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use isu_core::game_config::{js_round, js_string, to_number, truthy};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::link::{BRIDGE_PING_INTERVAL_MS, now_ms};
use crate::rocket_league::{self as rl, RocketLeagueService};

pub const SUPPORTED_GAMES: [&str; 3] = ["rocketleague", "valorant", "overwatch"];

/// Spectate DEFAULT_ROIS / DEFAULT_PORTRAITS (spectate-tracker.cjs).
fn default_roi(game: &str) -> [f64; 4] {
    match game {
        "overwatch" => [150.0, 954.0, 200.0, 40.0],
        "rocketleague" => [660.0, 930.0, 600.0, 60.0],
        _ => [113.0, 816.0, 213.0, 41.0],
    }
}

/// normalizeSpectateSettings(raw, game).
pub fn normalize_spectate(raw: &Value, game: &str) -> Value {
    let def = default_roi(if ["valorant", "overwatch", "rocketleague"].contains(&game) { game } else { "valorant" });
    let empty = json!({});
    let r = raw.get("roi").filter(|v| v.is_object()).unwrap_or(&empty);
    let n = |v: Option<&Value>, d: f64, lo: f64, hi: f64| {
        let x = to_number(v).filter(|x| x.is_finite()).unwrap_or(d);
        js_round(x).clamp(lo, hi)
    };
    let window = raw.get("windowName").filter(|v| truthy(Some(v))).map(|v| js_string(Some(v))).unwrap_or_else(|| {
        match game {
            "valorant" => "VALORANT",
            "overwatch" => "Overwatch",
            _ => "Rocket League",
        }
        .to_string()
    });
    let method = if game == "valorant" && raw.get("method").and_then(Value::as_str) == Some("icon") { "icon" } else { "both" };
    let portrait = if game == "valorant" {
        let pr = raw.get("portrait").filter(|v| v.is_object()).unwrap_or(&empty);
        json!({ "x": n(pr.get("x"), 31.0, 0.0, 1900.0), "y": n(pr.get("y"), 794.0, 0.0, 1060.0), "s": n(pr.get("s"), 81.0, 20.0, 300.0) })
    } else {
        Value::Null
    };
    let j = isu_core::game_config::jnum;
    json!({
        "enabled": truthy(raw.get("enabled")),
        "windowName": window.chars().take(120).collect::<String>(),
        "intervalMs": j(n(raw.get("intervalMs"), 250.0, 120.0, 2000.0)),
        "method": method,
        "roi": { "x": j(n(r.get("x"), def[0], 0.0, 1900.0)), "y": j(n(r.get("y"), def[1], 0.0, 1060.0)), "w": j(n(r.get("w"), def[2], 20.0, 1920.0)), "h": j(n(r.get("h"), def[3], 10.0, 300.0)) },
        "portrait": portrait.as_object().map(|p| Value::Object(p.iter().map(|(k, v)| (k.clone(), j(v.as_f64().unwrap()))).collect())).unwrap_or(Value::Null)
    })
}

/// normalizeBridgeSettings(settings).
pub fn normalize_settings(v: &Value) -> Value {
    let game = v.get("game").and_then(Value::as_str).filter(|g| SUPPORTED_GAMES.contains(g)).unwrap_or("rocketleague");
    let mut out = v.as_object().cloned().unwrap_or_default();
    let s = |k: &str| v.get(k).filter(|x| truthy(Some(x))).map(|x| js_string(Some(x))).unwrap_or_default().trim().to_string();
    out.insert("game".into(), json!(game));
    out.insert("graphicsHost".into(), json!(s("graphicsHost")));
    out.insert("bridgePort".into(), json!(rl::safe_port(v.get("bridgePort"), 3175)));
    out.insert("bridgeToken".into(), json!(s("bridgeToken")));
    // rocketLeague: normalizeRocketLeagueSettings({ ...(settings.rocketLeague || settings), enabled: true, source: 'local' })
    let mut rl_in = v.get("rocketLeague").filter(|x| truthy(Some(x))).cloned().unwrap_or_else(|| v.clone());
    if !rl_in.is_object() {
        rl_in = json!({});
    }
    rl_in["enabled"] = json!(true);
    rl_in["source"] = json!("local");
    out.insert("rocketLeague".into(), rl::settings_json(&rl::normalize_settings(&rl_in)));
    let mut sp = normalize_spectate(v.get("spectate").unwrap_or(&json!({})), game);
    sp["enabled"] = json!(game != "rocketleague");
    out.insert("spectate".into(), sp);
    Value::Object(out)
}

/// createGameEnvelope(game, payload, sequence, capturedAt).
pub fn envelope(game: &str, payload: &Value, sequence: u64, captured_at: f64) -> Value {
    json!({ "type": if game == "rocketleague" { "game-telemetry" } else { "game-state" }, "game": game, "version": 1, "sequence": sequence, "capturedAt": isu_core::game_config::jnum(captured_at), "payload": payload })
}

/// What the spectate loops need from the OCR side (implemented by isu-bridge with isu-ocr).
pub trait Spectator: Send + Sync {
    /// New candidates / sides from the controller.
    fn set_candidates(&self, list: &[Value], sides: &Value);
    /// 'eng' | 'val' | 'ow'
    fn set_lang(&self, lang: &str);
    fn clear(&self);
    /// One frame newer than `after` (seq), with the capture time in ms; Err = message.
    fn next_frame(&self, window: &str, after: Option<u64>) -> Result<(u64, f64), String>;
    /// Portrait fast path on the latest frame -> Some((changed, spectated)).
    fn portrait_step(&self, portrait: &Value) -> Option<(bool, Value)>;
    /// report(null) for icon-only mode.
    fn report_none(&self) -> (bool, Value);
    /// Name path (the 4 cleanups) on the latest frame, then report(winner).
    fn name_step(&self, roi: &Value) -> (bool, Value);
    fn why_not(&self) -> String;
    /// last sweep detail for the UI
    fn last(&self) -> Value;
}

pub type Callback = Arc<dyn Fn(Value) + Send + Sync>;

struct Inner {
    settings: Option<Value>,
    remote_status: Value,
    source_status: Value,
    sent: u64,
    remote_tx: Option<mpsc::UnboundedSender<String>>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    last_spectate_sent: f64,
    last_spectate_ui: f64,
}

pub struct GameBridge {
    inner: Mutex<Inner>,
    seq: AtomicU64,
    epoch: AtomicU64,
    pub rocket_league: Arc<RocketLeagueService>,
    spectator: Option<Arc<dyn Spectator>>,
    on_status: Callback,
    on_ocr_state: Callback,
}

impl GameBridge {
    pub fn new(spectator: Option<Arc<dyn Spectator>>, on_status: Callback, on_ocr_state: Callback) -> Arc<Self> {
        Arc::new_cyclic(|weak: &std::sync::Weak<GameBridge>| {
            let (w1, w2) = (weak.clone(), weak.clone());
            let rocket_league = RocketLeagueService::new(
                Arc::new(move |ev| {
                    if let Some(b) = w1.upgrade() {
                        b.forward("rocketleague", &ev);
                    }
                }),
                Arc::new(move |st| {
                    if let Some(b) = w2.upgrade() {
                        b.report_source(st);
                    }
                }),
            );
            GameBridge {
                inner: Mutex::new(Inner { settings: None, remote_status: json!({ "state": "disabled", "message": "Not connected" }), source_status: json!({ "state": "disabled", "message": "Game adapter is stopped" }), sent: 0, remote_tx: None, tasks: Vec::new(), last_spectate_sent: 0.0, last_spectate_ui: 0.0 }),
                seq: AtomicU64::new(0),
                epoch: AtomicU64::new(0),
                rocket_league,
                spectator,
                on_status,
                on_ocr_state,
            }
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// getStatus().
    pub fn status(&self) -> Value {
        let g = self.lock();
        let mut remote = g.remote_status.clone();
        remote["sentPackets"] = json!(g.sent);
        json!({ "game": g.settings.as_ref().and_then(|s| s["game"].as_str()).unwrap_or("rocketleague"), "remote": remote, "source": g.source_status })
    }

    fn report(&self) {
        (self.on_status)(self.status());
    }

    fn report_source(&self, st: Value) {
        self.lock().source_status = st;
        self.report();
    }

    pub fn settings(&self) -> Option<Value> {
        self.lock().settings.clone()
    }

    /// start(settings).
    pub fn start(self: &Arc<Self>, settings: &Value) -> Value {
        self.stop();
        let s = normalize_settings(settings);
        {
            let mut g = self.lock();
            g.settings = Some(s.clone());
            g.sent = 0;
        }
        self.seq.store(0, Ordering::Release);
        if s["graphicsHost"] == "" || s["bridgeToken"] == "" {
            self.lock().remote_status = json!({ "state": "error", "message": "Graphics PC address and bridge key are required" });
            self.report();
            return self.status();
        }
        self.start_game_source();
        self.connect_remote();
        self.status()
    }

    /// updateConfig(settings): restart only for a new game / host / port / key.
    pub fn update_config(self: &Arc<Self>, settings: &Value) -> Value {
        let prev = self.settings();
        let s = normalize_settings(settings);
        self.lock().settings = Some(s.clone());
        let Some(p) = prev.filter(|p| p["graphicsHost"] != "" && p["bridgeToken"] != "") else { return self.status() };
        if ["game", "graphicsHost", "bridgePort", "bridgeToken"].iter().any(|k| p[*k] != s[*k]) {
            return self.start(&s);
        }
        self.start_game_source();
        self.status()
    }

    fn start_game_source(self: &Arc<Self>) {
        let s = self.settings().unwrap();
        if s["game"] != "rocketleague" {
            self.rocket_league.stop();
            self.start_spectate(&s);
            return;
        }
        let mut cfg = s["rocketLeague"].clone();
        cfg["updateIntervalMs"] = json!(1);
        self.rocket_league.configure(&cfg);
    }

    /// The spectate loops: every new frame -> portrait (fast); otherwise the name OCR in the
    /// background (one at a time); icon-only mode reports nobody when the portrait has no player.
    fn start_spectate(self: &Arc<Self>, s: &Value) {
        let Some(sp) = self.spectator.clone() else { return };
        let epoch = self.epoch.load(Ordering::Acquire);
        let cfg = s["spectate"].clone();
        sp.set_lang(match s["game"].as_str() {
            Some("overwatch") => "ow",
            Some("valorant") => "val",
            _ => "eng",
        });
        sp.clear();
        let window = cfg["windowName"].as_str().unwrap_or("VALORANT").to_string();
        self.report_source(json!({ "state": "starting", "message": format!("Looking for the \"{window}\" window") }));
        let me = Arc::clone(self);
        let game = s["game"].as_str().unwrap_or("").to_string();
        let name_busy = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let h = tokio::task::spawn_blocking(move || {
            let mut last: Option<u64> = None;
            while me.epoch.load(Ordering::Acquire) == epoch {
                let started = now_ms();
                match sp.next_frame(&window, last) {
                    Err(e) => {
                        me.report_source(json!({ "state": "error", "message": e }));
                        std::thread::sleep(Duration::from_millis(500));
                        continue;
                    }
                    Ok((seq, _)) if Some(seq) == last => {
                        std::thread::sleep(Duration::from_millis(4));
                        continue;
                    }
                    Ok((seq, _)) => last = Some(seq),
                }
                let cap_ms = now_ms() - started;
                let t1 = now_ms();
                let fast = cfg["portrait"].is_object().then(|| sp.portrait_step(&cfg["portrait"])).flatten();
                let icon_ms = now_ms() - t1;
                let timing = (cap_ms, icon_ms);
                if let Some(r) = fast {
                    me.spectate_send(&game, r, &*sp, timing);
                } else if cfg["method"] == "icon" {
                    let r = sp.report_none();
                    me.spectate_send(&game, r, &*sp, timing);
                } else if !name_busy.swap(true, Ordering::AcqRel) {
                    let (me2, sp2, roi, busy, game2) = (Arc::clone(&me), Arc::clone(&sp), cfg["roi"].clone(), Arc::clone(&name_busy), game.clone());
                    std::thread::spawn(move || {
                        let r = sp2.name_step(&roi);
                        if me2.epoch.load(Ordering::Acquire) == epoch {
                            me2.spectate_send(&game2, r, &*sp2, timing);
                        }
                        busy.store(false, Ordering::Release);
                    });
                }
            }
        });
        self.lock().tasks.push(h);
    }

    /// send(result): forward on change or every 2 s; UI at most every 250 ms (switches are not throttled).
    fn spectate_send(&self, game: &str, (changed, spectated): (bool, Value), sp: &dyn Spectator, (cap_ms, icon_ms): (f64, f64)) {
        let now = now_ms();
        let send = { let g = self.lock(); changed || g.last_spectate_sent == 0.0 || now - g.last_spectate_sent > 2000.0 };
        if send {
            self.forward_raw(&json!({ "type": "spectated", "game": game, "version": 1, "payload": spectated }));
            self.lock().last_spectate_sent = now;
        }
        let ui = { let g = self.lock(); changed || g.last_spectate_ui == 0.0 || now - g.last_spectate_ui > 250.0 };
        if ui {
            self.lock().last_spectate_ui = now;
            let mut st = spectated.clone();
            st["last"] = sp.last();
            (self.on_ocr_state)(json!({ "spectate": st }));
            let name = spectated["name"].as_str().unwrap_or("");
            let who = if name.is_empty() {
                sp.why_not()
            } else {
                let station = spectated["station"].as_f64().map(|s| format!(" (station {})", isu_core::game_config::num_to_js(s))).unwrap_or_default();
                let via = spectated["via"].as_str().filter(|v| !v.is_empty()).map(|v| format!(" · by {v}")).unwrap_or_default();
                format!("Spectating {name}{station}{via}")
            };
            self.report_source(json!({ "state": "reading", "message": format!("{who} · frame {} ms + icon {} ms · windows-graphics-capture", cap_ms.round(), icon_ms.round()) }));
        }
    }

    /// stop().
    pub fn stop(&self) {
        self.epoch.fetch_add(1, Ordering::AcqRel);
        self.rocket_league.stop();
        if let Some(sp) = &self.spectator {
            sp.clear();
        }
        let mut g = self.lock();
        g.remote_tx = None;
        for t in g.tasks.drain(..) {
            t.abort();
        }
    }

    /// connectRemote(): ws://host:port/game-bridge?token&game, reconnect every 3 s.
    fn connect_remote(self: &Arc<Self>) {
        let Some(s) = self.settings() else { return };
        let epoch = self.epoch.load(Ordering::Acquire);
        let (host, port, token, game) = (s["graphicsHost"].as_str().unwrap().to_string(), s["bridgePort"].as_u64().unwrap(), s["bridgeToken"].as_str().unwrap().to_string(), s["game"].as_str().unwrap().to_string());
        self.lock().remote_status = json!({ "state": "connecting", "message": format!("Connecting to {host}:{port}") });
        self.report();
        let me = Arc::clone(self);
        let h = tokio::spawn(async move {
            let q: String = url::form_urlencoded::Serializer::new(String::new()).append_pair("token", &token).append_pair("game", &game).finish();
            let url = format!("ws://{host}:{port}/game-bridge?{q}");
            let mut reason = String::new();
            if let Ok((ws, _)) = tokio_tungstenite::connect_async_with_config(&url, Some(crate::link::ws_config()), false).await {
                if me.epoch.load(Ordering::Acquire) != epoch {
                    return;
                }
                let label = match game.as_str() {
                    "valorant" => "VALORANT (spectated player)",
                    "overwatch" => "Overwatch (spectated player)",
                    _ => "Rocket League",
                };
                let (tx, mut rx) = mpsc::unbounded_channel::<String>();
                {
                    let mut g = me.lock();
                    g.remote_tx = Some(tx);
                    g.remote_status = json!({ "state": "connected", "message": format!("Connected to Graphics PC for {label}") });
                }
                me.report();
                let (mut wtx, mut wrx) = ws.split();
                let mut ping = tokio::time::interval(Duration::from_millis(BRIDGE_PING_INTERVAL_MS));
                ping.tick().await;
                let mut alive = true;
                loop {
                    tokio::select! {
                        m = wrx.next() => match m {
                            Some(Ok(Message::Text(t))) => {
                                if let Ok(msg) = serde_json::from_str::<Value>(&t) {
                                    if msg["type"] == "spectate-candidates" && msg["candidates"].is_array() {
                                        if let Some(sp) = &me.spectator { sp.set_candidates(msg["candidates"].as_array().unwrap(), &msg["sides"]); }
                                    }
                                }
                            }
                            Some(Ok(Message::Pong(_))) => alive = true,
                            Some(Ok(Message::Close(f))) => { reason = f.map(|f| f.reason.to_string()).unwrap_or_default(); break; }
                            None | Some(Err(_)) => break,
                            _ => {}
                        },
                        out = rx.recv() => match out { Some(text) => { if wtx.send(Message::Text(text.into())).await.is_err() { break; } } None => break },
                        _ = ping.tick() => { if !alive { break; } alive = false; if wtx.send(Message::Ping(Vec::new().into())).await.is_err() { break; } }
                    }
                }
            }
            if me.epoch.load(Ordering::Acquire) != epoch {
                return;
            }
            {
                let mut g = me.lock();
                g.remote_tx = None;
                g.remote_status = json!({ "state": "waiting", "message": if reason.is_empty() { "Graphics PC unavailable; retrying…".to_string() } else { reason } });
            }
            me.report();
            tokio::time::sleep(Duration::from_secs(3)).await;
            if me.epoch.load(Ordering::Acquire) == epoch {
                me.connect_remote();
            }
        });
        self.lock().tasks.push(h);
    }

    /// forward(game, payload): only for the active game, only while connected.
    pub fn forward(&self, game: &str, payload: &Value) -> bool {
        let mut g = self.lock();
        if g.settings.as_ref().and_then(|s| s["game"].as_str()) != Some(game) {
            return false;
        }
        let Some(tx) = g.remote_tx.clone() else { return false };
        let seq = self.seq.fetch_add(1, Ordering::AcqRel) + 1;
        if tx.send(envelope(game, payload, seq, now_ms()).to_string()).is_err() {
            return false;
        }
        g.sent += 1;
        true
    }

    /// forwardRaw(packet): + sequence + capturedAt.
    pub fn forward_raw(&self, packet: &Value) -> bool {
        let mut g = self.lock();
        let Some(tx) = g.remote_tx.clone() else { return false };
        let mut p = packet.clone();
        p["sequence"] = json!(self.seq.fetch_add(1, Ordering::AcqRel) + 1);
        p["capturedAt"] = isu_core::game_config::jnum(now_ms());
        if tx.send(p.to_string()).is_err() {
            return false;
        }
        g.sent += 1;
        true
    }

    pub fn start_simulator(&self) {
        self.rocket_league.start_simulator();
    }

    pub fn stop_simulator(&self) {
        if let Some(s) = self.settings() {
            self.rocket_league.stop();
            let mut cfg = s["rocketLeague"].clone();
            cfg["updateIntervalMs"] = json!(1);
            self.rocket_league.configure(&cfg);
        }
    }
}
