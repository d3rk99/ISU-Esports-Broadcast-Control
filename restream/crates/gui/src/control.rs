//! Companion / remote control API (ISU addition, 2026-10-15).
//!
//! A tiny HTTP/1.1 server on the app's tokio runtime. OFF until enabled in the
//! Control tab; listens on 127.0.0.1 unless "allow other PCs" is ticked; every
//! request needs the `X-Restream-Key` header (the key shown in the Control tab).
//!
//! GET  /api/state            -> JSON snapshot (Companion variables)
//! POST /api/go-live          -> same as the Go Live button
//! POST /api/stop             -> Stop (drain the buffered stream, then disconnect)
//! POST /api/cut              -> Cut (discard the buffer, disconnect now)
//! POST /api/recording/{start|stop|toggle}
//! POST /api/monitor/{on|off|toggle}          (local audio monitor)
//! POST /api/gain?db=N  /api/gain/adjust?db=N (program gain, -30..20 dB)
//! POST /api/monitor-volume?db=N  /api/monitor-volume/adjust?db=N (-60..12 dB)
//!
//! Commands are handed to the GUI thread (the GUI owns the profile and does the
//! same thing as its own buttons), so a remote press and a click behave the same.
//! The state snapshot is written by the GUI every frame.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    GoLive,
    Stop,
    Cut,
    Recording(Toggle),
    Monitor(Toggle),
    Gain(Level),
    MonitorVolume(Level),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Toggle {
    On,
    Off,
    Toggle,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Level {
    Set(f32),
    Adjust(f32),
}

/// A command plus where to send the answer ("ok" text or an error).
pub struct Request {
    pub command: Command,
    pub reply: oneshot::Sender<Result<String, String>>,
}

/// Values for Companion, filled by the GUI. Strings are already JSON-safe text (escaped on output).
#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    pub state: String,
    pub on_air: bool,
    pub delay_seconds: u32,
    pub delay_filled_seconds: f64,
    pub on_air_in_seconds: Option<f64>,
    pub recording: bool,
    pub recording_seconds: f64,
    pub recording_path: String,
    pub gain_db: f32,
    pub monitor: bool,
    pub monitor_volume_db: f32,
    pub audio_peak_l: Option<f64>,
    pub audio_peak_r: Option<f64>,
    pub video_fps: f64,
    pub video_kbps: f64,
    pub audio_kbps: f64,
    pub last_error: String,
    pub profile: String,
    pub destinations: Vec<DestSnap>,
}

#[derive(Debug, Clone, Default)]
pub struct DestSnap {
    pub name: String,
    pub enabled: bool,
    pub status: String,
    pub kbps: f64,
    pub reconnects: u32,
}

pub struct Shared {
    pub snapshot: Mutex<Snapshot>,
    pub commands: std::sync::mpsc::Sender<Request>,
}

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn num(v: f64) -> String {
    if v.is_finite() { format!("{}", (v * 10.0).round() / 10.0) } else { "null".into() }
}

fn opt(v: Option<f64>) -> String {
    v.map(num).unwrap_or_else(|| "null".into())
}

impl Snapshot {
    /// Flat JSON object: one key per Companion variable.
    pub fn to_json(&self) -> String {
        let mut f: Vec<(String, String)> = vec![
            ("state".into(), esc(&self.state)),
            ("on_air".into(), self.on_air.to_string()),
            ("live".into(), (self.state != "IDLE").to_string()),
            ("delay_seconds".into(), self.delay_seconds.to_string()),
            ("delay_filled_seconds".into(), num(self.delay_filled_seconds)),
            ("on_air_in_seconds".into(), opt(self.on_air_in_seconds)),
            ("recording".into(), self.recording.to_string()),
            ("recording_seconds".into(), num(self.recording_seconds)),
            ("recording_path".into(), esc(&self.recording_path)),
            ("gain_db".into(), num(self.gain_db as f64)),
            ("monitor".into(), self.monitor.to_string()),
            ("monitor_volume_db".into(), num(self.monitor_volume_db as f64)),
            ("audio_peak_l".into(), opt(self.audio_peak_l)),
            ("audio_peak_r".into(), opt(self.audio_peak_r)),
            ("video_fps".into(), num(self.video_fps)),
            ("video_kbps".into(), num(self.video_kbps)),
            ("audio_kbps".into(), num(self.audio_kbps)),
            ("error".into(), esc(&self.last_error)),
            ("profile".into(), esc(&self.profile)),
        ];
        let enabled: Vec<&DestSnap> = self.destinations.iter().filter(|d| d.enabled).collect();
        let streaming = enabled.iter().filter(|d| d.status == "STREAMING").count();
        f.push(("outputs_total".into(), enabled.len().to_string()));
        f.push(("outputs_live".into(), streaming.to_string()));
        f.push(("all_enabled_live".into(), (!enabled.is_empty() && streaming == enabled.len()).to_string()));
        f.push(("dest_count".into(), self.destinations.len().to_string()));
        for (i, d) in self.destinations.iter().enumerate().take(8) {
            let n = i + 1;
            f.push((format!("out{n}_name"), esc(&d.name)));
            f.push((format!("out{n}_enabled"), d.enabled.to_string()));
            f.push((format!("out{n}_state"), esc(&d.status)));
            f.push((format!("out{n}_live"), (d.status == "STREAMING").to_string()));
            f.push((format!("out{n}_kbps"), num(d.kbps)));
            f.push((format!("out{n}_reconnects"), d.reconnects.to_string()));
        }
        let body: Vec<String> = f.into_iter().map(|(k, v)| format!("{}:{}", esc(&k), v)).collect();
        format!("{{{}}}", body.join(","))
    }
}

/// Parse "/api/..." + query into a command. Pure, unit-tested.
pub fn parse_command(path: &str) -> Result<Command, String> {
    let (p, q) = path.split_once('?').unwrap_or((path, ""));
    let db = || -> Result<f32, String> {
        q.split('&')
            .find_map(|kv| kv.strip_prefix("db="))
            .ok_or_else(|| "missing ?db=".to_string())?
            .parse::<f32>()
            .map_err(|_| "db must be a number".to_string())
            .and_then(|v| if v.is_finite() { Ok(v) } else { Err("db must be a number".into()) })
    };
    let toggle = |s: &str| match s {
        "start" | "on" => Ok(Toggle::On),
        "stop" | "off" => Ok(Toggle::Off),
        "toggle" => Ok(Toggle::Toggle),
        _ => Err(format!("unknown operation '{s}' (on/off/toggle)")),
    };
    Ok(match p.trim_end_matches('/') {
        "/api/go-live" => Command::GoLive,
        "/api/stop" => Command::Stop,
        "/api/cut" => Command::Cut,
        "/api/gain" => Command::Gain(Level::Set(db()?)),
        "/api/gain/adjust" => Command::Gain(Level::Adjust(db()?)),
        "/api/monitor-volume" => Command::MonitorVolume(Level::Set(db()?)),
        "/api/monitor-volume/adjust" => Command::MonitorVolume(Level::Adjust(db()?)),
        other => {
            if let Some(op) = other.strip_prefix("/api/recording/") {
                Command::Recording(toggle(op)?)
            } else if let Some(op) = other.strip_prefix("/api/monitor/") {
                Command::Monitor(toggle(op)?)
            } else {
                return Err(format!("unknown endpoint {p}"));
            }
        }
    })
}

/// Constant-time-ish key compare (length leak only).
fn key_ok(given: &str, key: &str) -> bool {
    if key.is_empty() || given.len() != key.len() {
        return false;
    }
    given.bytes().zip(key.bytes()).fold(0u8, |a, (x, y)| a | (x ^ y)) == 0
}

/// Random 32-char key from the OS (std's RandomState is seeded from the OS RNG).
pub fn new_key() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    while out.len() < 32 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(out.len() as u64);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out.truncate(32);
    out
}

pub struct Server {
    stop: Option<oneshot::Sender<()>>,
    pub bound: String,
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Some(s) = self.stop.take() {
            let _ = s.send(());
        }
    }
}

/// Start listening. Returns once the port is bound (or the bind error).
pub fn start(rt: &tokio::runtime::Runtime, shared: Arc<Shared>, port: u16, lan: bool, key: String) -> Result<Server, String> {
    let host = if lan { "0.0.0.0" } else { "127.0.0.1" };
    let listener = rt
        .block_on(TcpListener::bind((host, port)))
        .map_err(|e| format!("cannot listen on {host}:{port}: {e}"))?;
    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
    let key = Arc::new(key);
    rt.spawn(async move {
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                acc = listener.accept() => {
                    let Ok((sock, _)) = acc else { continue };
                    let shared = Arc::clone(&shared);
                    let key = Arc::clone(&key);
                    tokio::spawn(async move {
                        let _ = tokio::time::timeout(Duration::from_secs(15), handle(sock, shared, key)).await;
                    });
                }
            }
        }
    });
    Ok(Server { stop: Some(stop_tx), bound: format!("{host}:{port}") })
}

async fn handle(mut sock: tokio::net::TcpStream, shared: Arc<Shared>, key: Arc<String>) -> std::io::Result<()> {
    // Read the request head (bodies are not used; cap at 8 KB).
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = sock.read(&mut chunk).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > 8192 {
            return respond(&mut sock, 431, "{\"error\":\"request too large\"}").await;
        }
    }
    let head = String::from_utf8_lossy(&buf).to_string();
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap_or("");
    let mut parts = first.split(' ');
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let given = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("x-restream-key"))
        .map(|(_, v)| v.trim().to_string())
        .unwrap_or_default();
    if !key_ok(&given, &key) {
        return respond(&mut sock, 401, "{\"error\":\"wrong or missing X-Restream-Key (Restream > Control tab)\"}").await;
    }
    if method == "GET" && path.split('?').next() == Some("/api/state") {
        let body = shared.snapshot.lock().to_json();
        return respond(&mut sock, 200, &body).await;
    }
    if method != "POST" {
        return respond(&mut sock, 405, "{\"error\":\"use GET /api/state or POST a command\"}").await;
    }
    let command = match parse_command(&path) {
        Ok(c) => c,
        Err(e) => return respond(&mut sock, 404, &format!("{{\"error\":{}}}", esc(&e))).await,
    };
    let (tx, rx) = oneshot::channel();
    if shared.commands.send(Request { command, reply: tx }).is_err() {
        return respond(&mut sock, 503, "{\"error\":\"Restream is closing\"}").await;
    }
    match tokio::time::timeout(Duration::from_secs(10), rx).await {
        Ok(Ok(Ok(msg))) => {
            let state = shared.snapshot.lock().to_json();
            respond(&mut sock, 200, &format!("{{\"message\":{},\"state\":{}}}", esc(&msg), state)).await
        }
        Ok(Ok(Err(e))) => respond(&mut sock, 409, &format!("{{\"error\":{}}}", esc(&e))).await,
        _ => respond(&mut sock, 504, "{\"error\":\"Restream did not answer (window minimised for a long time?)\"}").await,
    }
}

async fn respond(sock: &mut tokio::net::TcpStream, code: u16, body: &str) -> std::io::Result<()> {
    let reason = match code {
        200 => "OK",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        431 => "Request Header Fields Too Large",
        503 => "Service Unavailable",
        _ => "Gateway Timeout",
    };
    let resp = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    sock.write_all(resp.as_bytes()).await?;
    sock.shutdown().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_commands() {
        assert_eq!(parse_command("/api/go-live"), Ok(Command::GoLive));
        assert_eq!(parse_command("/api/cut/"), Ok(Command::Cut));
        assert_eq!(parse_command("/api/recording/toggle"), Ok(Command::Recording(Toggle::Toggle)));
        assert_eq!(parse_command("/api/monitor/on"), Ok(Command::Monitor(Toggle::On)));
        assert_eq!(parse_command("/api/gain?db=-3.5"), Ok(Command::Gain(Level::Set(-3.5))));
        assert_eq!(parse_command("/api/gain/adjust?db=1"), Ok(Command::Gain(Level::Adjust(1.0))));
        assert_eq!(parse_command("/api/monitor-volume?db=-12"), Ok(Command::MonitorVolume(Level::Set(-12.0))));
        assert!(parse_command("/api/gain").is_err());
        assert!(parse_command("/api/gain?db=NaN").is_err());
        assert!(parse_command("/api/recording/sideways").is_err());
        assert!(parse_command("/api/nope").is_err());
    }

    #[test]
    fn key_check() {
        assert!(key_ok("abc", "abc"));
        assert!(!key_ok("abd", "abc"));
        assert!(!key_ok("", ""));
        assert!(!key_ok("ab", "abc"));
        let k = new_key();
        assert_eq!(k.len(), 32);
        assert_ne!(k, new_key());
    }

    #[test]
    fn json_is_flat_and_escaped() {
        let s = Snapshot {
            state: "ON AIR".into(),
            on_air: true,
            last_error: "bad \"quote\"\n".into(),
            destinations: vec![
                DestSnap { name: "ISU Twitch".into(), enabled: true, status: "STREAMING".into(), kbps: 6123.44, reconnects: 1 },
                DestSnap { name: "YouTube".into(), enabled: false, status: "DISABLED".into(), kbps: 0.0, reconnects: 0 },
            ],
            audio_peak_l: Some(-6.04),
            ..Default::default()
        };
        let j = s.to_json();
        assert!(j.contains("\"state\":\"ON AIR\""), "{j}");
        assert!(j.contains("\"error\":\"bad \\\"quote\\\"\\n\""), "{j}");
        assert!(j.contains("\"out1_live\":true"), "{j}");
        assert!(j.contains("\"out1_kbps\":6123.4"), "{j}");
        assert!(j.contains("\"out2_enabled\":false"), "{j}");
        assert!(j.contains("\"outputs_total\":1") && j.contains("\"all_enabled_live\":true"), "{j}");
        assert!(j.contains("\"audio_peak_l\":-6") && j.contains("\"audio_peak_r\":null"), "{j}");
    }
}

#[cfg(test)]
mod http_tests {
    use super::*;
    use std::io::{Read, Write};

    fn call(port: u16, req: &str) -> String {
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(req.as_bytes()).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        out
    }

    /// Real socket round trip: key check, state, a command answered by a fake "GUI" thread.
    #[test]
    fn server_round_trip() {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().worker_threads(2).build().unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<Request>();
        let shared = Arc::new(Shared { snapshot: Mutex::new(Snapshot { state: "IDLE".into(), ..Default::default() }), commands: tx });
        let port = 39181;
        let srv = start(&rt, Arc::clone(&shared), port, false, "k".repeat(32)).unwrap();
        assert_eq!(srv.bound, format!("127.0.0.1:{port}"));
        // fake GUI thread: answers Gain, refuses Stop
        let gui = std::thread::spawn(move || {
            for _ in 0..2 {
                let r = rx.recv().unwrap();
                let a = match r.command {
                    Command::Gain(Level::Set(v)) => Ok(format!("gain {v:.1} dB")),
                    Command::Stop => Err("not live".into()),
                    _ => Err("?".into()),
                };
                let _ = r.reply.send(a);
            }
        });
        let k = "k".repeat(32);
        let r = call(port, "GET /api/state HTTP/1.1\r\nHost: x\r\n\r\n");
        assert!(r.starts_with("HTTP/1.1 401"), "{r}");
        let r = call(port, &format!("GET /api/state HTTP/1.1\r\nX-Restream-Key: {k}\r\n\r\n"));
        assert!(r.starts_with("HTTP/1.1 200") && r.contains("\"state\":\"IDLE\""), "{r}");
        let r = call(port, &format!("POST /api/gain?db=-4.5 HTTP/1.1\r\nx-restream-key: {k}\r\nContent-Length: 0\r\n\r\n"));
        assert!(r.starts_with("HTTP/1.1 200") && r.contains("gain -4.5 dB"), "{r}");
        let r = call(port, &format!("POST /api/stop HTTP/1.1\r\nX-Restream-Key: {k}\r\n\r\n"));
        assert!(r.starts_with("HTTP/1.1 409") && r.contains("not live"), "{r}");
        let r = call(port, &format!("POST /api/fly HTTP/1.1\r\nX-Restream-Key: {k}\r\n\r\n"));
        assert!(r.starts_with("HTTP/1.1 404"), "{r}");
        gui.join().unwrap();
        drop(srv);
        std::thread::sleep(Duration::from_millis(200));
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err(), "port freed after the server is dropped");
    }
}

/// Manual end-to-end helper (not a test): `cargo test -p restream-gui -- --ignored serve_for_module_test`
/// serves a fake GUI on 127.0.0.1:39182 (key "k"*32) for 20 s so the Companion module client can be run against it.
#[cfg(test)]
#[test]
#[ignore]
fn serve_for_module_test() {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().worker_threads(2).build().unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<Request>();
    let snap = Snapshot {
        state: "ON AIR".into(),
        on_air: true,
        delay_seconds: 180,
        delay_filled_seconds: 180.0,
        audio_peak_l: Some(-0.5),
        destinations: vec![DestSnap { name: "ISU Twitch".into(), enabled: true, status: "STREAMING".into(), kbps: 6000.0, reconnects: 0 }],
        ..Default::default()
    };
    let shared = Arc::new(Shared { snapshot: Mutex::new(snap), commands: tx });
    let _srv = start(&rt, Arc::clone(&shared), 39182, false, "k".repeat(32)).unwrap();
    let end = std::time::Instant::now() + Duration::from_secs(20);
    while std::time::Instant::now() < end {
        if let Ok(r) = rx.recv_timeout(Duration::from_millis(100)) {
            let a = match r.command {
                Command::Gain(Level::Adjust(d)) => {
                    let mut s = shared.snapshot.lock();
                    s.gain_db += d;
                    Ok(format!("gain {:.1} dB", s.gain_db))
                }
                Command::GoLive => Err("already live".into()),
                _ => Ok("ok".into()),
            };
            let _ = r.reply.send(a);
        }
    }
}
