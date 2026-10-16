//! ISU output windows: the overlay pages full screen on chosen monitors, like electron/main.cjs
//! createOverlayOutputWindow / openProgramOutput / loadProgramOutput / overlay:preview. A helper
//! process the controller starts (egui and the webview each keep their own window loop).
//!
//! Commands, one JSON per line on stdin:
//!   {"cmd":"open","id":"fill","url":"…","monitor":"<id>|","fallback":0,"width":1920,"height":1080,
//!    "fullscreen":true,"transparent":false,"onTop":false,"clickThrough":false,"title":"…"}
//!   {"cmd":"eval","id":"fill","js":"window.setProgramOutputOverlay('roster')"}
//!   {"cmd":"close","id":"fill"}        {"cmd":"monitors"}        {"cmd":"quit"}
//! Replies on stdout: {"ok":true,"id":…} | {"monitors":[{id,label,width,height,x,y,scaleFactor,primary}]}
//! The page zoom follows the window like fitOverlayOutputScale: min(w / width, h / height).
use std::collections::HashMap;
use std::io::BufRead;

use serde_json::{Value, json};
use tao::dpi::{LogicalSize, PhysicalPosition};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::monitor::MonitorHandle;
use tao::window::{Fullscreen, Window, WindowBuilder};
use wry::{WebView, WebViewBuilder};

struct Out {
    window: Window,
    webview: WebView,
    size: (f64, f64),
}

fn say(v: Value) {
    println!("{v}");
}

/// monitor id = position + size (stable while nothing is re-plugged), like Electron's display ids.
fn monitor_id(m: &MonitorHandle) -> String {
    let p = m.position();
    let s = m.size();
    format!("{}x{}@{},{}", s.width, s.height, p.x, p.y)
}

/// orderedDisplays(): primary first, then the rest.
fn ordered(monitors: Vec<MonitorHandle>, primary: Option<MonitorHandle>) -> Vec<MonitorHandle> {
    let pid = primary.as_ref().map(monitor_id);
    let mut v: Vec<MonitorHandle> = monitors.iter().filter(|m| Some(monitor_id(m)) == pid).cloned().collect();
    v.extend(monitors.into_iter().filter(|m| Some(monitor_id(m)) != pid));
    v
}

fn build_webview(window: &Window, url: &str, transparent: bool) -> wry::Result<WebView> {
    let b = WebViewBuilder::new().with_url(url).with_transparent(transparent).with_background_color(if transparent { (0, 0, 0, 0) } else { (0, 0, 0, 255) });
    #[cfg(target_os = "linux")]
    {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        b.build_gtk(window.default_vbox().expect("gtk vbox"))
    }
    #[cfg(not(target_os = "linux"))]
    b.build(window)
}

fn fit(o: &Out) {
    let s = o.window.inner_size().to_logical::<f64>(o.window.scale_factor());
    let zoom = (s.width / o.size.0).min(s.height / o.size.1).max(0.1);
    let _ = o.webview.zoom(zoom);
}

fn main() {
    let event_loop = EventLoopBuilder::<Value>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if proxy.send_event(v).is_err() {
                    break;
                }
            }
        }
        let _ = proxy.send_event(json!({ "cmd": "quit" }));
    });
    let mut outs: HashMap<String, Out> = HashMap::new();
    event_loop.run(move |event, target, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(cmd) => {
                let id = cmd["id"].as_str().unwrap_or("").to_string();
                match cmd["cmd"].as_str().unwrap_or("") {
                    "monitors" => {
                        let prim = target.primary_monitor();
                        let pid = prim.as_ref().map(monitor_id);
                        let list: Vec<Value> = ordered(target.available_monitors().collect(), prim).iter().map(|m| {
                            let (p, s) = (m.position(), m.size());
                            let primary = Some(monitor_id(m)) == pid;
                            json!({ "id": monitor_id(m), "label": format!("{}{} ({}x{} @ {},{})", m.name().unwrap_or_else(|| monitor_id(m)), if primary { " - Primary" } else { "" }, s.width, s.height, p.x, p.y), "width": s.width, "height": s.height, "x": p.x, "y": p.y, "scaleFactor": m.scale_factor(), "primary": primary })
                        }).collect();
                        say(json!({ "monitors": list }));
                    }
                    "open" => {
                        if let Some(o) = outs.remove(&id) {
                            drop(o);
                        }
                        let mons = ordered(target.available_monitors().collect(), target.primary_monitor());
                        let want = cmd["monitor"].as_str().unwrap_or("");
                        let fb = cmd["fallback"].as_u64().unwrap_or(0) as usize;
                        // displayBySavedId(id, fallbackIndex)
                        let mon = mons.iter().find(|m| monitor_id(m) == want).or_else(|| mons.get(fb)).or_else(|| mons.first()).cloned();
                        let (w, h) = (cmd["width"].as_f64().unwrap_or(1920.0), cmd["height"].as_f64().unwrap_or(1080.0));
                        let transparent = cmd["transparent"] == true;
                        let mut wb = WindowBuilder::new().with_title(cmd["title"].as_str().unwrap_or("ISU output")).with_inner_size(LogicalSize::new(w.min(1280.0), h.min(720.0))).with_decorations(cmd["fullscreen"] != true).with_transparent(transparent).with_always_on_top(cmd["onTop"] == true);
                        if let Some(m) = &mon {
                            let p = m.position();
                            wb = wb.with_position(PhysicalPosition::new(p.x, p.y));
                            if cmd["fullscreen"] == true {
                                wb = wb.with_fullscreen(Some(Fullscreen::Borderless(Some(m.clone()))));
                            }
                        }
                        match wb.build(target) {
                            Ok(window) => {
                                if cmd["clickThrough"] == true {
                                    let _ = window.set_ignore_cursor_events(true);
                                }
                                match build_webview(&window, cmd["url"].as_str().unwrap_or("about:blank"), transparent) {
                                    Ok(webview) => {
                                        let o = Out { window, webview, size: (w, h) };
                                        fit(&o);
                                        outs.insert(id.clone(), o);
                                        say(json!({ "ok": true, "id": id }));
                                    }
                                    Err(e) => say(json!({ "ok": false, "id": id, "error": e.to_string() })),
                                }
                            }
                            Err(e) => say(json!({ "ok": false, "id": id, "error": e.to_string() })),
                        }
                    }
                    "eval" => {
                        let ok = outs.get(&id).is_some_and(|o| o.webview.evaluate_script(cmd["js"].as_str().unwrap_or("")).is_ok());
                        say(json!({ "ok": ok, "id": id }));
                    }
                    "close" => {
                        let had = outs.remove(&id).is_some();
                        say(json!({ "ok": had, "id": id }));
                    }
                    "list" => say(json!({ "open": outs.keys().cloned().collect::<Vec<_>>() })),
                    "quit" => *flow = ControlFlow::Exit,
                    _ => {}
                }
            }
            Event::WindowEvent { window_id, event, .. } => {
                let key = outs.iter().find(|(_, o)| o.window.id() == window_id).map(|(k, _)| k.clone());
                match (key, event) {
                    (Some(k), WindowEvent::CloseRequested) => {
                        outs.remove(&k);
                        say(json!({ "closed": k }));
                    }
                    (Some(k), WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }) => {
                        if let Some(o) = outs.get(&k) {
                            fit(o);
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    });
}
