//! The controller's real services, started like main.cjs whenReady(): overlay 3174 serves the
//! state, Companion 3176 runs a score action and a stage action over HTTP, a display station
//! gets its mode. Uses a temp userData folder. Ports are the real ones, so this test runs alone.
use std::io::{Read, Write};
use std::sync::Arc;

use isu_control::core::Core;
use isu_control::services::Services;
use isu_control::settings::Files;
use serde_json::{Value, json};

fn http(port: u16, req: &str) -> (u16, Value) {
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.write_all(req.as_bytes()).unwrap();
    let mut o = String::new();
    let _ = s.read_to_string(&mut o);
    let code = o[9..12].parse().unwrap();
    let body = o.split("\r\n\r\n").nth(1).unwrap_or("");
    let body = if o.to_lowercase().contains("transfer-encoding: chunked") { body.split("\r\n").filter(|l| l.starts_with('{') || l.starts_with('[')).collect::<String>() } else { body.to_string() };
    (code, serde_json::from_str(&body).unwrap_or(Value::Null))
}

#[test]
fn services_start_and_serve() {
    let dir = std::env::temp_dir().join(format!("isu-svc-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("companion-api.json"), r#"{"enabled":true,"port":3176,"token":"test-token-0123456789"}"#).unwrap();
    let core = Core::new(Files::new(dir.clone()), isu_server::Store::new());
    let svc = Services::start(Arc::clone(&core));
    assert_eq!(*svc.overlay_error.lock().unwrap(), "");
    std::thread::sleep(std::time::Duration::from_millis(300));

    let (c, st) = http(3174, "GET /api/state HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    assert_eq!(c, 200);
    assert_eq!(st["selectedGame"], core.state()["selectedGame"]);

    // Companion must receive the original timestamp, rather than the timestamp-free
    // overlay projection, and retain the same ten-second expiry as the JS service.
    core.store.set_spectated(isu_server::store::Spectated {
        name: "Spectator test".into(), station: Some(3.0), side: "home".into(),
        team: "IDAHO STATE".into(), received_at: isu_control::core::now_ms(),
    });
    let vars_request = "GET /api/companion/variables HTTP/1.1\r\nHost: x\r\nX-ISU-API-Key: test-token-0123456789\r\nConnection: close\r\n\r\n";
    let (_, vars) = http(3176, vars_request);
    assert_eq!(vars["spectated_name"], "Spectator test");
    assert_eq!(vars["spectated_station"], 3);
    assert_eq!(vars["spectated_known"], true);
    core.store.set_spectated(isu_server::store::Spectated {
        name: "Spectator test".into(), received_at: isu_control::core::now_ms() - 11_000.0,
        ..Default::default()
    });
    let (_, expired) = http(3176, vars_request);
    assert_eq!(expired["spectated_name"], "");
    assert_eq!(expired["spectated_known"], false);

    let body = json!({ "action": "score.increment", "game": "valorant", "team": "away" }).to_string();
    let (c, r) = http(3176, &format!("POST /api/companion/action HTTP/1.1\r\nHost: x\r\nX-ISU-API-Key: test-token-0123456789\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()));
    assert_eq!(c, 200, "{r}");
    assert_eq!(core.state()["games"]["valorant"]["teams"][1]["score"], 1);
    std::thread::sleep(std::time::Duration::from_millis(100));
    let (_, st) = http(3174, "GET /api/state HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    assert_eq!(st["games"]["valorant"]["teams"][1]["score"], 1, "overlay got the new score");

    let body = json!({ "action": "stage.display.mode", "station": "1-5", "mode": "mirror" }).to_string();
    let (c, r) = http(3176, &format!("POST /api/companion/action HTTP/1.1\r\nHost: x\r\nX-ISU-API-Key: test-token-0123456789\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()));
    assert_eq!(c, 200, "{r}");
    let modes: Vec<Value> = svc.displays.status()["stations"].as_array().unwrap().iter().map(|s| s["mode"].clone()).collect();
    assert_eq!(&modes[..6], &[json!("mirror"), json!("mirror"), json!("mirror"), json!("mirror"), json!("mirror"), json!("ndi")]);
    let body = json!({ "action": "stage.display.noise", "on": "ON" }).to_string();
    let (c, _) = http(3176, &format!("POST /api/companion/action HTTP/1.1\r\nHost: x\r\nX-ISU-API-Key: test-token-0123456789\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()));
    assert_eq!(c, 200);
    assert!(svc.displays.status()["stations"].as_array().unwrap().iter().all(|s| s["noise"] == true));
    let body = json!({ "action": "stage.nope" }).to_string();
    let (c, _) = http(3176, &format!("POST /api/companion/action HTTP/1.1\r\nHost: x\r\nX-ISU-API-Key: test-token-0123456789\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()));
    assert_eq!(c, 404);

    std::thread::sleep(std::time::Duration::from_millis(300));
    assert!(dir.join("control-state.json").exists(), "state saved");
    svc.shutdown();
    let _ = std::fs::remove_dir_all(dir);
}
