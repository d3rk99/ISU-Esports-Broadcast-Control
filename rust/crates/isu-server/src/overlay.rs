//! Overlay server on 0.0.0.0:3174: electron/main.cjs startOverlayServer.
//! GET only. /api/state, /api/health, /events (SSE), /ws (WebSocket), /user-assets/*,
//! /rl-loadout-assets/* (folder or zip pack), /assets/* /overlays/* /displays/* /shared/* from the
//! static root. Every response: Cache-Control no-store + Access-Control-Allow-Origin *.
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::Router;
use futures_util::StreamExt;
use serde_json::{Value, json};

use crate::hub::{HEARTBEAT_MS, Msg, Viewer};
use crate::store::Store;

pub const OVERLAY_PORT: u16 = 3174;

/// main.cjs MIME_TYPES (anything else: application/octet-stream).
pub fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("css") => "text/css; charset=utf-8",
        Some("glb") => "model/gltf-binary",
        Some("html") => "text/html; charset=utf-8",
        Some("jpeg" | "jpg") => "image/jpeg",
        Some("js") => "text/javascript; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("png") => "image/png",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
}

#[derive(Clone)]
pub struct Config {
    /// dev: <repo>/public, packaged: <app>/dist (main.cjs staticRoot)
    pub static_root: PathBuf,
    /// userData/broadcast-assets
    pub asset_root: PathBuf,
    /// Rocket League loadout pack: (kind, path) with kind "directory" | "zip"
    pub rl_pack: Option<(String, PathBuf)>,
    /// /api/health rocketLeagueBackup (readRocketLeagueConnection summary), computed by the app.
    pub rl_backup: Arc<dyn Fn() -> Value + Send + Sync>,
}

#[derive(Clone)]
struct App {
    store: Arc<Store>,
    cfg: Config,
}

fn json_response(status: StatusCode, v: &Value) -> Response {
    let mut r = (status, v.to_string()).into_response();
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    r
}

fn not_found() -> Response {
    json_response(StatusCode::NOT_FOUND, &json!({ "error": "Not found" }))
}

/// safeFilePath(root, requestPath): decodeURIComponent, resolve inside root, refuse escapes.
pub fn safe_file_path(root: &Path, request_path: &str) -> Option<PathBuf> {
    let decoded = percent_decode(request_path)?;
    let mut out = root.to_path_buf();
    for c in Path::new(&decoded).components() {
        match c {
            Component::Normal(p) => out.push(p),
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() || !out.starts_with(root) {
                    return None;
                }
            }
            Component::Prefix(_) => return None,
        }
    }
    // JS: resolvedFile.startsWith(root + sep) -> the root itself is refused.
    (out.starts_with(root) && out != root).then_some(out)
}

/// decodeURIComponent; malformed sequences fail like JS (URIError -> treated as not found).
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

async fn serve_file(path: Option<PathBuf>) -> Response {
    let Some(path) = path else { return not_found() };
    match tokio::fs::metadata(&path).await {
        Ok(m) if m.is_file() => {}
        _ => return not_found(),
    }
    let Ok(file) = tokio::fs::File::open(&path).await else { return not_found() };
    let stream = tokio_util_stream(file);
    let mut r = Response::new(Body::from_stream(stream));
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime(&path)));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    r
}

/// File -> byte stream (64 KB chunks), streamed like fs.createReadStream.
fn tokio_util_stream(mut file: tokio::fs::File) -> impl futures_util::Stream<Item = std::io::Result<Vec<u8>>> {
    use tokio::io::AsyncReadExt;
    async_stream_lite(move |tx| async move {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match file.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(Ok(buf[..n].to_vec())).await.is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(e)).await;
                    break;
                }
            }
        }
    })
}

/// Minimal channel-backed stream builder (avoids an extra dependency).
fn async_stream_lite<T, F, Fut>(f: F) -> impl futures_util::Stream<Item = T>
where
    T: Send + 'static,
    F: FnOnce(tokio::sync::mpsc::Sender<T>) -> Fut,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let (tx, rx) = tokio::sync::mpsc::channel(4);
    tokio::spawn(f(tx));
    tokio_stream::wrappers::ReceiverStream::new(rx)
}

/// SSE viewer: 'retry: 1000\ndata: <state>\n\n' then 'data: <json>\n\n' / ': ping\n\n'.
fn sse(app: &App) -> Response {
    let initial: Arc<str> = Arc::from(app.store.with_spectated().to_string());
    let viewer = app.store.hub.add(initial);
    let hub = Arc::clone(&app.store.hub);
    let id = viewer.id;
    let mut first = true;
    let Viewer { rx, pending, .. } = viewer;
    let stream = tokio_stream::wrappers::UnboundedReceiverStream::new(rx).map(move |m| {
        let chunk = match m {
            Msg::State(j) => {
                let n = j.len();
                let _ = pending.fetch_update(std::sync::atomic::Ordering::Relaxed, std::sync::atomic::Ordering::Relaxed, |v| Some(v.saturating_sub(n)));
                if std::mem::take(&mut first) { format!("retry: 1000\ndata: {j}\n\n") } else { format!("data: {j}\n\n") }
            }
            Msg::Heartbeat => ": ping\n\n".to_string(),
        };
        Ok::<_, std::io::Error>(chunk)
    });
    let guard = DropGuard(Some(Box::new(move || hub.remove(id))));
    let stream = stream.map(move |c| {
        let _keep = &guard;
        c
    });
    let mut r = Response::new(Body::from_stream(stream));
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    h.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    r
}

struct DropGuard(Option<Box<dyn FnOnce() + Send + Sync>>);
impl Drop for DropGuard {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            f();
        }
    }
}

/// WebSocket viewer (pages only listen; max payload 4096 like the JS WebSocketServer).
async fn ws_viewer(app: App, mut socket: WebSocket) {
    let initial: Arc<str> = Arc::from(app.store.with_spectated().to_string());
    let mut viewer = app.store.hub.add(initial);
    loop {
        tokio::select! {
            m = viewer.rx.recv() => {
                let Some(m) = m else { break };   // dropped for being too far behind
                let r = match m {
                    Msg::State(j) => { let n = j.len(); let r = socket.send(Message::Text(j.to_string().into())).await; viewer.sent(n); r }
                    Msg::Heartbeat => socket.send(Message::Ping(Vec::new().into())).await,
                };
                if r.is_err() { break; }
            }
            incoming = socket.recv() => {
                match incoming { Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break, _ => {} }
            }
        }
    }
    app.store.hub.remove(viewer.id);
}

/// /ws: only a WebSocket upgrade (the JS destroys any other request on the upgrade path;
/// a plain GET /ws there falls through to 404 Not found).
async fn ws_route(State(app): State<App>, req: Request) -> Response {
    use axum::extract::FromRequest;
    if url_pathname(req.uri().path()) != "/ws" {
        return handle(State(app), req).await;
    }
    let is_upgrade = req.headers().get(header::UPGRADE).is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"));
    if !is_upgrade {
        return if req.method() == Method::GET { not_found() } else { json_response(StatusCode::METHOD_NOT_ALLOWED, &json!({ "error": "Method not allowed" })) };
    }
    match WebSocketUpgrade::from_request(req, &()).await {
        Ok(ws) => ws.max_message_size(4096).on_upgrade(move |s| ws_viewer(app, s)),
        Err(e) => e.into_response(),
    }
}

/// What `new URL(request.url, base).pathname` gives (WHATWG URL): dot segments removed, where
/// '.', '%2e', '..', '.%2e', '%2e.', '%2e%2e' (any case) count as dot segments. Routing uses this,
/// so '/overlays/../secret.txt' is '/secret.txt' (404), exactly like main.cjs.
pub fn url_pathname(raw: &str) -> String {
    let is_dot = |s: &str| s == "." || s.eq_ignore_ascii_case("%2e");
    let is_dotdot = |s: &str| matches!(s.to_ascii_lowercase().as_str(), ".." | ".%2e" | "%2e." | "%2e%2e");
    let parts: Vec<&str> = raw.split('/').skip(1).collect();
    let mut out: Vec<&str> = Vec::new();
    for (i, seg) in parts.iter().enumerate() {
        let last = i + 1 == parts.len();
        if is_dotdot(seg) {
            out.pop();
            if last {
                out.push("");
            }
        } else if is_dot(seg) {
            if last {
                out.push("");
            }
        } else {
            out.push(seg);
        }
    }
    format!("/{}", out.join("/"))
}

async fn handle(State(app): State<App>, req: Request) -> Response {
    let path = url_pathname(req.uri().path());
    if req.method() != Method::GET {
        return json_response(StatusCode::METHOD_NOT_ALLOWED, &json!({ "error": "Method not allowed" }));
    }
    if path == "/api/state" {
        return json_response(StatusCode::OK, &app.store.with_spectated());
    }
    if path == "/api/health" {
        let diagnostics = Value::Array(app.store.lock().diagnostics.clone());
        return json_response(StatusCode::OK, &json!({
            "ok": true, "port": OVERLAY_PORT, "clients": app.store.hub.size(),
            "rocketLeagueBackup": (app.cfg.rl_backup)(), "diagnostics": diagnostics
        }));
    }
    if path == "/events" {
        return sse(&app);
    }
    if let Some(rest) = path.strip_prefix("/user-assets") {
        if rest.starts_with('/') {
            return serve_file(safe_file_path(&app.cfg.asset_root, rest)).await;
        }
    }
    if let Some(rest) = path.strip_prefix("/rl-loadout-assets/") {
        return crate_rl::serve(&app.cfg, rest).await;
    }
    for p in ["/assets/", "/overlays/", "/displays/", "/shared/"] {
        if path.starts_with(p) {
            return serve_file(safe_file_path(&app.cfg.static_root, &path)).await;
        }
    }
    not_found()
}

mod crate_rl {
    //! serveRocketLeagueLoadoutAsset: a folder pack is served as files, a zip pack is streamed
    //! with `tar -xOf <zip> rl-loadout-assets/<path>` (same command the JS uses; Windows 10+ tar
    //! reads zip). Only paths inside the pack are served.
    use super::*;
    pub async fn serve(cfg: &Config, rest: &str) -> Response {
        let rel = rest.replace('\\', "/");
        let bad = rel.is_empty() || rel.split('/').any(|s| s == ".." || s.is_empty()) || percent_decode(&rel).is_none();
        let Some((kind, root)) = cfg.rl_pack.as_ref().filter(|_| !bad) else {
            return json_response(StatusCode::NOT_FOUND, &json!({ "error": "Rocket League loadout asset not found" }));
        };
        let rel = percent_decode(&rel).unwrap();
        if kind == "directory" {
            return serve_file(safe_file_path(root, &format!("/{rel}"))).await;
        }
        let out = tokio::process::Command::new("tar").arg("-xOf").arg(root).arg(format!("rl-loadout-assets/{rel}")).output().await;
        match out {
            Ok(o) if o.status.success() => {
                let mut r = Response::new(Body::from(o.stdout));
                let h = r.headers_mut();
                h.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime(Path::new(&rel))));
                h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
                h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
                r
            }
            Ok(_) => json_response(StatusCode::NOT_FOUND, &json!({ "error": "Rocket League loadout asset not found" })),
            Err(e) => json_response(StatusCode::INTERNAL_SERVER_ERROR, &json!({ "error": e.to_string() })),
        }
    }
}

pub fn router(store: Arc<Store>, cfg: Config) -> Router {
    let app = App { store, cfg };
    Router::new().route("/ws", axum::routing::any(ws_route)).fallback(handle).with_state(app)
}

/// Start listening on 0.0.0.0:port and the 15 s heartbeat. Returns the bound address.
pub async fn start(store: Arc<Store>, cfg: Config, port: u16) -> anyhow::Result<std::net::SocketAddr> {
    std::fs::create_dir_all(&cfg.asset_root).ok();
    store.hub.spawn_heartbeat(Duration::from_millis(HEARTBEAT_MS));
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    let addr = listener.local_addr()?;
    let router = router(store, cfg);
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok(addr)
}
