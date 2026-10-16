//! Live-state hub for OBS overlays: electron/overlay-events.cjs (OverlayEventHub).
//! SSE (/events) and WebSocket (/ws) viewers get every published state. Same rules as the JS:
//! - backpressure: a viewer more than MAX_BUFFERED_BYTES behind is dropped (it reconnects and
//!   gets a fresh state), so a stalled OBS source never makes the controller buffer forever;
//! - heartbeat every HEARTBEAT_MS: an SSE comment ': ping', a WebSocket ping;
//! - SSE starts with 'retry: 1000' + the current state.
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

use tokio::sync::{mpsc, watch};

pub const MAX_BUFFERED_BYTES: usize = 1024 * 1024; // overlay-events.cjs MAX_BUFFERED_BYTES
pub const HEARTBEAT_MS: u64 = 15_000; // overlay-events.cjs HEARTBEAT_MS

/// One message for a viewer.
#[derive(Debug, Clone)]
pub enum Msg {
    /// A full state as JSON text.
    State(Arc<str>),
    Heartbeat,
}

/// A viewer's outbox: a channel plus a running count of unsent bytes (the JS writableLength /
/// bufferedAmount check).
pub struct Viewer {
    pub rx: mpsc::UnboundedReceiver<Msg>,
    pub pending: Arc<AtomicUsize>,
    pub id: u64,
}

struct Slot {
    id: u64,
    tx: mpsc::UnboundedSender<Msg>,
    pending: Arc<AtomicUsize>,
}

pub struct Hub {
    slots: parking::Mutex<Vec<Slot>>,
    next_id: AtomicU64,
    pub dropped: AtomicU64,
    max_buffered: usize,
    /// Fires (drop count, unsent bytes) when a stalled viewer is dropped (main.cjs recordDiagnostic).
    on_drop: Box<dyn Fn(u64, usize) + Send + Sync>,
    _beat: watch::Sender<()>,
}

/// Tiny std mutex wrapper (no poisoning surprises).
mod parking {
    pub struct Mutex<T>(std::sync::Mutex<T>);
    impl<T> Mutex<T> {
        pub fn new(v: T) -> Self {
            Self(std::sync::Mutex::new(v))
        }
        pub fn lock(&self) -> std::sync::MutexGuard<'_, T> {
            self.0.lock().unwrap_or_else(|e| e.into_inner())
        }
    }
}

impl Hub {
    pub fn new(max_buffered: usize, on_drop: impl Fn(u64, usize) + Send + Sync + 'static) -> Arc<Self> {
        let (beat, _) = watch::channel(());
        Arc::new(Self { slots: parking::Mutex::new(Vec::new()), next_id: AtomicU64::new(1), dropped: AtomicU64::new(0), max_buffered, on_drop: Box::new(on_drop), _beat: beat })
    }

    /// Number of viewers (overlay-events.cjs `size`).
    pub fn size(&self) -> usize {
        self.slots.lock().len()
    }

    /// Add a viewer and queue the initial state (JS add/addSocket).
    pub fn add(&self, initial: Arc<str>) -> Viewer {
        let (tx, rx) = mpsc::unbounded_channel();
        let pending = Arc::new(AtomicUsize::new(initial.len()));
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let _ = tx.send(Msg::State(initial));
        self.slots.lock().push(Slot { id, tx, pending: Arc::clone(&pending) });
        Viewer { rx, pending, id }
    }

    pub fn remove(&self, id: u64) {
        self.slots.lock().retain(|s| s.id != id);
    }

    /// publish(state): every viewer gets the JSON; viewers too far behind are dropped.
    pub fn publish(&self, json: Arc<str>) {
        let mut slots = self.slots.lock();
        slots.retain(|s| {
            let behind = s.pending.load(Ordering::Relaxed);
            if behind > self.max_buffered {
                let n = self.dropped.fetch_add(1, Ordering::Relaxed) + 1;
                (self.on_drop)(n, behind);
                return false; // dropping the sender ends that viewer's stream
            }
            s.pending.fetch_add(json.len(), Ordering::Relaxed);
            s.tx.send(Msg::State(Arc::clone(&json))).is_ok()
        });
    }

    pub fn heartbeat(&self) {
        self.slots.lock().retain(|s| s.tx.send(Msg::Heartbeat).is_ok());
    }

    /// ensureHeartbeat: one task, every HEARTBEAT_MS.
    pub fn spawn_heartbeat(self: &Arc<Self>, every: Duration) {
        let me = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut t = tokio::time::interval(every);
            t.tick().await;
            loop {
                t.tick().await;
                let Some(h) = me.upgrade() else { break };
                h.heartbeat();
            }
        });
    }
}

/// pending -= n, never below 0. A plain CAS loop: fetch_update is deprecated in Rust 1.99 and
/// its replacement try_update does not exist before 1.99 (Derk's PC has 1.99, the test box 1.98).
pub fn release_pending(pending: &AtomicUsize, n: usize) {
    let mut cur = pending.load(Ordering::Relaxed);
    loop {
        match pending.compare_exchange_weak(cur, cur.saturating_sub(n), Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return,
            Err(now) => cur = now,
        }
    }
}

impl Viewer {
    /// Mark `n` bytes as actually written to the socket.
    pub fn sent(&self, n: usize) {
        release_pending(&self.pending, n);
    }
}
