//! Real-socket tests: a fake Game Bridge connects to the Rust receivers like the JS bridge does.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use isu_net::rocket_league::RocketLeagueService;
use isu_net::spectate::SpectateReceiver;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

fn free_port() -> u16 { std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port() }

async fn next_json<S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin>(s: &mut S) -> Value {
    loop {
        match tokio::time::timeout(Duration::from_secs(3), s.next()).await.expect("message in time") {
            Some(Ok(Message::Text(t))) => return serde_json::from_str(&t).unwrap(),
            Some(Ok(_)) => continue,
            other => panic!("socket ended: {other:?}"),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn spectate_receiver_link() {
    let got: Arc<Mutex<Vec<Value>>> = Arc::default();
    let g2 = Arc::clone(&got);
    let r = SpectateReceiver::new(Arc::new(move |v| g2.lock().unwrap().push(v)), Arc::new(|_| {}));
    let port = free_port();
    r.set_candidates(&[json!({ "name": "Sn0wfal", "station": 1, "side": "home", "agent": "viper" })], &json!({ "red": "home", "teal": "away", "round": 3 }));
    let st = r.configure(&json!({ "enabled": true, "port": port, "token": "k".repeat(24) }));
    assert_eq!(st["settings"]["token"], "(set)");
    tokio::time::sleep(Duration::from_millis(150)).await;
    // wrong key: closed with 1008
    let (mut bad, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/game-bridge?token=nope")).await.unwrap();
    match tokio::time::timeout(Duration::from_secs(3), bad.next()).await.unwrap() {
        Some(Ok(Message::Close(Some(f)))) => { assert_eq!(u16::from(f.code), 1008); assert_eq!(f.reason.as_str(), "Invalid bridge key"); }
        other => panic!("expected close 1008, got {other:?}"),
    }
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/game-bridge?token={}&game=valorant", "k".repeat(24))).await.unwrap();
    let first = next_json(&mut ws).await;
    assert_eq!(first["type"], "spectate-candidates");
    assert_eq!(first["candidates"][0]["name"], "Sn0wfal");
    assert_eq!(first["sides"], json!({ "red": "home", "teal": "away", "round": 3 }));
    assert_eq!(next_json(&mut ws).await, json!({ "type": "welcome", "version": 1 }));
    // candidates change -> pushed
    r.set_candidates(&[json!({ "name": "santi" })], &Value::Null);
    let push = next_json(&mut ws).await;
    assert_eq!(push["candidates"][0]["name"], "santi");
    // the bridge reports who it sees
    ws.send(Message::Text(json!({ "type": "spectated", "game": "valorant", "version": 1, "payload": { "name": "santi", "station": 6 } }).to_string().into())).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let g = got.lock().unwrap().clone();
    assert_eq!(g.len(), 1); assert_eq!(g[0]["name"], "santi"); assert_eq!(g[0]["game"], "valorant"); assert!(g[0]["receivedAt"].as_f64().unwrap() > 0.0);
    assert_eq!(r.status()["state"], "connected");
    r.configure(&json!({ "enabled": false }));
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err(), "port freed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rocket_league_bridge_receiver_and_local_tcp() {
    let events: Arc<Mutex<Vec<Value>>> = Arc::default();
    let e2 = Arc::clone(&events);
    let svc = RocketLeagueService::new(Arc::new(move |v| e2.lock().unwrap().push(v)), Arc::new(|_| {}));
    // 1) Graphics PC receiver: the Game PC forwards 'game-telemetry'
    let port = free_port();
    svc.configure(&json!({ "enabled": true, "source": "remote", "bridgePort": port, "bridgeToken": "secret-key-1234", "updateIntervalMs": 1 }));
    tokio::time::sleep(Duration::from_millis(150)).await;
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/game-bridge?token=secret-key-1234")).await.unwrap();
    assert_eq!(next_json(&mut ws).await["type"], "welcome");
    for i in 0..3 { ws.send(Message::Text(json!({ "type": "game-telemetry", "game": "rocketleague", "payload": { "Event": "UpdateState", "Data": { "i": i } } }).to_string().into())).await.unwrap(); tokio::time::sleep(Duration::from_millis(40)).await; } // > updateIntervalMs, which drops closer UpdateStates (same rule as the JS)
    ws.send(Message::Text(json!({ "type": "telemetry", "event": { "event": "GoalScored", "data": "{\"x\":1}" } }).to_string().into())).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    {
        let ev = events.lock().unwrap();
        assert_eq!(ev.len(), 4, "{ev:?}");
        assert_eq!(ev[3], json!({ "Event": "GoalScored", "Data": { "x": 1 } }));
    }
    assert_eq!(svc.status()["state"], "connected");
    assert_eq!(svc.status()["transport"], "bridge");
    // 2) Local Rocket League on TCP (Stats API raw JSON stream, split across writes)
    events.lock().unwrap().clear();
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let tcp = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        let (mut s, _) = l.accept().await.unwrap();
        s.write_all(br#"{"Event":"MatchCreated","Data":{"MatchGuid":"G"}}{"Event":"UpdateSt"#).await.unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        s.write_all("ate\",\"Data\":{\"Name\":\"J\u{e4}ger\"}}".as_bytes()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(400)).await;
    });
    svc.configure(&json!({ "enabled": true, "source": "local", "transport": "tcp", "host": "127.0.0.1", "tcpPort": tcp, "updateIntervalMs": 1 }));
    tokio::time::sleep(Duration::from_millis(250)).await;
    let ev = events.lock().unwrap().clone();
    assert_eq!(ev.len(), 2, "{ev:?}");
    assert_eq!(ev[1]["Data"]["Name"], "Jäger", "UTF-8 split across reads");
    svc.stop();
}

/// Game PC -> Graphics PC end to end, all Rust: the Game Bridge runs the RL simulator and forwards
/// it; the Graphics PC's RocketLeagueService (remote mode) receives the same events.
#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn game_bridge_forwards_rocket_league_to_graphics_pc() {
    let got: Arc<Mutex<Vec<Value>>> = Arc::default();
    let g2 = Arc::clone(&got);
    let graphics = RocketLeagueService::new(Arc::new(move |v| g2.lock().unwrap().push(v)), Arc::new(|_| {}));
    let port = free_port();
    graphics.configure(&json!({ "enabled": true, "source": "remote", "bridgePort": port, "bridgeToken": "bridge-key-0123456", "updateIntervalMs": 1 }));
    tokio::time::sleep(Duration::from_millis(150)).await;
    let statuses: Arc<Mutex<Vec<Value>>> = Arc::default();
    let s2 = Arc::clone(&statuses);
    let bridge = isu_net::bridge::GameBridge::new(None, Arc::new(move |s| s2.lock().unwrap().push(s)), Arc::new(|_| {}));
    let st = bridge.start(&json!({ "game": "rocketleague", "graphicsHost": "127.0.0.1", "bridgePort": port, "bridgeToken": "bridge-key-0123456", "rocketLeague": { "host": "127.0.0.1", "webPort": free_port(), "tcpPort": free_port() } }));
    assert_eq!(st["remote"]["state"], "connecting");
    for _ in 0..50 { if bridge.status()["remote"]["state"] == "connected" { break; } tokio::time::sleep(Duration::from_millis(50)).await; }
    assert_eq!(bridge.status()["remote"]["state"], "connected", "{}", bridge.status());
    bridge.start_simulator();
    tokio::time::sleep(Duration::from_millis(2300)).await;
    let ev = got.lock().unwrap().clone();
    assert!(ev.len() >= 3, "{ev:?}");
    assert_eq!(ev[0]["Event"], "MatchCreated");
    assert_eq!(ev[1]["Event"], "UpdateState");
    assert_eq!(ev[1]["Data"]["Players"][0]["Name"], "BengalOne");
    assert!(bridge.status()["remote"]["sentPackets"].as_u64().unwrap() >= 3);
    assert_eq!(graphics.status()["transport"], "bridge");
    // wrong key -> the bridge waits and retries (Graphics PC closes with 1008)
    bridge.start(&json!({ "game": "rocketleague", "graphicsHost": "127.0.0.1", "bridgePort": port, "bridgeToken": "wrong-key-0123456" }));
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(bridge.status()["remote"]["state"], "waiting", "{}", bridge.status());
    assert_eq!(bridge.status()["remote"]["message"], "Invalid bridge key");
    bridge.stop(); graphics.stop();
}
