//! Controller -> OBS for the audience displays: electron/displays/obs-displays.cjs.
//! obs-websocket 5 (rpcVersion 1): Hello / Identify (sha256 auth) / requests. setup_stage_scenes
//! builds or repairs scene "ISU Stage NN" -> browser source "ISU Stage NN Page" (?station=NN) ->
//! DistroAV filter "ISU Stage NN NDI", plus "ISU Stage All" nesting them all on Program.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

pub const STATION_COUNT: u32 = 10;
pub const ALL_SCENE: &str = "ISU Stage All";

pub struct Names {
    pub scene: String,
    pub input: String,
    pub filter: String,
    pub ndi: String,
}

pub fn names(n: u32) -> Names {
    Names { scene: format!("ISU Stage {n:02}"), input: format!("ISU Stage {n:02} Page"), filter: format!("ISU Stage {n:02} NDI"), ndi: format!("ISU Stage {n:02}") }
}

/// authString(password, salt, challenge): base64(sha256(base64(sha256(password + salt)) + challenge)).
pub fn auth_string(password: &str, salt: &str, challenge: &str) -> String {
    let b64 = base64::engine::general_purpose::STANDARD;
    let secret = b64.encode(Sha256::digest(format!("{password}{salt}")));
    b64.encode(Sha256::digest(format!("{secret}{challenge}")))
}

/// stationUrl(controllerUrl, station): new URL('/displays/station.html', base) + ?station=N.
pub fn station_url(controller_url: &str, station: u32) -> String {
    let mut u = url::Url::parse(controller_url).and_then(|b| b.join("/displays/station.html")).unwrap_or_else(|_| url::Url::parse("http://127.0.0.1:3174/displays/station.html").unwrap());
    u.query_pairs_mut().clear().append_pair("station", &station.to_string());
    u.to_string()
}

#[derive(Debug, Clone)]
pub struct ObsError {
    pub message: String,
    pub code: Option<i64>,
}

impl std::fmt::Display for ObsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

fn err(m: impl Into<String>) -> ObsError {
    ObsError { message: m.into(), code: None }
}

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, ObsError>>>>>;

pub struct ObsClient {
    timeout: Duration,
    tx: Option<mpsc::UnboundedSender<String>>,
    pending: Pending,
    next_id: u64,
    pub info: Option<Value>,
}

impl Default for ObsClient {
    fn default() -> Self {
        Self { timeout: Duration::from_millis(8000), tx: None, pending: Arc::default(), next_id: 1, info: None }
    }
}

impl ObsClient {
    /// connect({ host, port, password }).
    pub async fn connect(&mut self, host: &str, port: u16, password: &str) -> Result<Value, ObsError> {
        self.close();
        let mut req = format!("ws://{host}:{port}").into_client_request().map_err(|e| err(e.to_string()))?;
        req.headers_mut().insert("Sec-WebSocket-Protocol", "obswebsocket.json".parse().unwrap());
        let fut = async {
            let (ws, _) = tokio_tungstenite::connect_async(req).await.map_err(|e| err(format!("Can't reach OBS at {host}:{port}: {}", io_code(&e))))?;
            let (mut wtx, mut wrx) = ws.split();
            // Hello
            let hello = loop {
                match wrx.next().await {
                    Some(Ok(Message::Text(t))) => {
                        let m: Value = serde_json::from_str(&t).map_err(|e| err(e.to_string()))?;
                        if m["op"] == 0 {
                            break m;
                        }
                    }
                    Some(Ok(Message::Close(f))) => return Err(close_err(f.map(|f| u16::from(f.code)))),
                    None | Some(Err(_)) => return Err(err(format!("OBS closed the connection (1006)"))),
                    _ => {}
                }
            };
            let info = json!({ "obsVersion": hello["d"]["obsStudioVersion"], "wsVersion": hello["d"]["obsWebSocketVersion"] });
            let auth = &hello["d"]["authentication"];
            if auth.is_object() && password.is_empty() {
                return Err(err("OBS needs a WebSocket password; enter it in the controller"));
            }
            let mut d = json!({ "rpcVersion": 1, "eventSubscriptions": 0 });
            if auth.is_object() {
                d["authentication"] = json!(auth_string(password, auth["salt"].as_str().unwrap_or(""), auth["challenge"].as_str().unwrap_or("")));
            }
            wtx.send(Message::Text(json!({ "op": 1, "d": d }).to_string().into())).await.map_err(|e| err(e.to_string()))?;
            loop {
                match wrx.next().await {
                    Some(Ok(Message::Text(t))) => {
                        if serde_json::from_str::<Value>(&t).is_ok_and(|m| m["op"] == 2) {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(f))) => return Err(close_err(f.map(|f| u16::from(f.code)))),
                    None | Some(Err(_)) => return Err(err("OBS closed the connection (1006)")),
                    _ => {}
                }
            }
            Ok((wtx, wrx, info))
        };
        let (mut wtx, mut wrx, info) = tokio::time::timeout(self.timeout, fut).await.map_err(|_| err(format!("OBS did not answer at {host}:{port} (is OBS open with WebSocket Server enabled?)")))??;
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let pending = Arc::clone(&self.pending);
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    out = rx.recv() => match out { Some(t) => { if wtx.send(Message::Text(t.into())).await.is_err() { break; } } None => { let _ = wtx.close().await; break; } },
                    m = wrx.next() => match m {
                        Some(Ok(Message::Text(t))) => {
                            let Ok(msg) = serde_json::from_str::<Value>(&t) else { continue };
                            if msg["op"] != 7 { continue; }
                            let id = msg["d"]["requestId"].as_str().unwrap_or("").to_string();
                            let Some(entry) = pending.lock().unwrap().remove(&id) else { continue };
                            let st = &msg["d"]["requestStatus"];
                            let r = if st["result"] == true { Ok(if msg["d"]["responseData"].is_object() { msg["d"]["responseData"].clone() } else { json!({}) }) } else {
                                let comment = st["comment"].as_str().filter(|c| !c.is_empty()).map(str::to_string).unwrap_or_else(|| format!("code {}", st["code"]));
                                Err(ObsError { message: format!("{}: {comment}", msg["d"]["requestType"].as_str().unwrap_or("")), code: st["code"].as_i64() })
                            };
                            let _ = entry.send(r);
                        }
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                        _ => {}
                    }
                }
            }
            for (_, e) in pending.lock().unwrap().drain() {
                let _ = e.send(Err(err("OBS connection closed")));
            }
        });
        self.tx = Some(tx);
        self.info = Some(info.clone());
        Ok(info)
    }

    /// request(requestType, requestData).
    pub async fn request(&mut self, t: &str, data: Value) -> Result<Value, ObsError> {
        let Some(tx) = self.tx.clone() else { return Err(err("Not connected to OBS")) };
        let id = self.next_id.to_string();
        self.next_id += 1;
        let (otx, orx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), otx);
        if tx.send(json!({ "op": 6, "d": { "requestType": t, "requestId": id, "requestData": data } }).to_string()).is_err() {
            return Err(err("Not connected to OBS"));
        }
        match tokio::time::timeout(self.timeout, orx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(err("OBS connection closed")),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(err(format!("{t}: OBS did not answer")))
            }
        }
    }

    pub fn close(&mut self) {
        self.tx = None;
    }
}

fn io_code(e: &tokio_tungstenite::tungstenite::Error) -> String {
    if let tokio_tungstenite::tungstenite::Error::Io(io) = e {
        if io.kind() == std::io::ErrorKind::ConnectionRefused {
            return "ECONNREFUSED".into();
        }
    }
    e.to_string()
}

fn close_err(code: Option<u16>) -> ObsError {
    match code {
        Some(4009) => err("OBS refused the password (Tools -> WebSocket Server Settings -> Show Connect Info)"),
        c => err(format!("OBS closed the connection ({})", c.unwrap_or(1005))),
    }
}

/// ensure(promise): RequestStatus 601 = ResourceAlreadyExists is fine.
fn ensure(r: Result<Value, ObsError>) -> Result<Value, ObsError> {
    match r {
        Err(e) if e.code == Some(601) => Ok(Value::Null),
        x => x,
    }
}

fn names_of(v: &Value, list: &str, key: &str) -> Vec<String> {
    v[list].as_array().into_iter().flatten().filter_map(|x| x[key].as_str().map(str::to_string)).collect()
}

pub struct Setup {
    pub controller_url: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub stations: u32,
    pub set_video: bool,
}

impl Setup {
    pub fn new(controller_url: &str) -> Self {
        Self { controller_url: controller_url.to_string(), width: 1280, height: 720, fps: 30, stations: STATION_COUNT, set_video: true }
    }
}

/// setupStageScenes(client, opts): idempotent.
pub async fn setup_stage_scenes(c: &mut ObsClient, o: &Setup) -> Result<Value, ObsError> {
    let mut log: Vec<String> = Vec::new();
    let version = c.request("GetVersion", json!({})).await?;
    let kinds: Vec<String> = c.request("GetSourceFilterKindList", json!({})).await?["sourceFilterKinds"].as_array().into_iter().flatten().filter_map(|k| k.as_str().map(str::to_string)).collect();
    if !kinds.iter().any(|k| k == "ndi_filter") {
        return Err(err("DistroAV is not installed in this OBS (no \"ndi_filter\" filter). Install DistroAV + the NDI runtime, then restart OBS."));
    }
    if o.set_video {
        c.request("SetVideoSettings", json!({ "baseWidth": o.width, "baseHeight": o.height, "outputWidth": o.width, "outputHeight": o.height, "fpsNumerator": o.fps, "fpsDenominator": 1 })).await?;
        log.push(format!("video {}x{} @ {}", o.width, o.height, o.fps));
    }
    let scenes = names_of(&c.request("GetSceneList", json!({})).await?, "scenes", "sceneName");
    let inputs = names_of(&c.request("GetInputList", json!({})).await?, "inputs", "inputName");
    let browser = |n: u32| json!({ "url": station_url(&o.controller_url, n), "width": o.width, "height": o.height, "fps_custom": true, "fps": o.fps, "reroute_audio": false, "shutdown": false, "restart_when_active": false, "css": "" });
    for n in 1..=o.stations {
        let nm = names(n);
        if !scenes.contains(&nm.scene) {
            ensure(c.request("CreateScene", json!({ "sceneName": nm.scene })).await)?;
            log.push(format!("scene {}", nm.scene));
        }
        if !inputs.contains(&nm.input) {
            ensure(c.request("CreateInput", json!({ "sceneName": nm.scene, "inputName": nm.input, "inputKind": "browser_source", "inputSettings": browser(n), "sceneItemEnabled": true })).await)?;
            log.push(format!("browser {}", nm.input));
        } else {
            c.request("SetInputSettings", json!({ "inputName": nm.input, "inputSettings": browser(n), "overlay": true })).await?;
        }
        let filters = names_of(&c.request("GetSourceFilterList", json!({ "sourceName": nm.scene })).await?, "filters", "filterName");
        let fs = json!({ "ndi_filter_ndiname": nm.ndi, "ndi_filter_ndigroups": "" });
        if !filters.contains(&nm.filter) {
            ensure(c.request("CreateSourceFilter", json!({ "sourceName": nm.scene, "filterName": nm.filter, "filterKind": "ndi_filter", "filterSettings": fs })).await)?;
            log.push(format!("ndi {}", nm.ndi));
        } else {
            c.request("SetSourceFilterSettings", json!({ "sourceName": nm.scene, "filterName": nm.filter, "filterSettings": fs, "overlay": true })).await?;
        }
        c.request("SetSourceFilterEnabled", json!({ "sourceName": nm.scene, "filterName": nm.filter, "filterEnabled": true })).await?;
    }
    if !scenes.contains(&ALL_SCENE.to_string()) {
        ensure(c.request("CreateScene", json!({ "sceneName": ALL_SCENE })).await)?;
        log.push(format!("scene {ALL_SCENE}"));
    }
    let items = names_of(&c.request("GetSceneItemList", json!({ "sceneName": ALL_SCENE })).await?, "sceneItems", "sourceName");
    for n in 1..=o.stations {
        if !items.contains(&names(n).scene) {
            ensure(c.request("CreateSceneItem", json!({ "sceneName": ALL_SCENE, "sourceName": names(n).scene, "sceneItemEnabled": true })).await)?;
        }
    }
    c.request("SetCurrentProgramScene", json!({ "sceneName": ALL_SCENE })).await?;
    Ok(json!({ "obsVersion": version["obsVersion"], "wsVersion": version["obsWebSocketVersion"], "log": log, "ndiNames": (1..=o.stations).map(|n| names(n).ndi).collect::<Vec<_>>() }))
}

/// stageStatus(client, stations).
pub async fn stage_status(c: &mut ObsClient, stations: u32) -> Result<Value, ObsError> {
    let stats = c.request("GetStats", json!({})).await?;
    let video = c.request("GetVideoSettings", json!({})).await?;
    let mut rows = Vec::new();
    for n in 1..=stations {
        let nm = names(n);
        let active = c.request("GetSourceActive", json!({ "sourceName": nm.scene })).await.ok().is_some_and(|v| isu_core::game_config::truthy(v.get("videoActive")));
        let ndi_on = c.request("GetSourceFilter", json!({ "sourceName": nm.scene, "filterName": nm.filter })).await.ok().is_some_and(|v| isu_core::game_config::truthy(v.get("filterEnabled")));
        rows.push(json!({ "station": n, "ndi": nm.ndi, "active": active, "ndiOn": ndi_on }));
    }
    let num = |v: &Value| isu_core::game_config::num_or_zero(Some(v));
    let r1 = |x: f64| isu_core::game_config::jnum(((x * 10.0) + 0.5).floor() / 10.0);
    Ok(json!({
        "fps": r1(num(&stats["activeFps"])),
        "targetFps": isu_core::game_config::jnum((((num(&video["fpsNumerator"]) / num(&video["fpsDenominator"])) * 100.0) + 0.5).floor() / 100.0),
        "resolution": format!("{}x{}", isu_core::game_config::js_string(Some(&video["outputWidth"])), isu_core::game_config::js_string(Some(&video["outputHeight"]))),
        "cpu": isu_core::game_config::jnum(isu_core::game_config::js_round(num(&stats["cpuUsage"]))),
        "renderMs": r1(num(&stats["averageFrameRenderTime"])),
        "skippedRender": isu_core::game_config::jnum(num(&stats["renderSkippedFrames"])),
        "skippedOutput": isu_core::game_config::jnum(num(&stats["outputSkippedFrames"])),
        "stations": rows
    }))
}
