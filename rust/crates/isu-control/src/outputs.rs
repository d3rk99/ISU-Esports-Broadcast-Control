//! Output windows (electron/main.cjs): overlay-output-displays.json settings, program fill + key
//! windows that stay open while the overlay changes, single outputs, the VALORANT game alignment
//! overlay (toggle), previews. The windows live in the isu-outputs helper process (system webview).
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use crate::settings::Files;

pub const PROGRAM_OUTPUTS: [&str; 4] = ["scoreboard", "map-pool", "roster", "clean"];

/// normalizeOutputDisplaySettings(settings).
pub fn normalize(v: &Value) -> Value {
    let id = |k: &str| match v.get(k) { None | Some(Value::Null) => String::new(), Some(x) => isu_core::game_config::js_string(Some(x)) };
    let res = if isu_core::game_config::js_string(v.get("gameOverlayResolution")) == "1440" { "1440" } else { "1080" };
    json!({ "fillDisplayId": id("fillDisplayId"), "keyDisplayId": id("keyDisplayId"), "gameOverlayDisplayId": id("gameOverlayDisplayId"), "gameOverlayResolution": res, "autoOpenProgramOutput": v.get("autoOpenProgramOutput") != Some(&json!(false)) })
}

/// overlayOutputSize(query).
pub fn size(query: &Value) -> (u32, u32) {
    if query["setup"] == "game" && query["resolution"] == "1440" {
        return (2560, 1440);
    }
    if query["output"] == "pair" { (3840, 1080) } else { (1920, 1080) }
}

struct Helper {
    child: Child,
    stdin: ChildStdin,
    replies: Arc<Mutex<Vec<Value>>>,
}

pub struct Outputs {
    files: Files,
    helper: Mutex<Option<Helper>>,
    pub program: Mutex<String>,
    game_setup_open: Mutex<bool>,
    pub monitors: Mutex<Vec<Value>>,
}

impl Outputs {
    pub fn new(files: Files) -> Arc<Self> {
        Arc::new(Self { files, helper: Mutex::new(None), program: Mutex::new("scoreboard".into()), game_setup_open: Mutex::new(false), monitors: Mutex::new(Vec::new()) })
    }

    /// readOutputDisplaySettings(): normalized and written back.
    pub fn settings(&self) -> Value {
        let v = normalize(&self.files.read("overlay-output-displays.json").unwrap_or(json!({})));
        self.files.write("overlay-output-displays.json", &v);
        v
    }

    pub fn save_settings(&self, v: &Value) -> Value {
        let s = normalize(v);
        self.files.write("overlay-output-displays.json", &s);
        s
    }

    fn helper_path() -> std::path::PathBuf {
        let exe = std::env::current_exe().unwrap_or_default();
        let name = if cfg!(windows) { "isu-outputs.exe" } else { "isu-outputs" };
        let mut p = exe.with_file_name(name);
        if !p.exists() {
            // tests run from target/debug/deps
            if let Some(parent) = exe.parent().and_then(|d| d.parent()) {
                p = parent.join(name);
            }
        }
        p
    }

    /// Sends one command; starts the helper when needed. Waits up to `wait_ms` for a reply with this id.
    fn send(&self, cmd: Value, wait_ms: u64) -> Option<Value> {
        let mut g = self.helper.lock().unwrap();
        if g.as_mut().is_none_or(|h| h.child.try_wait().ok().flatten().is_some()) {
            let mut child = Command::new(Self::helper_path()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
            let stdin = child.stdin.take()?;
            let out = child.stdout.take()?;
            let replies: Arc<Mutex<Vec<Value>>> = Arc::default();
            let r2 = Arc::clone(&replies);
            std::thread::spawn(move || {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    if let Ok(v) = serde_json::from_str::<Value>(&line) {
                        r2.lock().unwrap().push(v);
                    }
                }
            });
            *g = Some(Helper { child, stdin, replies });
        }
        let h = g.as_mut()?;
        let want = cmd.get("cmd").and_then(Value::as_str).unwrap_or("").to_string();
        let id = cmd.get("id").cloned();
        h.replies.lock().unwrap().clear();
        writeln!(h.stdin, "{cmd}").ok()?;
        h.stdin.flush().ok()?;
        let replies = Arc::clone(&h.replies);
        drop(g);
        let t = std::time::Instant::now();
        while t.elapsed().as_millis() < u128::from(wait_ms) {
            if let Some(r) = replies.lock().unwrap().iter().find(|r| if want == "monitors" { r.get("monitors").is_some() } else { r.get("id") == id.as_ref() && r.get("ok").is_some() }).cloned() {
                return Some(r);
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        None
    }

    /// availableOutputDisplays().
    pub fn displays(&self) -> Vec<Value> {
        let m = self.send(json!({ "cmd": "monitors" }), 3000).and_then(|r| r["monitors"].as_array().cloned()).unwrap_or_default();
        *self.monitors.lock().unwrap() = m.clone();
        m
    }

    fn open_window(&self, id: &str, url: &str, monitor: &str, fallback: usize, query: &Value, title: &str) -> bool {
        let (w, h) = size(query);
        let game = query["setup"] == "game";
        self.send(json!({ "cmd": "open", "id": id, "url": url, "monitor": monitor, "fallback": fallback, "width": w, "height": h, "fullscreen": true, "transparent": game, "onTop": game, "clickThrough": game, "title": title }), 8000).is_some_and(|r| r["ok"] == true)
    }

    /// openProgramOutput(name): fill + key program windows on their screens, then the overlay.
    pub fn open_program(&self, name: &str) -> bool {
        if !PROGRAM_OUTPUTS.contains(&name) {
            return false;
        }
        let s = self.settings();
        let fill = crate::ui::overlay_url("program", &[("output", "fill")]).unwrap();
        let key = crate::ui::overlay_url("program", &[("output", "key")]).unwrap();
        let a = self.open_window("program-fill", &fill, s["fillDisplayId"].as_str().unwrap_or(""), 0, &json!({ "output": "fill" }), "program fill output");
        let b = self.open_window("program-key", &key, s["keyDisplayId"].as_str().unwrap_or(""), 1, &json!({ "output": "key" }), "program key output");
        if !(a && b) {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(800));
        self.set_program(name)
    }

    /// loadProgramOutput(name): window.setProgramOutputOverlay(name) in both program windows.
    pub fn set_program(&self, name: &str) -> bool {
        if !PROGRAM_OUTPUTS.contains(&name) {
            return false;
        }
        *self.program.lock().unwrap() = name.to_string();
        let js = format!("window.setProgramOutputOverlay && window.setProgramOutputOverlay({})", json!(name));
        let a = self.send(json!({ "cmd": "eval", "id": "program-fill", "js": js }), 1500).is_some_and(|r| r["ok"] == true);
        let b = self.send(json!({ "cmd": "eval", "id": "program-key", "js": js }), 1500).is_some_and(|r| r["ok"] == true);
        a || b
    }

    /// overlay:open-output(details). Returns (opened, closed) like { opened, closed } / true / false.
    pub fn open_output(&self, name: &str, query: &Value) -> Value {
        if query["output"] == "pair" {
            return json!(self.open_program(name));
        }
        let s = self.settings();
        let mut q = query.clone();
        if query["setup"] == "game" {
            let mut open = self.game_setup_open.lock().unwrap();
            if *open {
                self.send(json!({ "cmd": "close", "id": "game-setup" }), 1500);
                *open = false;
                return json!({ "opened": false, "closed": true });
            }
            if q["output"].as_str().is_none_or(str::is_empty) {
                q["output"] = json!("fill");
            }
            q["resolution"] = s["gameOverlayResolution"].clone();
        }
        let mode = q["output"].as_str().unwrap_or("fill").to_string();
        let (mon, fb) = if q["setup"] == "game" { (s["gameOverlayDisplayId"].clone(), 0) } else if mode == "key" { (s["keyDisplayId"].clone(), 1) } else { (s["fillDisplayId"].clone(), 0) };
        let pairs: Vec<(String, String)> = q.as_object().cloned().unwrap_or_default().into_iter().map(|(k, v)| (k, isu_core::game_config::js_string(Some(&v)))).collect();
        let refs: Vec<(&str, &str)> = pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let Some(url) = crate::ui::overlay_url(name, &refs) else { return json!(false) };
        let game = q["setup"] == "game";
        let id = if game { "game-setup".to_string() } else { format!("{name}-{mode}-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)) };
        let title = if game { "Valorant game alignment overlay".to_string() } else { format!("{name} {mode} output") };
        let ok = self.open_window(&id, &url, mon.as_str().unwrap_or(""), fb, &q, &title);
        if ok && game {
            *self.game_setup_open.lock().unwrap() = true;
        }
        json!(ok)
    }

    pub fn shutdown(&self) {
        if let Some(mut h) = self.helper.lock().unwrap().take() {
            let _ = writeln!(h.stdin, "{}", json!({ "cmd": "quit" }));
            let _ = h.child.wait();
        }
    }
}
