//! Game PC <-> Graphics PC link helpers: electron/bridge-link.cjs (bridgeKeyMatches, keepAlive,
//! BRIDGE_MAX_PAYLOAD) + the WebSocket accept / serve loops every receiver uses.
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use subtle::ConstantTimeEq;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};

pub const BRIDGE_PING_INTERVAL_MS: u64 = 5000;
pub const BRIDGE_MAX_PAYLOAD: usize = 8 * 1024 * 1024;

pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// bridgeKeyMatches(expected, provided): non-empty, same length, timing-safe.
pub fn key_matches(expected: &str, provided: &str) -> bool {
    !expected.is_empty() && expected.len() == provided.len() && bool::from(expected.as_bytes().ct_eq(provided.as_bytes()))
}

/// ?token= of a request path, URL-decoded like URLSearchParams.
pub fn query_param(path_and_query: &str, key: &str) -> Option<String> {
    let q = path_and_query.split_once('?')?.1;
    url::form_urlencoded::parse(q.as_bytes()).find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
}

pub fn ws_config() -> WebSocketConfig {
    let mut c = WebSocketConfig::default();
    c.max_message_size = Some(BRIDGE_MAX_PAYLOAD);
    c.max_frame_size = Some(BRIDGE_MAX_PAYLOAD);
    c
}

/// Accept a WebSocket; a wrong key closes it with 1008 'Invalid bridge key' (JS client.close(1008, ...)).
pub async fn accept_with_key(tcp: TcpStream, token: &str) -> Option<WebSocketStream<TcpStream>> {
    let mut path = String::new();
    let cb = |req: &Request, resp: Response| {
        path = req.uri().to_string();
        Ok(resp)
    };
    let mut ws = tokio_tungstenite::accept_hdr_async_with_config(tcp, cb, Some(ws_config())).await.ok()?;
    let given = query_param(&path, "token").unwrap_or_default();
    if !key_matches(token, &given) {
        let _ = ws.close(Some(CloseFrame { code: CloseCode::Policy, reason: "Invalid bridge key".into() })).await;
        return None;
    }
    Some(ws)
}

/// Reads text messages until the socket closes, with keepAlive: ping every 5 s, a link with no
/// pong since the previous ping is dropped. `outbox` (optional) = messages to send.
pub async fn serve_keepalive<S>(ws: WebSocketStream<S>, mut on_text: impl FnMut(&str), outbox: Option<mpsc::UnboundedReceiver<String>>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut tx, mut rx) = ws.split();
    let mut ping = tokio::time::interval(Duration::from_millis(BRIDGE_PING_INTERVAL_MS));
    ping.tick().await;
    let mut alive = true;
    let mut outbox = outbox;
    loop {
        tokio::select! {
            m = rx.next() => match m {
                Some(Ok(Message::Text(t))) => on_text(&t),
                Some(Ok(Message::Pong(_))) => alive = true,
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
            _ = ping.tick() => {
                if !alive { break; }
                alive = false;
                if tx.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
            }
            out = async { match outbox.as_mut() { Some(o) => o.recv().await, None => std::future::pending().await } } => {
                match out { Some(text) => { if tx.send(Message::Text(text.into())).await.is_err() { break; } } None => outbox = None }
            }
        }
    }
}
