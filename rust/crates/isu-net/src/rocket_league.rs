//! Rocket League Stats API: electron/rocket-league-service.cjs (normalizeSettings, JsonStreamParser,
//! normalizeEnvelope, RocketLeagueService: local WebSocket 49124 with TCP 49123 fallback, the
//! Graphics PC bridge receiver, watchdog, update-interval throttle, test simulator).
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use isu_core::game_config::{js_round, js_string, to_number, truthy};
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

use crate::link::{BRIDGE_MAX_PAYLOAD, key_matches, now_ms};

#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub enabled: bool,
    pub source: &'static str,
    pub transport: &'static str,
    pub host: String,
    pub tcp_port: u16,
    pub web_port: u16,
    pub bridge_port: u16,
    pub bridge_token: String,
    pub update_interval_ms: u64,
    /// every other key of the input, kept (JS `...DEFAULTS, ...settings`)
    pub extra: serde_json::Map<String, Value>,
}

pub fn safe_port(v: Option<&Value>, fallback: u16) -> u16 {
    match to_number(v) {
        Some(x) if x == x.trunc() && x > 0.0 && x < 65536.0 => x as u16,
        _ => fallback,
    }
}

/// safeUpdateInterval: 1..50 ms, default 33.
pub fn safe_update_interval(v: Option<&Value>, fallback: u64) -> u64 {
    match to_number(v) {
        Some(x) if x.is_finite() => js_round(x).clamp(1.0, 50.0) as u64,
        _ => fallback,
    }
}

/// normalizeSettings(settings).
pub fn normalize_settings(v: &Value) -> Settings {
    let s = |k: &str, d: &str| v.get(k).filter(|x| truthy(Some(x))).map(|x| js_string(Some(x))).unwrap_or_else(|| d.to_string()).trim().to_string();
    let mut extra = v.as_object().cloned().unwrap_or_default();
    for k in ["enabled", "source", "transport", "host", "tcpPort", "webPort", "bridgePort", "bridgeToken", "updateIntervalMs"] {
        extra.remove(k);
    }
    Settings {
        enabled: truthy(v.get("enabled")),
        source: if v.get("source").and_then(Value::as_str) == Some("remote") { "remote" } else { "local" },
        transport: match v.get("transport").and_then(Value::as_str) {
            Some("websocket") => "websocket",
            Some("tcp") => "tcp",
            _ => "auto",
        },
        host: s("host", "127.0.0.1"),
        tcp_port: safe_port(v.get("tcpPort"), 49123),
        web_port: safe_port(v.get("webPort"), 49124),
        bridge_port: safe_port(v.get("bridgePort"), 3175),
        bridge_token: v.get("bridgeToken").filter(|x| truthy(Some(x))).map(|x| js_string(Some(x))).unwrap_or_default().trim().to_string(),
        update_interval_ms: safe_update_interval(v.get("updateIntervalMs"), 33),
        extra,
    }
}

pub fn settings_json(s: &Settings) -> Value {
    let mut m = s.extra.clone();
    for (k, v) in [
        ("enabled", json!(s.enabled)),
        ("source", json!(s.source)),
        ("transport", json!(s.transport)),
        ("host", json!(s.host)),
        ("tcpPort", json!(s.tcp_port)),
        ("webPort", json!(s.web_port)),
        ("bridgePort", json!(s.bridge_port)),
        ("bridgeToken", json!(s.bridge_token)),
        ("updateIntervalMs", json!(s.update_interval_ms)),
    ] {
        m.insert(k.into(), v);
    }
    Value::Object(m)
}

/// JsonStreamParser: pulls whole {...} objects out of a TCP byte stream (strings + escapes aware).
#[derive(Default)]
pub struct JsonStreamParser {
    buffer: String,
    depth: i32,
    started: bool,
    in_string: bool,
    escaped: bool,
}

impl JsonStreamParser {
    pub fn push(&mut self, chunk: &str, mut on_value: impl FnMut(Value)) {
        for c in chunk.chars() {
            if !self.started {
                if c != '{' {
                    continue;
                }
                self.started = true;
                self.depth = 1;
                self.buffer.push(c);
                continue;
            }
            self.buffer.push(c);
            if self.in_string {
                if self.escaped {
                    self.escaped = false;
                } else if c == '\\' {
                    self.escaped = true;
                } else if c == '"' {
                    self.in_string = false;
                }
                continue;
            }
            match c {
                '"' => self.in_string = true,
                '{' => self.depth += 1,
                '}' => self.depth -= 1,
                _ => {}
            }
            if self.depth == 0 {
                let json = std::mem::take(&mut self.buffer);
                self.started = false;
                if let Ok(v) = serde_json::from_str(&json) {
                    on_value(v);
                }
            }
        }
        // JS: this.buffer.length (UTF-16 units) > 2_000_000 -> reset
        if self.buffer.encode_utf16().count() > 2_000_000 {
            *self = Self::default();
        }
    }
}

/// normalizeEnvelope(message): { Event, Data } (Data string -> parsed, non-object -> {}).
pub fn normalize_envelope(m: &Value) -> Option<Value> {
    let o = m.as_object()?;
    let event = o.get("Event").filter(|v| truthy(Some(v))).or_else(|| o.get("event").filter(|v| truthy(Some(v))))?;
    let mut data = match o.get("Data") {
        Some(v) if !v.is_null() => v.clone(),
        _ => match o.get("data") {
            Some(v) if !v.is_null() => v.clone(),
            _ => json!({}),
        },
    };
    if let Value::String(s) = &data {
        data = serde_json::from_str(s).unwrap_or(json!({}));
    }
    // JS: data && typeof data === 'object' (arrays are objects too)
    if !(data.is_object() || data.is_array()) {
        data = json!({});
    }
    Some(json!({ "Event": js_string(Some(event)), "Data": data }))
}

pub type Callback = Arc<dyn Fn(Value) + Send + Sync>;

struct Inner {
    settings: Settings,
    status: Value,
    packets: u64,
    last_tick_sent: f64,
    last_status_sent_at: f64,
    last_packet_ts: f64,
    last_rate_at: f64,
    last_rate_packets: u64,
    transport_connected: bool,
    bridge_clients: usize,
    tasks: Vec<JoinHandle<()>>,
}

pub struct RocketLeagueService {
    inner: Mutex<Inner>,
    on_event: Callback,
    on_status: Callback,
    generation: AtomicU64,
}

impl RocketLeagueService {
    pub fn new(on_event: Callback, on_status: Callback) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                settings: normalize_settings(&json!({})),
                status: json!({ "state": "disabled", "transport": null, "message": "Live data is off", "packets": 0, "packetRate": 0, "bridgeClients": 0, "lastPacketAt": null, "dataAgeMs": null }),
                packets: 0,
                last_tick_sent: 0.0,
                last_status_sent_at: 0.0,
                last_packet_ts: 0.0,
                last_rate_at: now_ms(),
                last_rate_packets: 0,
                transport_connected: false,
                bridge_clients: 0,
                tasks: Vec::new(),
            }),
            on_event,
            on_status,
            generation: AtomicU64::new(0),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn status(&self) -> Value {
        self.lock().status.clone()
    }

    pub fn settings(&self) -> Settings {
        self.lock().settings.clone()
    }

    /// emitStatus(state, message, extra).
    fn emit(&self, state: &str, message: &str, extra: Value) {
        let st = {
            let mut g = self.lock();
            g.status["state"] = json!(state);
            g.status["message"] = json!(message);
            g.status["packets"] = json!(g.packets);
            g.status["bridgeClients"] = json!(g.bridge_clients);
            for (k, v) in extra.as_object().cloned().unwrap_or_default() {
                g.status[k] = v;
            }
            g.last_status_sent_at = now_ms();
            g.status.clone()
        };
        (self.on_status)(st);
    }

    /// configure(next): restart everything with the new settings.
    pub fn configure(self: &Arc<Self>, next: &Value) {
        let s = normalize_settings(next);
        self.stop();
        {
            let mut g = self.lock();
            g.settings = s.clone();
            g.packets = 0;
            g.last_packet_ts = 0.0;
            g.last_rate_at = now_ms();
            g.last_rate_packets = 0;
            g.last_tick_sent = 0.0;
            g.status["packets"] = json!(0);
            g.status["packetRate"] = json!(0);
            g.status["lastPacketAt"] = Value::Null;
            g.status["dataAgeMs"] = Value::Null;
        }
        if !s.enabled {
            return self.emit("disabled", "Live data is off", json!({}));
        }
        self.start_watchdog();
        if s.source == "remote" { self.start_receiver() } else { self.connect_local(None) }
    }

    /// stop(): every socket, server, timer.
    pub fn stop(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        let mut g = self.lock();
        for t in g.tasks.drain(..) {
            t.abort();
        }
        g.transport_connected = false;
        g.bridge_clients = 0;
    }

    /// setUpdateInterval(value).
    pub fn set_update_interval(&self, v: &Value) -> u64 {
        let st = {
            let mut g = self.lock();
            g.settings.update_interval_ms = safe_update_interval(Some(v), 33);
            g.status["updateIntervalMs"] = json!(g.settings.update_interval_ms);
            g.status.clone()
        };
        let ms = st["updateIntervalMs"].as_u64().unwrap();
        (self.on_status)(st);
        ms
    }

    fn spawn(&self, f: impl std::future::Future<Output = ()> + Send + 'static) {
        let h = tokio::spawn(f);
        self.lock().tasks.push(h);
    }

    fn start_watchdog(self: &Arc<Self>) {
        let me = Arc::clone(self);
        let epoch = self.generation.load(Ordering::Acquire);
        self.spawn(async move {
            let mut t = tokio::time::interval(Duration::from_secs(1));
            t.tick().await;
            loop {
                t.tick().await;
                if me.generation.load(Ordering::Acquire) != epoch {
                    break;
                }
                let now = now_ms();
                let (rate, age, connected, remote) = {
                    let mut g = me.lock();
                    let elapsed = ((now - g.last_rate_at) / 1000.0).max(0.001);
                    let rate = ((((g.packets - g.last_rate_packets) as f64 / elapsed) * 10.0) + 0.5).floor() / 10.0;
                    g.last_rate_at = now;
                    g.last_rate_packets = g.packets;
                    let age = (g.last_packet_ts != 0.0).then(|| now - g.last_packet_ts);
                    let connected = if g.settings.source == "remote" { g.bridge_clients > 0 } else { g.transport_connected };
                    (rate, age, connected, g.settings.source == "remote")
                };
                let jage = age.map_or(Value::Null, isu_core::game_config::jnum);
                if connected && age.is_none_or(|a| a > 2500.0) {
                    let msg = if remote { "Game PC bridge connected; waiting for match data" } else { "Connected to Rocket League; waiting for an active match" };
                    me.emit("idle", msg, json!({ "packetRate": isu_core::game_config::jnum(rate), "dataAgeMs": jage }));
                } else {
                    let st = {
                        let mut g = me.lock();
                        g.status["packetRate"] = isu_core::game_config::jnum(rate);
                        g.status["dataAgeMs"] = jage;
                        g.status.clone()
                    };
                    (me.on_status)(st);
                }
            }
        });
    }

    /// ingest(message, transport): count, status, throttle UpdateState to updateIntervalMs, emit.
    pub fn ingest(&self, message: &Value, transport: &str) {
        let Some(env) = normalize_envelope(message) else { return };
        let now = now_ms();
        let send_status = {
            let mut g = self.lock();
            g.packets += 1;
            g.last_packet_ts = now;
            g.status["lastPacketAt"] = json!(iso(now));
            g.status["dataAgeMs"] = json!(0);
            g.status["transport"] = json!(transport);
            let update = env["Event"] == "UpdateState";
            if update && now - g.last_tick_sent < g.settings.update_interval_ms as f64 {
                return;
            }
            if update {
                g.last_tick_sent = now;
            }
            let state = if transport == "simulator" { "simulating" } else { "connected" };
            let msg = match transport {
                "bridge" => "Receiving from Game PC bridge".to_string(),
                "simulator" => "Test feed running".to_string(),
                t => format!("Connected via {t}"),
            };
            g.status["state"] = json!(state);
            g.status["message"] = json!(msg);
            g.status["packets"] = json!(g.packets);
            if now - g.last_status_sent_at >= 500.0 {
                g.last_status_sent_at = now;
                Some(g.status.clone())
            } else {
                None
            }
        };
        if let Some(st) = send_status {
            (self.on_status)(st);
        }
        (self.on_event)(env);
    }

    /// connectLocal(forceTransport): auto = WebSocket first, TCP if it never opened.
    fn connect_local(self: &Arc<Self>, force: Option<&'static str>) {
        let epoch = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let s = self.settings();
        let requested = force.unwrap_or(s.transport);
        let transport = if requested == "auto" { "websocket" } else { requested };
        self.emit("connecting", &format!("Connecting to {} via {transport}…", s.host), json!({ "transport": transport }));
        let me = Arc::clone(self);
        if transport == "tcp" {
            self.spawn(async move { me.run_tcp(epoch).await });
        } else {
            self.spawn(async move { me.run_ws(epoch, requested == "auto").await });
        }
    }

    async fn run_ws(self: Arc<Self>, epoch: u64, allow_tcp: bool) {
        let s = self.settings();
        let url = format!("ws://{}:{}", s.host, s.web_port);
        let mut opened = false;
        if let Ok((mut ws, _)) = tokio_tungstenite::connect_async(&url).await {
            if self.generation.load(Ordering::Acquire) != epoch {
                return;
            }
            opened = true;
            self.lock().transport_connected = true;
            self.emit("connected", &format!("Connected to Rocket League at {url}"), json!({ "transport": "websocket" }));
            while let Some(Ok(m)) = ws.next().await {
                if let Message::Text(t) = m {
                    if let Ok(v) = serde_json::from_str::<Value>(&t) {
                        self.ingest(&v, "websocket");
                    }
                }
            }
            self.lock().transport_connected = false;
        }
        if self.generation.load(Ordering::Acquire) != epoch || !self.settings().enabled || self.settings().source != "local" {
            return;
        }
        if !opened && allow_tcp {
            self.emit("connecting", "WebSocket unavailable; trying TCP 49123…", json!({ "transport": "tcp" }));
            Box::pin(self.run_tcp(epoch)).await;
        } else {
            self.schedule_reconnect(epoch).await;
        }
    }

    async fn run_tcp(self: Arc<Self>, epoch: u64) {
        let s = self.settings();
        match tokio::net::TcpStream::connect((s.host.as_str(), s.tcp_port)).await {
            Ok(mut sock) => {
                if self.generation.load(Ordering::Acquire) != epoch {
                    return;
                }
                self.lock().transport_connected = true;
                self.emit("connected", &format!("Connected to Rocket League at {}:{}", s.host, s.tcp_port), json!({ "transport": "tcp" }));
                let mut parser = JsonStreamParser::default();
                let mut buf = vec![0u8; 64 * 1024];
                let mut pending: Vec<u8> = Vec::new();
                loop {
                    match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            pending.extend_from_slice(&buf[..n]);
                            // keep an incomplete UTF-8 tail for the next chunk
                            let valid = match std::str::from_utf8(&pending) {
                                Ok(_) => pending.len(),
                                Err(e) => e.valid_up_to(),
                            };
                            let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
                            pending.drain(..valid);
                            let me = &self;
                            parser.push(&text, |v| me.ingest(&v, "tcp"));
                        }
                    }
                }
                self.lock().transport_connected = false;
            }
            Err(e) => {
                let code = match e.kind() {
                    std::io::ErrorKind::ConnectionRefused => "ECONNREFUSED".to_string(),
                    std::io::ErrorKind::TimedOut => "ETIMEDOUT".to_string(),
                    _ => e.to_string(),
                };
                self.emit("waiting", &format!("Rocket League feed unavailable: {code}"), json!({ "transport": "tcp" }));
            }
        }
        if self.generation.load(Ordering::Acquire) != epoch || !self.settings().enabled || self.settings().source != "local" {
            return;
        }
        self.schedule_reconnect(epoch).await;
    }

    async fn schedule_reconnect(self: &Arc<Self>, epoch: u64) {
        self.emit("waiting", "Waiting for an active Rocket League match…", json!({}));
        tokio::time::sleep(Duration::from_secs(3)).await;
        if self.generation.load(Ordering::Acquire) == epoch {
            self.connect_local(None);
        }
    }

    /// startReceiver(): the Graphics PC end of the Game PC bridge (WebSocket server, key in ?token=).
    fn start_receiver(self: &Arc<Self>) {
        let s = self.settings();
        if s.bridge_token.is_empty() {
            return self.emit("error", "Create a bridge key before starting remote mode", json!({}));
        }
        let me = Arc::clone(self);
        self.spawn(async move {
            let listener = match tokio::net::TcpListener::bind(("0.0.0.0", s.bridge_port)).await {
                Ok(l) => l,
                Err(e) => return me.emit("error", &format!("Bridge receiver error: {e}"), json!({ "transport": "bridge" })),
            };
            me.emit("listening", &format!("Waiting for Game PC on port {}", s.bridge_port), json!({ "transport": "bridge" }));
            loop {
                let Ok((tcp, _)) = listener.accept().await else { continue };
                let me2 = Arc::clone(&me);
                let token = s.bridge_token.clone();
                let port = s.bridge_port;
                tokio::spawn(async move {
                    let Some(mut ws) = crate::link::accept_with_key(tcp, &token).await else { return };
                    me2.lock().bridge_clients += 1;
                    me2.emit("connected", "Game PC bridge connected", json!({ "transport": "bridge" }));
                    let _ = ws.send(Message::Text(json!({ "type": "welcome", "version": 1 }).to_string().into())).await;
                    crate::link::serve_keepalive(ws, |text| {
                        if let Ok(p) = serde_json::from_str::<Value>(text) {
                            if p["type"] == "telemetry" {
                                me2.ingest(&p["event"], "bridge");
                            } else if p["type"] == "game-telemetry" && p["game"] == "rocketleague" {
                                me2.ingest(&p["payload"], "bridge");
                            }
                        }
                    }, None)
                    .await;
                    {
                        let mut g = me2.lock();
                        g.bridge_clients = g.bridge_clients.saturating_sub(1);
                    }
                    me2.emit("listening", &format!("Game PC disconnected; waiting on port {port}"), json!({ "transport": "bridge" }));
                });
            }
        });
        let _ = BRIDGE_MAX_PAYLOAD;
        let _ = key_matches;
    }

    /// startSimulator(): a 300 s test match, one UpdateState per second.
    pub fn start_simulator(self: &Arc<Self>) {
        self.stop();
        self.lock().packets = 0;
        self.start_watchdog();
        self.emit("simulating", "Test feed running", json!({ "transport": "simulator" }));
        let guid = format!("SIM-{}", now_ms() as i64);
        self.ingest(&json!({ "Event": "MatchCreated", "Data": { "MatchGuid": guid } }), "simulator");
        let me = Arc::clone(self);
        let epoch = self.generation.load(Ordering::Acquire);
        self.spawn(async move {
            let (mut remaining, mut home, mut away) = (300i64, 0, 0);
            let mut t = tokio::time::interval(Duration::from_secs(1));
            loop {
                t.tick().await;
                if me.generation.load(Ordering::Acquire) != epoch {
                    break;
                }
                let (msg, ended) = simulator_tick(&guid, &mut remaining, &mut home, &mut away);
                me.ingest(&msg, "simulator");
                if let Some(e) = ended {
                    me.ingest(&e, "simulator");
                    break;
                }
            }
        });
    }

    pub fn stop_simulator(self: &Arc<Self>) {
        let s = settings_json(&self.settings());
        self.configure(&s);
    }
}

/// One simulator tick (same numbers as the JS tick()).
pub fn simulator_tick(guid: &str, remaining: &mut i64, home: &mut i64, away: &mut i64) -> (Value, Option<Value>) {
    *remaining = (*remaining - 1).max(0);
    if *remaining == 285 {
        *home = 1;
    }
    if *remaining == 270 {
        *away = 1;
    }
    let r = *remaining;
    let names = ["BengalOne", "BengalTwo", "BengalThree", "Opponent1", "Opponent2", "Opponent3"];
    let players: Vec<Value> = names
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let i64i = i as i64;
            json!({
                "Name": name, "PrimaryId": format!("Sim|{i}|0"), "Shortcut": i + 1, "TeamNum": if i < 3 { 0 } else { 1 },
                "Loadout": ["isu_test_body", "isu_test_decal", "isu_test_wheels"],
                "Score": ((300 - r) * 3 - i64i * 7).max(0), "Goals": if i == 0 { *home } else if i == 3 { *away } else { 0 },
                "Shots": i % 3, "Assists": 0, "Saves": i % 2, "Demos": 0,
                "Boost": js_round(50.0 + 45.0 * (((300 - r) + i64i * 4) as f64 / 7.0).sin()) as i64, "bDemolished": false
            })
        })
        .collect();
    let target = json!({ "Name": names[0], "Shortcut": 1, "TeamNum": 0 });
    let msg = json!({ "Event": "UpdateState", "Data": {
        "MatchGuid": guid, "Players": players,
        "Game": { "Teams": [{ "Name": "Blue", "TeamNum": 0, "Score": *home }, { "Name": "Orange", "TeamNum": 1, "Score": *away }], "TimeSeconds": r, "bOvertime": false, "bReplay": false, "Arena": "Stadium_P", "bHasTarget": true, "Target": target }
    } });
    let ended = (r == 0).then(|| json!({ "Event": "MatchEnded", "Data": { "MatchGuid": guid, "WinnerTeamNum": if *home >= *away { 0 } else { 1 } } }));
    (msg, ended)
}

fn iso(ms: f64) -> String {
    // same format as new Date(ms).toISOString()
    let ms = ms as i64;
    let (secs, msec) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let (days, tod) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{msec:03}Z", tod / 3600, tod % 3600 / 60, tod % 60)
}
