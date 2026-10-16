//! Companion API (default port 3176): electron/companion-api-service.cjs CompanionApiService.
//! GET  /api/companion/health          (no key)
//! GET  /api/companion/variables | capabilities | state | events (SSE 'event: variables')
//! POST /api/companion/action          (JSON body, max 64 KB)
//! Key: X-ISU-API-Key header, 'Authorization: Bearer <key>', or ?token=<key> (timing-safe compare).
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use isu_core::variables::{build_companion_capabilities, build_companion_variables, build_stage_variables};
use serde_json::{Map, Value, json};
use subtle::ConstantTimeEq;
use tokio::sync::{mpsc, oneshot};

use crate::store::{Store, now_ms};

pub const DEFAULT_COMPANION_PORT: u16 = 3176;
const MAX_BODY_BYTES: usize = 64 * 1024;

/// createCompanionToken(): 24 random bytes as hex.
pub fn create_token() -> String {
    use rand::RngCore;
    let mut b = [0u8; 24];
    rand::rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
}

/// normalizeCompanionSettings(value).
pub fn normalize_settings(v: &Value) -> Settings {
    let port = v.get("port").and_then(Value::as_f64).filter(|p| *p == p.trunc() && (1024.0..=65535.0).contains(p)).map(|p| p as u16).unwrap_or(DEFAULT_COMPANION_PORT);
    let token = v.get("token").and_then(Value::as_str).map(str::trim).filter(|t| t.len() >= 16).map(str::to_string).unwrap_or_else(create_token);
    Settings { enabled: isu_core::game_config::truthy(v.get("enabled")), port, token }
}

/// An action for the app to run on the controller state. `reply` gets the JSON result or (status, message).
pub struct ActionRequest {
    pub body: Value,
    pub reply: oneshot::Sender<Result<Value, (u16, String)>>,
}

pub type StageStatus = Arc<dyn Fn() -> Value + Send + Sync>;

pub struct Companion {
    store: Arc<Store>,
    stage_status: StageStatus,
    actions: mpsc::UnboundedSender<ActionRequest>,
    settings: Mutex<Settings>,
    status: Mutex<Value>,
    clients: Mutex<Vec<(u64, mpsc::UnboundedSender<Arc<str>>)>>,
    next_id: std::sync::atomic::AtomicU64,
    publish_pending: std::sync::atomic::AtomicBool,
    last_payload: Mutex<String>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
}

impl Companion {
    pub fn new(store: Arc<Store>, stage_status: StageStatus, actions: mpsc::UnboundedSender<ActionRequest>) -> Arc<Self> {
        let s = normalize_settings(&json!({}));
        let me = Arc::new(Self {
            store,
            stage_status,
            actions,
            status: Mutex::new(json!({ "enabled": false, "listening": false, "port": s.port, "clients": 0, "error": "" })),
            settings: Mutex::new(s),
            clients: Mutex::new(Vec::new()),
            next_id: 1.into(),
            publish_pending: false.into(),
            last_payload: Mutex::new(String::new()),
            stop: Mutex::new(None),
        });
        let weak = Arc::downgrade(&me);
        me.store.on_publish(move |_| {
            if let Some(c) = weak.upgrade() {
                c.publish();
            }
        });
        me
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    /// getStatus(): { enabled, listening, port, clients, error }.
    pub fn status(&self) -> Value {
        let mut s = self.status.lock().unwrap().clone();
        s["clients"] = json!(self.clients.lock().unwrap().len());
        s
    }

    fn variables(&self, state: &Value) -> Map<String, Value> {
        let mut v = build_companion_variables(state);
        v.extend(build_stage_variables(&(self.stage_status)(), &self.store.state(), now_ms()));
        v
    }

    /// configure(value): restart when the port changes or it is turned off.
    pub async fn configure(self: &Arc<Self>, v: &Value) -> Value {
        let next = normalize_settings(v);
        let running = self.stop.lock().unwrap().is_some();
        let must_restart = running && (next.port != self.settings().port || !next.enabled);
        *self.settings.lock().unwrap() = next.clone();
        if must_restart {
            self.stop_server();
        }
        if next.enabled && self.stop.lock().unwrap().is_none() {
            self.start().await;
        }
        if !next.enabled {
            *self.status.lock().unwrap() = json!({ "enabled": false, "listening": false, "port": next.port, "clients": 0, "error": "" });
        }
        self.status()
    }

    async fn start(self: &Arc<Self>) {
        let port = self.settings().port;
        match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
            Ok(l) => {
                let (tx, rx) = oneshot::channel::<()>();
                *self.stop.lock().unwrap() = Some(tx);
                let router = Router::new().fallback(handle).with_state(Arc::clone(self));
                tokio::spawn(async move {
                    let _ = axum::serve(l, router).with_graceful_shutdown(async { let _ = rx.await; }).await;
                });
                *self.status.lock().unwrap() = json!({ "enabled": true, "listening": true, "port": port, "clients": 0, "error": "" });
            }
            Err(e) => {
                let msg = e.to_string();
                *self.status.lock().unwrap() = json!({ "enabled": true, "listening": false, "port": port, "clients": 0, "error": msg });
                self.store.record_diagnostic("companion-api-error", &msg);
            }
        }
    }

    fn stop_server(&self) {
        if let Some(s) = self.stop.lock().unwrap().take() {
            let _ = s.send(());
        }
        self.clients.lock().unwrap().clear();
        let s = self.settings();
        *self.status.lock().unwrap() = json!({ "enabled": s.enabled, "listening": false, "port": s.port, "clients": 0, "error": "" });
    }

    pub fn stop(&self) {
        self.stop_server();
    }

    /// publish(state): coalesced to one send per 33 ms; a client only gets a payload that changed.
    pub fn publish(self: &Arc<Self>) {
        if self.clients.lock().unwrap().is_empty() || self.publish_pending.swap(true, std::sync::atomic::Ordering::AcqRel) {
            return;
        }
        let me = Arc::clone(self);
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            self.publish_pending.store(false, std::sync::atomic::Ordering::Release);
            return;
        };
        rt.spawn(async move {
            tokio::time::sleep(Duration::from_millis(33)).await;
            me.publish_pending.store(false, std::sync::atomic::Ordering::Release);
            let vars = me.variables(&me.store.state());
            let payload = format!("event: variables\ndata: {}\n\n", Value::Object(vars));
            {
                let mut last = me.last_payload.lock().unwrap();
                if *last == payload {
                    return;
                }
                last.clone_from(&payload);
            }
            let p: Arc<str> = Arc::from(payload);
            me.clients.lock().unwrap().retain(|(_, tx)| tx.send(Arc::clone(&p)).is_ok());
        });
    }
}

fn send_json(status: StatusCode, v: &Value) -> Response {
    let mut r = (status, v.to_string()).into_response();
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    r
}

/// authorized(request, url, token).
fn authorized(req: &Request, token: &str) -> bool {
    let h = req.headers();
    let auth = h.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or("");
    let bearer = if auth.len() >= 7 && auth[..7].eq_ignore_ascii_case("bearer ") { auth[7..].trim() } else { "" };
    let query_token = req.uri().query().and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("token="))).map(|t| percent(t)).unwrap_or_default();
    let header_key = h.get("x-isu-api-key").and_then(|v| v.to_str().ok()).unwrap_or("");
    let supplied = if !header_key.is_empty() { header_key.to_string() } else if !bearer.is_empty() { bearer.to_string() } else { query_token };
    !token.is_empty() && supplied.len() == token.len() && bool::from(supplied.as_bytes().ct_eq(token.as_bytes()))
}

fn percent(s: &str) -> String {
    // URLSearchParams decoding: '+' is a space, %XX is a byte.
    let b = s.replace('+', " ").into_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = (b[i] == b'%').then(|| b.get(i + 1..i + 3)).flatten().and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok());
        match hex {
            Some(v) => {
                out.push(v);
                i += 3;
            }
            None => {
                out.push(b[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn handle(State(c): State<Arc<Companion>>, req: Request) -> Response {
    let path = req.uri().path().to_string();
    let method = req.method().clone();
    if method == Method::OPTIONS {
        let mut r = StatusCode::NO_CONTENT.into_response();
        let h = r.headers_mut();
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
        h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("Authorization, Content-Type, X-ISU-API-Key"));
        h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, OPTIONS"));
        return r;
    }
    if path == "/api/companion/health" && method == Method::GET {
        let mut v = json!({ "ok": true });
        for (k, x) in c.status().as_object().unwrap() {
            v[k] = x.clone();
        }
        v["apiVersion"] = json!(1);
        return send_json(StatusCode::OK, &v);
    }
    let ours = path.starts_with("/api/companion/");
    if !ours || !authorized(&req, &c.settings().token) {
        return if ours { send_json(StatusCode::UNAUTHORIZED, &json!({ "error": "Unauthorized" })) } else { send_json(StatusCode::NOT_FOUND, &json!({ "error": "Not found" })) };
    }
    let state = c.store.state();
    match (method.as_str(), path.as_str()) {
        ("GET", "/api/companion/variables") => send_json(StatusCode::OK, &Value::Object(c.variables(&state))),
        ("GET", "/api/companion/capabilities") => send_json(StatusCode::OK, &build_companion_capabilities(&state)),
        ("GET", "/api/companion/state") => send_json(StatusCode::OK, &state),
        ("GET", "/api/companion/events") => {
            let (tx, rx) = mpsc::unbounded_channel::<Arc<str>>();
            let first = format!("event: variables\ndata: {}\n\n", Value::Object(c.variables(&state)));
            let _ = tx.send(Arc::from(first));
            let id = c.next_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            c.clients.lock().unwrap().push((id, tx));
            let weak = Arc::downgrade(&c);
            struct Gone(std::sync::Weak<Companion>, u64);
            impl Drop for Gone {
                fn drop(&mut self) {
                    if let Some(c) = self.0.upgrade() {
                        c.clients.lock().unwrap().retain(|(i, _)| *i != self.1);
                    }
                }
            }
            let gone = Gone(weak, id);
            let stream = tokio_stream::wrappers::UnboundedReceiverStream::new(rx).map(move |p| {
                let _k = &gone;
                Ok::<_, std::io::Error>(p.to_string())
            });
            let mut r = Response::new(Body::from_stream(stream));
            let h = r.headers_mut();
            h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
            h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
            h.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
            h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
            r
        }
        ("POST", "/api/companion/action") => {
            let bytes = match to_bytes(req.into_body(), MAX_BODY_BYTES).await {
                Ok(b) => b,
                Err(_) => return send_json(StatusCode::PAYLOAD_TOO_LARGE, &json!({ "error": "Request body is too large" })),
            };
            let body: Value = if String::from_utf8_lossy(&bytes).trim().is_empty() {
                json!({})
            } else {
                match serde_json::from_slice(&bytes) {
                    Ok(v) => v,
                    Err(_) => return send_json(StatusCode::BAD_REQUEST, &json!({ "error": "Request body must be valid JSON" })),
                }
            };
            if !body.is_object() || !body.get("action").is_some_and(Value::is_string) {
                return send_json(StatusCode::BAD_REQUEST, &json!({ "error": "Provide a JSON object with an action field" }));
            }
            let (tx, rx) = oneshot::channel();
            if c.actions.send(ActionRequest { body, reply: tx }).is_err() {
                return send_json(StatusCode::SERVICE_UNAVAILABLE, &json!({ "error": "Controller window is not ready" }));
            }
            // main.cjs dispatchCompanionAction: 3 s for the controller to answer.
            match tokio::time::timeout(Duration::from_secs(3), rx).await {
                Ok(Ok(Ok(result))) => {
                    let mut out = json!({ "ok": true });
                    for (k, v) in result.as_object().cloned().unwrap_or_default() {
                        out[k] = v;
                    }
                    out["variables"] = Value::Object(c.variables(&c.store.state()));
                    send_json(StatusCode::OK, &out)
                }
                Ok(Ok(Err((status, msg)))) => send_json(StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST), &json!({ "error": if msg.is_empty() { "Action failed".to_string() } else { msg } })),
                _ => send_json(StatusCode::GATEWAY_TIMEOUT, &json!({ "error": "Controller did not acknowledge the action" })),
            }
        }
        _ => send_json(StatusCode::METHOD_NOT_ALLOWED, &json!({ "error": "Method not allowed or endpoint not found" })),
    }
}
