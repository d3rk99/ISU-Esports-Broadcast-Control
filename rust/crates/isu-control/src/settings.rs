//! Settings files in userData (electron/main.cjs): companion-api.json, rocket-league-connection.json
//! (+ the one-time rocket-league-connection.import.json next to the exe), spectate-receiver.json,
//! valorant-board-settings.json, overwatch-ocr-settings.json, display-key.json, obs-displays.json,
//! and the controller state (localStorage key isu-esports-control-state-v1 -> control-state.json).
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

pub const RL_CONNECTION_FIELDS: [&str; 9] = ["enabled", "source", "transport", "host", "tcpPort", "webPort", "bridgePort", "bridgeToken", "updateIntervalMs"];

#[derive(Clone)]
pub struct Files {
    pub dir: PathBuf,
}

impl Files {
    /// %APPDATA%\ISU Esports Broadcast Control (Electron userData of productName), or ISU_CONTROL_USER_DATA.
    pub fn default_dir() -> PathBuf {
        std::env::var_os("ISU_CONTROL_USER_DATA").map(PathBuf::from).unwrap_or_else(|| dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("ISU Esports Broadcast Control"))
    }

    pub fn new(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        Self { dir }
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    pub fn read(&self, name: &str) -> Option<Value> {
        std::fs::read_to_string(self.path(name)).ok().and_then(|s| serde_json::from_str(&s).ok())
    }

    /// JSON.stringify(value, null, 2), written through a temp file.
    pub fn write(&self, name: &str, v: &Value) {
        let p = self.path(name);
        let tmp = p.with_extension("json.tmp");
        if std::fs::write(&tmp, serde_json::to_string_pretty(v).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(tmp, p);
        }
    }

    // ---- controller state ----
    pub fn load_state(&self) -> Value {
        let raw = std::fs::read_to_string(self.path("control-state.json")).ok();
        isu_core::store::load_state(raw.as_deref())
    }

    pub fn save_state(&self, state: &Value) {
        let p = self.path("control-state.json");
        let tmp = p.with_extension("json.tmp");
        if std::fs::write(&tmp, state.to_string()).is_ok() {
            let _ = std::fs::rename(tmp, p);
        }
    }

    // ---- Companion ----
    /// readCompanionSettings(): normalized and written back (a token is created once).
    pub fn companion(&self) -> Value {
        let s = isu_server::companion::normalize_settings(&self.read("companion-api.json").unwrap_or(json!({ "enabled": false })));
        let v = json!({ "enabled": s.enabled, "port": s.port, "token": s.token });
        self.write("companion-api.json", &v);
        v
    }

    pub fn save_companion(&self, v: &Value) -> Value {
        let s = isu_server::companion::normalize_settings(v);
        let v = json!({ "enabled": s.enabled, "port": s.port, "token": s.token });
        self.write("companion-api.json", &v);
        v
    }

    // ---- Rocket League connection ----
    fn sanitize(saved: &Value) -> Option<Value> {
        let o = saved.as_object()?;
        Some(Value::Object(RL_CONNECTION_FIELDS.iter().filter_map(|f| o.get(*f).map(|v| (f.to_string(), v.clone()))).collect()))
    }

    /// readRocketLeagueConnection(exe_dir): the import file next to the exe wins once.
    pub fn rl_connection(&self, exe_dir: &Path) -> Option<Value> {
        let rec = exe_dir.join("rocket-league-connection.import.json");
        if let Some(imp) = std::fs::read_to_string(&rec).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).and_then(|v| Self::sanitize(&v)) {
            self.save_rl_connection(&imp);
            let _ = std::fs::remove_file(rec);
            return Some(imp);
        }
        self.read("rocket-league-connection.json").and_then(|v| Self::sanitize(&v))
    }

    /// saveRocketLeagueConnection(settings): enabled = savedEnabled when given.
    pub fn save_rl_connection(&self, s: &Value) {
        let Some(o) = s.as_object() else { return };
        let mut out = Map::new();
        for f in RL_CONNECTION_FIELDS {
            if let Some(v) = o.get(f) {
                let v = if f == "enabled" && o.contains_key("savedEnabled") { json!(isu_core::game_config::truthy(o.get("savedEnabled"))) } else { v.clone() };
                out.insert(f.into(), v);
            }
        }
        self.write("rocket-league-connection.json", &Value::Object(out));
    }

    // ---- merged settings files (read + normalize, save = merge + normalize) ----
    pub fn merged(&self, name: &str, normalize: impl Fn(&Value) -> Value) -> Value {
        normalize(&self.read(name).unwrap_or(json!({})))
    }

    pub fn save_merged(&self, name: &str, next: &Value, normalize: impl Fn(&Value) -> Value) -> Value {
        let mut cur = self.merged(name, &normalize);
        for (k, v) in next.as_object().cloned().unwrap_or_default() {
            cur[k] = v;
        }
        let saved = normalize(&cur);
        self.write(name, &saved);
        saved
    }

    // ---- display key ----
    pub fn display_key(&self) -> String {
        self.read("display-key.json").and_then(|v| v.get("key").and_then(Value::as_str).map(|s| s.trim().to_string())).unwrap_or_default()
    }

    pub fn save_display_key(&self, key: &str) {
        self.write("display-key.json", &json!({ "key": key.trim() }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rl_connection_keeps_only_fields_and_saved_enabled() {
        let d = std::env::temp_dir().join(format!("isu-files-{}", std::process::id()));
        let f = Files::new(d.clone());
        f.save_rl_connection(&json!({ "enabled": false, "savedEnabled": true, "host": "1.2.3.4", "live": { "x": 1 }, "bridgeToken": "k" }));
        assert_eq!(f.read("rocket-league-connection.json").unwrap(), json!({ "enabled": true, "host": "1.2.3.4", "bridgeToken": "k" }));
        let exe = d.join("exe");
        std::fs::create_dir_all(&exe).unwrap();
        std::fs::write(exe.join("rocket-league-connection.import.json"), r#"{"host":"9.9.9.9","junk":1}"#).unwrap();
        assert_eq!(f.rl_connection(&exe).unwrap(), json!({ "host": "9.9.9.9" }));
        assert!(!exe.join("rocket-league-connection.import.json").exists());
        assert_eq!(f.rl_connection(&exe).unwrap(), json!({ "host": "9.9.9.9" }));
        let c = f.companion();
        assert_eq!(c["enabled"], false);
        assert_eq!(f.companion()["token"], c["token"], "token kept");
        let _ = std::fs::remove_dir_all(d);
    }
}
