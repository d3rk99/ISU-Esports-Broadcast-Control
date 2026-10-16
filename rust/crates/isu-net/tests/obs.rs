//! test/obs-displays.test.cjs ported: the Rust OBS client against the SAME fake obs-websocket
//! server the JS test uses (rust/scripts/fake-obs.cjs runs it).
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};

use isu_net::obs::{ALL_SCENE, ObsClient, Setup, auth_string, setup_stage_scenes, stage_status, station_url};
use serde_json::{Value, json};

struct Fake { child: Child, port: u16, out: BufReader<std::process::ChildStdout> }
impl Fake {
    fn start(pw: &str, ndi: bool) -> Self {
        let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../../scripts/fake-obs.cjs");
        let mut child = Command::new("node").arg(script).arg(pw).arg(if ndi { "1" } else { "0" }).current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../../..")).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().expect("node");
        let mut out = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new(); out.read_line(&mut line).unwrap();
        let port = line.trim().strip_prefix("PORT ").unwrap().parse().unwrap();
        Self { child, port, out }
    }
    fn dump(&mut self) -> Value {
        self.child.stdin.as_mut().unwrap().write_all(b"dump\n").unwrap();
        let mut line = String::new();
        loop { line.clear(); self.out.read_line(&mut line).unwrap(); if let Some(j) = line.strip_prefix("DUMP ") { return serde_json::from_str(j).unwrap(); } }
    }
}
impl Drop for Fake { fn drop(&mut self) { let _ = self.child.kill(); } }

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn builds_scenes_pages_filters_idempotent() {
    let mut f = Fake::start("pw", true);
    let mut c = ObsClient::default();
    c.connect("127.0.0.1", f.port, "pw").await.unwrap();
    let first = setup_stage_scenes(&mut c, &Setup::new("http://10.0.0.5:3174")).await.unwrap();
    assert_eq!(first["ndiNames"].as_array().unwrap().len(), 10);
    let o = f.dump();
    assert_eq!(o["video"], json!({ "baseWidth": 1280, "baseHeight": 720, "outputWidth": 1280, "outputHeight": 720, "fpsNumerator": 30, "fpsDenominator": 1 }));
    let page = &o["inputs"]["ISU Stage 03 Page"];
    assert_eq!(page["kind"], "browser_source");
    assert_eq!(page["settings"]["url"], "http://10.0.0.5:3174/displays/station.html?station=3");
    assert_eq!(page["settings"]["width"], 1280);
    let filter = &o["scenes"]["ISU Stage 03"]["filters"]["ISU Stage 03 NDI"];
    assert_eq!(filter["kind"], "ndi_filter");
    assert_eq!(filter["settings"]["ndi_filter_ndiname"], "ISU Stage 03");
    assert_eq!(o["program"], ALL_SCENE);
    assert_eq!(o["scenes"][ALL_SCENE]["items"].as_array().unwrap().len(), 10);
    setup_stage_scenes(&mut c, &Setup::new("http://10.0.0.9:3174")).await.unwrap();
    let o = f.dump();
    assert_eq!(o["scenes"].as_object().unwrap().len(), 11);
    assert_eq!(o["scenes"][ALL_SCENE]["items"].as_array().unwrap().len(), 10);
    assert_eq!(o["inputs"]["ISU Stage 03 Page"]["settings"]["url"], "http://10.0.0.9:3174/displays/station.html?station=3");
    let st = stage_status(&mut c, 10).await.unwrap();
    assert_eq!(st["stations"].as_array().unwrap().iter().filter(|s| s["active"] == true && s["ndiOn"] == true).count(), 10);
    assert_eq!(st["resolution"], "1280x720");
    assert_eq!(st["cpu"], 12); assert_eq!(st["renderMs"], 3.2); assert_eq!(st["fps"], 30);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wrong_password_and_missing_distroav() {
    let a = Fake::start("pw", true);
    let mut c = ObsClient::default();
    let e = c.connect("127.0.0.1", a.port, "nope").await.unwrap_err();
    assert!(e.message.contains("refused the password"), "{}", e.message);
    drop(a);
    let b = Fake::start("pw", false);
    c.connect("127.0.0.1", b.port, "pw").await.unwrap();
    let e = setup_stage_scenes(&mut c, &Setup::new("http://x:3174")).await.unwrap_err();
    assert!(e.message.contains("DistroAV is not installed"), "{}", e.message);
    let e = ObsClient::default().connect("127.0.0.1", b.port, "").await.unwrap_err();
    assert!(e.message.contains("needs a WebSocket password"), "{}", e.message);
}

#[test]
fn station_url_and_auth_like_js() {
    assert_eq!(station_url("http://192.168.1.20:3174", 10), "http://192.168.1.20:3174/displays/station.html?station=10");
    let js = String::from_utf8(Command::new("node").arg("-e").arg("process.stdout.write(require('./electron/displays/obs-displays.cjs').authString('pw','c2FsdA==','Y2hhbGxlbmdl'))").current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../../..")).output().unwrap().stdout).unwrap();
    assert_eq!(auth_string("pw", "c2FsdA==", "Y2hhbGxlbmdl"), js);
}
