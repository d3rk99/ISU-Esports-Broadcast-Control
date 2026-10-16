//! Shared main-process state: electron/main.cjs broadcastState, spectatedPlayer,
//! runtimeDiagnostics, and publishBroadcastState / withSpectated / publishSpectated.
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::hub::Hub;

pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// ISO time like JS new Date().toISOString().
pub fn iso_now() -> String {
    let ms = now_ms() as i64;
    let (secs, msec) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    // civil from days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{msec:03}Z", tod / 3600, tod % 3600 / 60, tod % 60)
}

#[derive(Debug, Clone, Default)]
pub struct Spectated {
    pub name: String,
    pub station: Option<f64>,
    pub side: String,
    pub team: String,
    pub received_at: f64,
}

pub struct Inner {
    pub state: Value,
    pub spectated: Spectated,
    pub diagnostics: Vec<Value>,
}

/// One per app: the state, the overlay hub and listeners (Companion publish).
pub struct Store {
    inner: Mutex<Inner>,
    pub hub: Arc<Hub>,
    listeners: Mutex<Vec<Box<dyn Fn(&Value) + Send + Sync>>>,
}

impl Store {
    pub fn new() -> Arc<Self> {
        let weak: Arc<Mutex<Option<std::sync::Weak<Store>>>> = Arc::new(Mutex::new(None));
        let w2 = Arc::clone(&weak);
        let hub = Hub::new(crate::hub::MAX_BUFFERED_BYTES, move |_n, buffered| {
            if let Some(s) = w2.lock().unwrap().as_ref().and_then(std::sync::Weak::upgrade) {
                s.record_diagnostic("overlay-client-dropped", &format!("Dropped a stalled overlay viewer with {} KB unsent; it will reconnect", (buffered as f64 / 1024.0).round()));
            }
        });
        let me = Arc::new(Self { inner: Mutex::new(Inner { state: json!({}), spectated: Spectated::default(), diagnostics: Vec::new() }), hub, listeners: Mutex::new(Vec::new()) });
        *weak.lock().unwrap() = Some(Arc::downgrade(&me));
        me
    }

    pub fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn state(&self) -> Value {
        self.lock().state.clone()
    }

    /// recordDiagnostic(type, details): last 20 kept.
    pub fn record_diagnostic(&self, kind: &str, details: &str) {
        let mut g = self.lock();
        g.diagnostics.push(json!({ "at": iso_now(), "type": kind, "details": details }));
        if g.diagnostics.len() > 20 {
            g.diagnostics.remove(0);
        }
    }

    pub fn on_publish(&self, f: impl Fn(&Value) + Send + Sync + 'static) {
        self.listeners.lock().unwrap().push(Box::new(f));
    }

    /// withSpectated(state): adds `spectated` ({ name, station, side, team } fresh < 10 s, else null).
    pub fn with_spectated(&self) -> Value {
        let g = self.lock();
        let mut s = g.state.clone();
        if !s.is_object() {
            s = json!({});
        }
        let sp = &g.spectated;
        let fresh = !sp.name.is_empty() && now_ms() - sp.received_at < 10_000.0;
        s["spectated"] = if fresh {
            json!({ "name": sp.name, "station": sp.station.filter(|x| *x != 0.0).map_or(Value::Null, isu_core::game_config::jnum), "side": sp.side, "team": sp.team })
        } else {
            Value::Null
        };
        s
    }

    /// publishBroadcastState(nextState): non-objects are ignored.
    pub fn publish(&self, next: Value) {
        if !next.is_object() {
            return;
        }
        self.lock().state = next;
        self.publish_spectated();
        let state = self.state();
        for l in self.listeners.lock().unwrap().iter() {
            l(&state);
        }
    }

    /// publishSpectated(): overlays get the state again (the spectated name changes on its own).
    pub fn publish_spectated(&self) {
        let json: Arc<str> = Arc::from(self.with_spectated().to_string());
        self.hub.publish(json);
    }

    pub fn set_spectated(&self, sp: Spectated) {
        self.lock().spectated = sp;
        if self.lock().state.as_object().is_some_and(|o| !o.is_empty()) {
            self.publish_spectated();
        }
    }
}
