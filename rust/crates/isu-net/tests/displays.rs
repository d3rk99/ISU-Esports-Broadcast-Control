//! test/display-manager.test.cjs, ported 1:1 against the Rust Display Manager (real WebSockets).
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use isu_net::displays::DisplayManager;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

struct St { tx: futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, Message>, msgs: Arc<Mutex<Vec<Value>>>, close: Arc<Mutex<Option<u16>>> }

async fn station(port: u16, hello: Value) -> St {
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/display")).await.unwrap();
    let (mut tx, mut rx) = ws.split();
    let mut h = hello; h["type"] = json!("hello");
    tx.send(Message::Text(h.to_string().into())).await.unwrap();
    let (msgs, close): (Arc<Mutex<Vec<Value>>>, Arc<Mutex<Option<u16>>>) = Default::default();
    let (m2, c2) = (Arc::clone(&msgs), Arc::clone(&close));
    tokio::spawn(async move { while let Some(Ok(m)) = rx.next().await { match m { Message::Text(t) => m2.lock().unwrap().push(serde_json::from_str(&t).unwrap()), Message::Close(f) => { *c2.lock().unwrap() = f.map(|f| u16::from(f.code)); } _ => {} } } });
    tokio::time::sleep(Duration::from_millis(120)).await;
    St { tx, msgs, close }
}
async fn wait(ms: u64) { tokio::time::sleep(Duration::from_millis(ms)).await; }
fn last(s: &St) -> Value { s.msgs.lock().unwrap().last().cloned().unwrap() }
fn last_noise(s: &St) -> Value { s.msgs.lock().unwrap().iter().rev().find(|m| m["type"] == "noise").cloned().unwrap() }
async fn dm(key: &str) -> Arc<DisplayManager> { let d = DisplayManager::new(0, "127.0.0.1", key, Arc::new(|_| {})); d.start().await; d }
fn port(d: &DisplayManager) -> u16 { d.status()["port"].as_u64().unwrap() as u16 }

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stations_get_their_mode_on_connect_and_on_change() {
    let d = dm("").await;
    let mut s3 = station(port(&d), json!({ "station": 3, "hostname": "PC3", "version": "1.0" })).await;
    assert_eq!(s3.msgs.lock().unwrap()[..3].to_vec(), vec![json!({ "type": "welcome", "station": 3 }), json!({ "type": "mode", "mode": "ndi", "source": "ISU Stage 03" }), json!({ "type": "noise", "on": false, "volume": 30 })]);
    assert_eq!(d.status()["onlineCount"], 1);
    d.set_mode("3", "mirror", ""); wait(80).await;
    assert_eq!(last(&s3), json!({ "type": "mode", "mode": "mirror", "source": "ISU Stage 03" }));
    d.set_mode("all", "ndi", "OBS (Custom)"); wait(80).await;
    assert_eq!(last(&s3), json!({ "type": "mode", "mode": "ndi", "source": "OBS (Custom)" }));
    s3.tx.send(Message::Text(json!({ "type": "status", "state": "receiving", "fps": 30 }).to_string().into())).await.unwrap(); wait(80).await;
    let row = d.status()["stations"][2].clone();
    assert_eq!((row["state"].clone(), row["fps"].clone(), row["hostname"].clone()), (json!("receiving"), json!(30), json!("PC3")));
    assert_eq!(d.set_mode("11", "ndi", "")["ok"], false);
    assert_eq!(d.set_mode("1", "wall", "")["ok"], false);
    s3.tx.send(Message::Close(None)).await.unwrap(); wait(150).await;
    assert_eq!(d.status()["onlineCount"], 0);
    d.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn key_required_and_station_in_use() {
    let d = dm("secret").await;
    let bad = station(port(&d), json!({ "station": 2, "hostname": "A", "key": "nope" })).await; wait(80).await;
    assert_eq!(*bad.close.lock().unwrap(), Some(4003));
    let a = station(port(&d), json!({ "station": 2, "hostname": "A", "key": "secret" })).await;
    let b = station(port(&d), json!({ "station": 2, "hostname": "B", "key": "secret" })).await; wait(80).await;
    assert_eq!(*b.close.lock().unwrap(), Some(4009));
    assert_eq!(*a.close.lock().unwrap(), None, "A still connected");
    assert_eq!(d.status()["stations"][1]["hostname"], "A");
    d.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn groups_switch_separately() {
    let d = dm("").await;
    let s2 = station(port(&d), json!({ "station": 2, "hostname": "V2" })).await;
    let s7 = station(port(&d), json!({ "station": 7, "hostname": "JV7" })).await;
    assert_eq!(d.set_mode("6-10", "mirror", "")["ok"], true);
    assert_eq!(d.set_mode("1-5", "ndi", "")["ok"], true); wait(80).await;
    assert_eq!(last(&s7)["mode"], "mirror"); assert_eq!(last(&s2)["mode"], "ndi");
    let modes: Vec<Value> = d.status()["stations"].as_array().unwrap().iter().map(|s| s["mode"].clone()).collect();
    assert_eq!(Value::Array(modes), json!(["ndi", "ndi", "ndi", "ndi", "ndi", "mirror", "mirror", "mirror", "mirror", "mirror"]));
    assert_eq!(d.set_mode("6-10", "mirror", "")["stations"], json!([6, 7, 8, 9, 10]));
    assert_eq!(d.set_mode("11-15", "ndi", "")["ok"], false);
    d.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pink_noise_groups_toggle_volume_reconnect() {
    let d = dm("").await;
    let s2 = station(port(&d), json!({ "station": 2, "hostname": "PC2" })).await;
    let mut s7 = station(port(&d), json!({ "station": 7, "hostname": "PC7" })).await;
    assert_eq!(d.set_noise("1-5", &json!(true), Some(&json!(40)))["ok"], true); wait(80).await;
    assert_eq!(last_noise(&s2), json!({ "type": "noise", "on": true, "volume": 40 }));
    assert_eq!(last_noise(&s7), json!({ "type": "noise", "on": false, "volume": 30 }));
    d.set_noise("all", &json!("keep"), Some(&json!(55))); wait(80).await;
    assert_eq!(last_noise(&s2), json!({ "type": "noise", "on": true, "volume": 55 }));
    assert_eq!(last_noise(&s7), json!({ "type": "noise", "on": false, "volume": 55 }));
    assert_eq!(d.set_noise("all", &json!("toggle"), None)["on"], true, "mixed group toggles ON");
    assert_eq!(d.set_noise("all", &json!("toggle"), None)["on"], false);
    d.set_noise("7", &json!(true), Some(&json!(250))); wait(80).await;
    assert_eq!(last_noise(&s7), json!({ "type": "noise", "on": true, "volume": 100 }));
    s7.tx.send(Message::Text(json!({ "type": "status", "state": "receiving", "noise": { "state": "playing", "device": "Headset (USB)", "error": "" } }).to_string().into())).await.unwrap(); wait(80).await;
    let row = d.status()["stations"][6].clone();
    assert_eq!(row["noiseState"], "playing"); assert_eq!(row["noiseDevice"], "Headset (USB)");
    s7.tx.send(Message::Close(None)).await.unwrap(); wait(150).await;
    let back = station(port(&d), json!({ "station": 7, "hostname": "PC7" })).await;
    assert_eq!(last_noise(&back), json!({ "type": "noise", "on": true, "volume": 100 }), "reconnect gets the noise back");
    assert_eq!(d.set_noise("11", &json!(true), None)["ok"], false);
    d.stop();
}

#[tokio::test]
async fn plain_http_gets_426() {
    let d = dm("").await;
    let p = port(&d);
    let r = tokio::task::spawn_blocking(move || { use std::io::{Read, Write}; let mut s = std::net::TcpStream::connect(("127.0.0.1", p)).unwrap(); s.write_all(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n").unwrap(); let mut o = String::new(); let _ = s.read_to_string(&mut o); o }).await.unwrap();
    assert!(r.starts_with("HTTP/1.1 426") && r.ends_with("ISU display manager: WebSocket only"), "{r}");
    d.stop();
}
