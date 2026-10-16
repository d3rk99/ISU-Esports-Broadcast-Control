//! Real-socket tests of the overlay server (3174 behaviour) and the Companion API (3176).
use std::io::{Read, Write};
use std::sync::Arc;
use std::time::Duration;

use isu_core::{Value, json};
use isu_server::companion::{ActionRequest, Companion};
use isu_server::overlay::{self, Config};
use isu_server::store::Store;

fn http(port: u16, req: &str) -> (u16, String, String) {
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    s.write_all(req.as_bytes()).unwrap();
    let mut out = Vec::new();
    let _ = s.read_to_end(&mut out);
    let text = String::from_utf8_lossy(&out).to_string();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let code = head.split(' ').nth(1).unwrap_or("0").parse().unwrap_or(0);
    // de-chunk if needed
    let body = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") { dechunk(body) } else { body.to_string() };
    (code, head.to_string(), body)
}

fn dechunk(mut b: &str) -> String {
    let mut out = String::new();
    while let Some((len, rest)) = b.split_once("\r\n") {
        let n = usize::from_str_radix(len.trim(), 16).unwrap_or(0);
        if n == 0 { break; }
        out.push_str(&rest[..n.min(rest.len())]);
        b = rest.get(n + 2..).unwrap_or("");
    }
    out
}

fn get(port: u16, path: &str) -> (u16, String, String) {
    http(port, &format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"))
}

fn tmpdir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("isu-rs-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn overlay_server_routes_like_main_cjs() {
    let root = tmpdir("static");
    std::fs::create_dir_all(root.join("overlays")).unwrap();
    std::fs::write(root.join("overlays/scoreboard.html"), "<html>hi</html>").unwrap();
    std::fs::write(root.join("secret.txt"), "no").unwrap();
    let assets = tmpdir("assets");
    std::fs::write(assets.join("logo.png"), [137u8, 80, 78, 71]).unwrap();
    let store = Store::new();
    store.publish(json!({ "selectedGame": "valorant", "games": {} }));
    store.record_diagnostic("test", "hello");
    let cfg = Config { static_root: root, asset_root: assets, rl_pack: None, rl_backup: Arc::new(|| Value::Null) };
    let addr = overlay::start(Arc::clone(&store), cfg, 0).await.unwrap();
    let p = addr.port();
    tokio::task::spawn_blocking(move || {
        let (c, h, b) = get(p, "/api/state");
        assert_eq!(c, 200);
        assert!(h.to_ascii_lowercase().contains("cache-control: no-store") && h.to_ascii_lowercase().contains("access-control-allow-origin: *"), "{h}");
        let v: Value = serde_json::from_str(&b).unwrap();
        assert_eq!(v["selectedGame"], "valorant");
        assert!(v.get("spectated").is_some_and(Value::is_null), "withSpectated adds spectated: null");
        let (c, _, b) = get(p, "/api/health");
        let v: Value = serde_json::from_str(&b).unwrap();
        assert_eq!((c, v["ok"].clone(), v["port"].clone()), (200, json!(true), json!(3174)));
        assert_eq!(v["diagnostics"][0]["type"], "test");
        let (c, h, b) = get(p, "/overlays/scoreboard.html");
        assert_eq!((c, b.as_str()), (200, "<html>hi</html>"));
        assert!(h.contains("text/html; charset=utf-8"));
        let (c, h, _) = get(p, "/user-assets/logo.png");
        assert!(c == 200 && h.contains("image/png"));
        assert_eq!(get(p, "/overlays/../secret.txt").0, 404, "no escaping the static root");
        assert_eq!(get(p, "/overlays/%2e%2e/secret.txt").0, 404, "no escaping with %2e%2e");
        assert_eq!(get(p, "/secret.txt").0, 404, "only the listed prefixes are served");
        assert_eq!(get(p, "/overlays/missing.html").0, 404);
        assert_eq!(get(p, "/rl-loadout-assets/x.png").0, 404);
        let (c, _, b) = http(p, "POST /api/state HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        assert_eq!(c, 405); assert!(b.contains("Method not allowed"));
    }).await.unwrap();

    // SSE: retry + initial state, then a publish arrives
    let mut s = std::net::TcpStream::connect(("127.0.0.1", p)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    s.write_all(b"GET /events HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
    let read_some = |s: &mut std::net::TcpStream, needle: &str| {
        let mut acc = String::new();
        let mut buf = [0u8; 4096];
        for _ in 0..50 { if acc.contains(needle) { break; } match s.read(&mut buf) { Ok(n) if n > 0 => acc.push_str(&String::from_utf8_lossy(&buf[..n])), _ => break } }
        acc
    };
    let first = read_some(&mut s, "\n\n");
    assert!(first.contains("text/event-stream") && first.contains("retry: 1000\ndata: {"), "{first}");
    assert_eq!(store.hub.size(), 1);
    store.publish(json!({ "selectedGame": "overwatch" }));
    let next = read_some(&mut s, "overwatch");
    assert!(next.contains("data: {") && next.contains("overwatch"), "{next}");
    drop(s);
    tokio::time::sleep(Duration::from_millis(300)).await;
    store.publish(json!({ "selectedGame": "smash" })); // a closed viewer is noticed on the next send
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(store.hub.size(), 0, "closed SSE viewer removed");
}

#[test]
fn stalled_viewer_is_dropped_after_1mb() {
    let store = Store::new();
    let v = store.hub.add(Arc::from("{}"));
    let big: Arc<str> = Arc::from("x".repeat(400 * 1024));
    for _ in 0..4 { store.hub.publish(Arc::clone(&big)); } // never read: 1.6 MB pending
    store.hub.publish(Arc::clone(&big));
    assert_eq!(store.hub.size(), 0, "dropped once more than 1 MB is unsent");
    assert_eq!(store.lock().diagnostics.last().unwrap()["type"], "overlay-client-dropped");
    drop(v);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn companion_api_like_companion_api_service_cjs() {
    let store = Store::new();
    let mut state = isu_core::game_config::initial_state();
    state["updatedAt"] = json!("t");
    store.publish(state);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ActionRequest>();
    // the "controller": runs actions on the store with the Rust port of companion-actions.js
    let s2 = Arc::clone(&store);
    tokio::spawn(async move {
        while let Some(r) = rx.recv().await {
            let mut st = s2.state();
            let out = isu_core::actions::apply_companion_action(&mut st, &r.body, 0.0);
            match out { Ok(res) => { s2.publish(st); let _ = r.reply.send(Ok(res.to_json())); } Err(e) => { let _ = r.reply.send(Err((e.status, e.message))); } }
        }
    });
    let c = Companion::new(Arc::clone(&store), Arc::new(|| json!({ "onlineCount": 1 })), tx);
    let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let st = c.configure(&json!({ "enabled": true, "port": free, "token": "k".repeat(32) })).await;
    assert_eq!(st["listening"], true, "{st}");
    let k = "k".repeat(32);
    tokio::task::spawn_blocking(move || {
        let (code, _, b) = get(free, "/api/companion/health");
        assert_eq!(code, 200); assert!(b.contains("\"apiVersion\":1"));
        assert_eq!(get(free, "/api/companion/variables").0, 401);
        assert_eq!(get(free, "/nope").0, 404);
        let (code, _, b) = get(free, &format!("/api/companion/variables?token={k}"));
        let v: Value = serde_json::from_str(&b).unwrap();
        assert_eq!(code, 200); assert_eq!(v["home_score"], 0); assert_eq!(v["display_online_count"], 1);
        let post = |body: &str, auth: &str| http(free, &format!("POST /api/companion/action HTTP/1.1\r\nHost: x\r\n{auth}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()));
        let (code, _, b) = post(r#"{"action":"score.increment","team":"home"}"#, &format!("X-ISU-API-Key: {k}"));
        let v: Value = serde_json::from_str(&b).unwrap();
        assert_eq!(code, 200, "{b}"); assert_eq!(v["ok"], true); assert_eq!(v["variables"]["home_score"], 1);
        let (code, _, b) = post(r#"{"action":"score.increment","team":"left"}"#, &format!("Authorization: Bearer {k}"));
        assert_eq!(code, 400); assert!(b.contains("team must be home or away"), "{b}");
        let (code, _, b) = post(r#"{"action":"fly"}"#, &format!("X-ISU-API-Key: {k}"));
        assert_eq!(code, 404, "{b}");
        let (code, _, b) = post("{not json", &format!("X-ISU-API-Key: {k}"));
        assert_eq!(code, 400); assert!(b.contains("valid JSON"));
        let (code, _, _) = post(r#"[1]"#, &format!("X-ISU-API-Key: {k}"));
        assert_eq!(code, 400);
        let (code, h, _) = http(free, "OPTIONS /api/companion/action HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
        assert_eq!(code, 204); assert!(h.contains("X-ISU-API-Key"));
    }).await.unwrap();
    let st = c.configure(&json!({ "enabled": false, "port": free, "token": "k".repeat(32) })).await;
    assert_eq!(st["listening"], false);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(std::net::TcpStream::connect(("127.0.0.1", free)).is_err(), "port freed when disabled");
}

#[test]
fn url_pathname_matches_whatwg() {
    // expected values printed by node: new URL(p, 'http://x').pathname
    for (p, want) in [("/overlays/../secret.txt", "/secret.txt"), ("/overlays/%2e%2e/secret.txt", "/secret.txt"), ("/a/./b", "/a/b"), ("/a/b/..", "/a/"), ("/overlays/x/%2E/y.html", "/overlays/x/y.html"), ("/..", "/")] {
        assert_eq!(isu_server::overlay::url_pathname(p), want, "{p}");
    }
}
