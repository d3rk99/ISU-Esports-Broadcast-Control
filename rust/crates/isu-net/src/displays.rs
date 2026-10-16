//! Display Manager (controller side, port 3178, ws path /display): electron/displays/display-manager.cjs.
//! Stations (display-client PCs) say hello {station, hostname, version, key, mode, source}, then
//! status {mode, source, state, error, fps, noise}; the manager sends welcome / mode / noise.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use isu_core::game_config::{js_round, js_string, to_number, truthy};
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use crate::link::now_ms;

pub const STATIONS: usize = 10;
pub const DEFAULT_NOISE_VOLUME: i64 = 30;

/// clampVolume(v, fallback).
pub fn clamp_volume(v: Option<&Value>, fallback: i64) -> i64 {
    match to_number(v) {
        Some(n) if n.is_finite() => js_round(n).clamp(0.0, 100.0) as i64,
        _ => fallback,
    }
}

pub fn default_source(n: usize) -> String {
    format!("ISU Stage {n:02}")
}

/// stationTargets: 'all' | '' | '1-5' | '6-10' | 1..10.
pub fn station_targets(station: &str) -> Option<Vec<usize>> {
    match station.trim().to_lowercase().as_str() {
        "" | "all" => Some((1..=STATIONS).collect()),
        "1-5" => Some(vec![1, 2, 3, 4, 5]),
        "6-10" => Some(vec![6, 7, 8, 9, 10]),
        k => isu_core::game_config::js_number(k).map(js_round).filter(|n| (1.0..=STATIONS as f64).contains(n)).map(|n| vec![n as usize]),
    }
}

/// keyOk: no key set = anyone; else timing-safe equal.
fn key_ok(expected: &str, provided: &str) -> bool {
    expected.is_empty() || (expected.len() == provided.len() && bool::from(expected.as_bytes().ct_eq(provided.as_bytes())))
}

#[derive(Debug, Clone)]
struct Station {
    n: usize,
    online: bool,
    hostname: String,
    version: String,
    mode: String,
    source: String,
    state: String,
    error: String,
    fps: i64,
    last_seen: f64,
    conn: Option<(u64, mpsc::UnboundedSender<Out>)>,
    noise: bool,
    noise_volume: i64,
    noise_state: String,
    noise_device: String,
    noise_error: String,
}

#[derive(Debug, Clone)]
enum Out {
    Text(String),
    Close(u16, String),
}

impl Station {
    fn blank(n: usize) -> Self {
        Self { n, online: false, hostname: String::new(), version: String::new(), mode: "ndi".into(), source: default_source(n), state: "offline".into(), error: String::new(), fps: 0, last_seen: 0.0, conn: None, noise: false, noise_volume: DEFAULT_NOISE_VOLUME, noise_state: "off".into(), noise_device: String::new(), noise_error: String::new() }
    }
    fn json(&self) -> Value {
        json!({ "station": self.n, "online": self.online, "hostname": self.hostname, "version": self.version, "mode": self.mode, "source": self.source, "state": self.state, "error": self.error, "fps": self.fps, "lastSeen": isu_core::game_config::jnum(self.last_seen), "noise": self.noise, "noiseVolume": self.noise_volume, "noiseState": self.noise_state, "noiseDevice": self.noise_device, "noiseError": self.noise_error })
    }
    fn send(&self, v: &Value) -> bool {
        self.conn.as_ref().is_some_and(|(_, tx)| tx.send(Out::Text(v.to_string())).is_ok())
    }
}

pub type Callback = Arc<dyn Fn(Value) + Send + Sync>;

struct Inner {
    stations: Vec<Station>,
    key: String,
    port: u16,
    error: String,
    next_id: u64,
    server: Option<tokio::task::JoinHandle<()>>,
}

pub struct DisplayManager {
    inner: Mutex<Inner>,
    host: String,
    on_status: Callback,
}

fn trunc(s: &str, n: usize) -> String {
    String::from_utf16_lossy(&s.encode_utf16().take(n).collect::<Vec<u16>>())
}

impl DisplayManager {
    pub fn new(port: u16, host: &str, key: &str, on_status: Callback) -> Arc<Self> {
        Arc::new(Self { inner: Mutex::new(Inner { stations: (1..=STATIONS).map(Station::blank).collect(), key: key.to_string(), port, error: String::new(), next_id: 1, server: None }), host: host.to_string(), on_status })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// status(): port, error, keyRequired, onlineCount, stations (without sockets).
    pub fn status(&self) -> Value {
        let g = self.lock();
        json!({ "port": g.port, "error": g.error, "keyRequired": !g.key.is_empty(), "onlineCount": g.stations.iter().filter(|s| s.online).count(), "stations": g.stations.iter().map(Station::json).collect::<Vec<_>>() })
    }

    fn emit(&self) {
        (self.on_status)(self.status());
    }

    pub fn error(&self) -> String {
        self.lock().error.clone()
    }

    /// start(): HTTP 426 for plain requests, WebSocket on /display (64 KB max), ping every 5 s.
    pub async fn start(self: &Arc<Self>) {
        let port = self.lock().port;
        match tokio::net::TcpListener::bind((self.host.as_str(), port)).await {
            Ok(l) => {
                let bound = l.local_addr().map(|a| a.port()).unwrap_or(port);
                self.lock().port = bound;
                let me = Arc::clone(self);
                let h = tokio::spawn(async move {
                    loop {
                        let Ok((tcp, _)) = l.accept().await else {
                    // accept errors (fd limit, network down) would spin the loop: back off a little
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    continue;
                };
                        let me2 = Arc::clone(&me);
                        tokio::spawn(async move { me2.accept(tcp).await });
                    }
                });
                self.lock().server = Some(h);
            }
            Err(e) => {
                let code = if e.kind() == std::io::ErrorKind::AddrInUse { "EADDRINUSE".to_string() } else { e.to_string() };
                self.lock().error = format!("Display manager could not open port {port}: {code}");
            }
        }
        self.emit();
    }

    async fn accept(self: Arc<Self>, tcp: tokio::net::TcpStream) {
        // A plain HTTP request (no upgrade) gets 426 like the JS http server.
        let mut peek = [0u8; 2048];
        let n = tcp.peek(&mut peek).await.unwrap_or(0);
        let head = String::from_utf8_lossy(&peek[..n]).to_ascii_lowercase();
        if !head.contains("upgrade: websocket") {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut tcp = tcp;
            // peek() leaves the request queued. Closing with unread bytes can reset
            // the connection on Windows and truncate the HTTP response at the peer.
            if tcp.read_exact(&mut peek[..n]).await.is_err() { return; }
            let body = "ISU display manager: WebSocket only";
            let _ = tcp.write_all(format!("HTTP/1.1 426 Upgrade Required\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
            let _ = tcp.shutdown().await;
            return;
        }
        let cb = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
            if req.uri().path() != "/display" {
                let mut r = ErrorResponse::new(None);
                *r.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::BAD_REQUEST;
                return Err(r);
            }
            Ok(resp)
        };
        let mut cfg = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
        cfg.max_message_size = Some(64 * 1024);
        let Ok(ws) = tokio_tungstenite::accept_hdr_async_with_config(tcp, cb, Some(cfg)).await else { return };
        let (mut wtx, mut wrx) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Out>();
        let id = {
            let mut g = self.lock();
            g.next_id += 1;
            g.next_id
        };
        let mut station = 0usize;
        let mut ping = tokio::time::interval(Duration::from_secs(5));
        ping.tick().await;
        let mut alive = true;
        loop {
            tokio::select! {
                m = wrx.next() => match m {
                    Some(Ok(Message::Text(t))) => {
                        let Ok(msg) = serde_json::from_str::<Value>(&t) else { continue };
                        if let Some(close) = self.on_message(&msg, &mut station, id, &tx) {
                            let _ = wtx.send(Message::Close(Some(CloseFrame { code: CloseCode::from(close.0), reason: close.1.into() }))).await;
                            break;
                        }
                    }
                    Some(Ok(Message::Pong(_))) => alive = true,
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                },
                out = rx.recv() => match out {
                    Some(Out::Text(t)) => { if wtx.send(Message::Text(t.into())).await.is_err() { break; } }
                    Some(Out::Close(code, reason)) => { let _ = wtx.send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.into() }))).await; break; }
                    None => break,
                },
                _ = ping.tick() => { if !alive { break; } alive = false; if wtx.send(Message::Ping(Vec::new().into())).await.is_err() { break; } }
            }
        }
        if station > 0 {
            let mut g = self.lock();
            let s = &mut g.stations[station - 1];
            if s.conn.as_ref().is_some_and(|(i, _)| *i == id) {
                s.online = false;
                s.conn = None;
                s.state = "offline".into();
                s.fps = 0;
                s.noise_state = "offline".into();
                drop(g);
                self.emit();
            }
        }
    }

    /// One client message. Some((code, reason)) = close the socket.
    fn on_message(&self, msg: &Value, station: &mut usize, id: u64, tx: &mpsc::UnboundedSender<Out>) -> Option<(u16, String)> {
        let s = |v: Option<&Value>| v.filter(|x| truthy(Some(x))).map(|x| js_string(Some(x))).unwrap_or_default();
        if msg["type"] == "hello" {
            let n = to_number(msg.get("station")).map(js_round).unwrap_or(f64::NAN);
            if !(1.0..=STATIONS as f64).contains(&n) {
                return Some((1008, "Station must be 1-10".into()));
            }
            let n = n as usize;
            let mut g = self.lock();
            if !key_ok(&g.key, &s(msg.get("key"))) {
                return Some((4003, "Display key rejected".into()));
            }
            let hostname = trunc(&s(msg.get("hostname")), 100);
            let cur = &mut g.stations[n - 1];
            if let Some((cid, ctx)) = &cur.conn {
                if *cid != id && !ctx.is_closed() && !cur.hostname.is_empty() && cur.hostname != hostname {
                    return Some((4009, format!("Station {n} is already used by {}", cur.hostname)));
                }
                if *cid != id {
                    let _ = ctx.send(Out::Close(4000, "Replaced".into()));
                }
            }
            *station = n;
            cur.online = true;
            cur.conn = Some((id, tx.clone()));
            cur.hostname = hostname;
            cur.version = trunc(&s(msg.get("version")), 30);
            cur.state = "connected".into();
            cur.error = String::new();
            cur.last_seen = now_ms();
            cur.send(&json!({ "type": "welcome", "station": n }));
            cur.send(&json!({ "type": "mode", "mode": cur.mode, "source": cur.source }));
            cur.send(&json!({ "type": "noise", "on": cur.noise, "volume": cur.noise_volume }));
            drop(g);
            self.emit();
            return None;
        }
        if *station == 0 {
            return None;
        }
        if msg["type"] == "status" {
            let mut g = self.lock();
            let cur = &mut g.stations[*station - 1];
            cur.state = trunc(&s(msg.get("state")), 30);
            cur.error = trunc(&s(msg.get("error")), 300);
            cur.fps = to_number(msg.get("fps")).filter(|x| *x != 0.0).map_or(0, |f| js_round(f).clamp(0.0, 240.0) as i64);
            cur.last_seen = now_ms();
            if let Some(nz) = msg.get("noise").filter(|v| v.is_object()) {
                cur.noise_state = trunc(&s(nz.get("state")), 30);
                cur.noise_device = trunc(&s(nz.get("device")), 120);
                cur.noise_error = trunc(&s(nz.get("error")), 300);
            }
            drop(g);
            self.emit();
        }
        None
    }

    /// setMode(station, mode, source).
    pub fn set_mode(&self, station: &str, mode: &str, source: &str) -> Value {
        if mode != "mirror" && mode != "ndi" {
            return json!({ "ok": false, "error": "Mode must be mirror or ndi" });
        }
        let Some(targets) = station_targets(station) else { return json!({ "ok": false, "error": "Station must be 1-10, 1-5, 6-10 or all" }) };
        {
            let mut g = self.lock();
            for &n in &targets {
                let cur = &mut g.stations[n - 1];
                cur.mode = mode.to_string();
                if mode == "ndi" {
                    let src = trunc(source.trim(), 200);
                    cur.source = if src.is_empty() { default_source(n) } else { src };
                }
                cur.send(&json!({ "type": "mode", "mode": cur.mode, "source": cur.source }));
            }
        }
        self.emit();
        json!({ "ok": true, "stations": targets, "mode": mode })
    }

    /// setNoise(station, on, volume): on = true | false | 'toggle' (majority) | 'keep'.
    pub fn set_noise(&self, station: &str, on: &Value, volume: Option<&Value>) -> Value {
        let Some(targets) = station_targets(station) else { return json!({ "ok": false, "error": "Station must be 1-10, 1-5, 6-10 or all" }) };
        let next = {
            let g = self.lock();
            match on.as_str() {
                Some("toggle") => Some(!targets.iter().all(|n| g.stations[n - 1].noise)),
                Some("keep") => None,
                _ => Some(truthy(Some(on))),
            }
        };
        let has_volume = volume.is_some_and(|v| !v.is_null() && v.as_str() != Some(""));
        {
            let mut g = self.lock();
            for &n in &targets {
                let cur = &mut g.stations[n - 1];
                if let Some(b) = next {
                    cur.noise = b;
                }
                if has_volume {
                    cur.noise_volume = clamp_volume(volume, cur.noise_volume);
                }
                cur.send(&json!({ "type": "noise", "on": cur.noise, "volume": cur.noise_volume }));
            }
        }
        self.emit();
        let mut r = json!({ "ok": true, "stations": targets, "on": next });
        if has_volume {
            r["volume"] = json!(clamp_volume(volume, DEFAULT_NOISE_VOLUME));
        }
        r
    }

    pub fn set_key(&self, key: &str) -> Value {
        let k = key.trim().to_string();
        let req = !k.is_empty();
        self.lock().key = k;
        self.emit();
        json!({ "ok": true, "keyRequired": req })
    }

    pub fn stop(&self) {
        let mut g = self.lock();
        for s in &mut g.stations {
            if let Some((_, tx)) = s.conn.take() {
                let _ = tx.send(Out::Close(1001, "Controller closing".into()));
            }
        }
        if let Some(h) = g.server.take() {
            h.abort();
        }
    }
}
