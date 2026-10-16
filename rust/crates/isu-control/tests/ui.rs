//! The real controller window driven like a user, with egui_kittest (buttons found by their label
//! through AccessKit, no screen): Match Control buttons, view switching, game picker, Displays view
//! against a real station socket, OBS setup against the JS test's fake OBS. One test because the
//! services use the real ports.
use std::sync::Arc;
use std::time::Duration;

use eframe::egui;
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use futures_util::{SinkExt, StreamExt};
use isu_control::core::Core;
use isu_control::services::Services;
use isu_control::settings::Files;
use serde_json::{Value, json};

fn settle(h: &mut Harness<'_, isu_control::ui::App>) {
    for _ in 0..6 {
        h.step();
        std::thread::sleep(Duration::from_millis(40));
    }
}

#[test]
fn controller_window_like_a_user() {
    let dir = std::env::temp_dir().join(format!("isu-ui-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("control-state.json"), r#"{"version":4,"games":{},"selectedGame":"valorant","activeView":"control"}"#).unwrap();
    // fake OBS (the JS test's server)
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut fobs = std::process::Command::new("node").arg(repo.join("rust/scripts/fake-obs.cjs")).arg("pw").arg("1").current_dir(&repo).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
    let mut out = std::io::BufReader::new(fobs.stdout.take().unwrap());
    let mut line = String::new();
    std::io::BufRead::read_line(&mut out, &mut line).unwrap();
    let obs_port: u16 = line.trim().strip_prefix("PORT ").unwrap().parse().unwrap();
    std::fs::write(dir.join("obs-displays.json"), json!({ "host": "127.0.0.1", "port": obs_port, "password": "pw", "resolution": "1280x720", "fps": 30 }).to_string()).unwrap();

    // the readers capture Derk's real Overwatch board picture (same as crates/isu-ocr/tests/ow_service.rs)
    unsafe { std::env::set_var("ISU_CAPTURE_FILE", format!("{}@640,190", repo.join("test/fixtures/ow-board-table.png").display())); }
    let core = Core::new(Files::new(dir.clone()), isu_server::Store::new());
    let svc = Services::start(Arc::clone(&core));
    let svc2 = Arc::clone(&svc);
    let mut h = Harness::builder().with_size(egui::vec2(1600.0, 1000.0)).build_eframe(move |cc| isu_control::ui::App::new(&cc.egui_ctx, svc2));
    settle(&mut h);

    // --- Match Control: score +, live, swap
    h.get_by_label("● Take live").click(); settle(&mut h);
    assert_eq!(core.state()["games"]["valorant"]["match"]["live"], true);
    let plus: Vec<_> = h.get_all_by_label("+").collect();
    plus[0].click(); settle(&mut h);
    assert_eq!(core.state()["games"]["valorant"]["teams"][0]["score"], 1, "home score +");
    let home_name = core.state()["games"]["valorant"]["teams"][0]["name"].clone();
    h.get_by_label("⇄ SWAP SIDES").click(); settle(&mut h);
    // VALORANT: names swap, scores stay on their side (swapGameTeamsPreservingSideScores)
    assert_eq!(core.state()["games"]["valorant"]["teams"][1]["name"], home_name, "swap moved the team");
    assert_eq!(core.state()["games"]["valorant"]["teams"][0]["score"], 1, "score stays on its side");
    // reset needs two clicks
    h.get_by_label("RESET SCORES").click(); settle(&mut h);
    assert_eq!(core.state()["games"]["valorant"]["teams"][0]["score"], 1, "first click only arms");
    h.get_by_label("Click again to reset scores").click(); settle(&mut h);
    assert_eq!(core.state()["games"]["valorant"]["teams"][0]["score"], 0, "second click resets");
    // undo brings it back
    h.get_by_label("↶ Undo").click(); settle(&mut h);
    assert_eq!(core.state()["games"]["valorant"]["teams"][0]["score"], 1, "undo");

    // --- VALORANT reader panel: a board snapshot shows up in the table, round override
    core.valorant_board_snapshot(&json!({ "teams": { "home": { "players": [{ "name": "Sn0wfal", "agent": "jett", "kills": 7, "credits": 4300, "shield": "heavy", "row": 0 }] }, "away": { "players": [{ "name": "santi", "agent": "sova", "row": 0 }] } }, "colors": { "home": "red" }, "match": { "homeScore": 0, "awayScore": 0, "timer": { "display": "1:23" } }, "status": { "state": "reading", "message": "board found" } }));
    settle(&mut h);
    assert!(h.query_all_by_label("4,300").next().is_some(), "credits with a thousands comma");
    assert!(h.query_all_by_label_contains("ROUND SCORE 0 – 0 · TIMER 1:23").next().is_some(), "round score line");
    assert!(h.query_all_by_label_contains("READING · board found").next().is_some(), "reader status");
    // the top block goes to the team the mapping decided (isu_core::boards, parity-tested)
    let top = core.lock().valorant_board["decision"]["top"].as_str().unwrap().to_string();
    let other = if top == "home" { "away" } else { "home" };
    let live = core.state()["games"]["valorant"]["valorantBoard"]["live"].clone();
    assert_eq!(live["teams"][top.as_str()]["players"][0]["name"], "Sn0wfal", "top block published under the decided team");
    assert_eq!(live["teams"][other]["players"][0]["name"], "santi");
    assert!(h.query_all_by_label_contains("TEAMS ON THE BOARD: top = ").next().is_some(), "decision line shown");

    // --- Map Pool view + winner
    h.get_by_label("Map Pool").click(); settle(&mut h);
    assert_eq!(core.state()["activeView"], "maps");
    h.get_by_label("Series map order").hover();
    // --- Displays view with a real station 3
    h.get_by_label("Displays").click(); settle(&mut h);
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (msgs, mut tx) = rt.block_on(async {
        let (ws, _) = tokio_tungstenite::connect_async("ws://127.0.0.1:3178/display").await.unwrap();
        let (mut tx, mut rx) = ws.split();
        tx.send(tokio_tungstenite::tungstenite::Message::Text(json!({ "type": "hello", "station": 3, "hostname": "PC3" }).to_string().into())).await.unwrap();
        let msgs: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
        let m2 = Arc::clone(&msgs);
        tokio::spawn(async move { while let Some(Ok(m)) = rx.next().await { if let tokio_tungstenite::tungstenite::Message::Text(t) = m { m2.lock().unwrap().push(serde_json::from_str(&t).unwrap()); } } });
        (msgs, tx)
    });
    std::thread::sleep(Duration::from_millis(300));
    settle(&mut h);
    h.get_by_label("ALL: GAME MIRROR").click(); settle(&mut h);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(msgs.lock().unwrap().iter().rev().find(|m| m["type"] == "mode").unwrap()["mode"], "mirror", "station got mirror");
    let noise_buttons: Vec<_> = h.get_all_by_label("PINK NOISE OFF").collect();
    noise_buttons[2].click(); settle(&mut h);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(msgs.lock().unwrap().iter().rev().find(|m| m["type"] == "noise").unwrap()["on"], true, "station 3 got pink noise on");
    // preset for all: Player cards
    let cards: Vec<_> = h.get_all_by_role_and_label(egui::accesskit::Role::Button, "Player cards").collect();
    eprintln!("player-cards buttons: {}", cards.len());
    cards.last().unwrap().scroll_to_me(); settle(&mut h);
    let cards: Vec<_> = h.get_all_by_role_and_label(egui::accesskit::Role::Button, "Player cards").collect();
    cards.last().unwrap().click(); settle(&mut h);
    eprintln!("displays after preset: {}", core.state()["displays"]);
    assert_eq!(core.state()["displays"]["stations"]["7"]["preset"], "player");
    // OBS setup against the fake OBS
    h.get_by_label("SET UP OBS").scroll_to_me(); settle(&mut h);
    h.get_by_label("SET UP OBS").click();
    for _ in 0..40 { settle(&mut h); if h.query_all_by_label_contains("OBS 31.1.2: 10 NDI feeds").next().is_some() { break; } }
    assert!(h.query_all_by_label_contains("OBS 31.1.2: 10 NDI feeds (ISU Stage 01 … ISU Stage 10) · added").next().is_some(), "OBS setup message shown");
    // CHECK OBS: the live summary from the fake OBS (10 feeds live)
    h.get_by_label("CHECK OBS").click();
    for _ in 0..40 { settle(&mut h); if h.query_all_by_label_contains("10/10 feeds live").next().is_some() { break; } }
    assert!(h.query_all_by_label_contains("OBS 1280x720 · 30/30 fps · CPU 12% · render 3.2 ms · skipped 0/0 · 10/10 feeds live").next().is_some(), "OBS summary shown");
    rt.block_on(async { let _ = tx.close().await; });

    // --- OBS Outputs: take Map Pool for the program output (no output windows in tests: helper not opened)
    h.get_by_label("OBS Outputs").click(); settle(&mut h);
    let undo_before = core.lock().history.len();
    // the program buttons are the "Map Pool" button that is NOT the sidebar nav item (sidebar = x < 256)
    // the program "Map Pool" button (not the sidebar nav item, which sits left of x=256)
    let mp: Vec<_> = h.get_all_by_role_and_label(egui::accesskit::Role::Button, "Map Pool").collect();
    mp.iter().find(|n| n.rect().left() > 256.0).expect("program Map Pool button").click(); settle(&mut h);
    assert_eq!(core.state()["activeOutputOverlay"], "map-pool", "program output taken");
    assert_eq!(core.lock().history.len(), undo_before, "take-program-output persists without undo (app.js)");
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(core.store.state()["activeOutputOverlay"], "map-pool", "overlay server has it");

    // --- Settings: Companion on with a key, then the API answers
    h.get_by_label("Settings").click(); settle(&mut h);
    h.get_by_label("Enable LAN API").scroll_to_me(); settle(&mut h);
    let cb: Vec<_> = h.get_all_by_label_contains("Enable LAN API").collect();
    cb[0].click(); for _ in 0..10 { settle(&mut h); }
    assert_eq!(svc.companion.status()["listening"], true, "Companion API listening after the checkbox");
    let tok = svc.companion.settings().token;
    let ok = std::process::Command::new("curl").args(["-s", "-o", "/dev/null", "-w", "%{http_code}", "-H", &format!("X-ISU-API-Key: {tok}"), "http://127.0.0.1:3176/api/companion/state"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&ok.stdout), "200");
    // RESET GAME needs two clicks
    h.get_by_label("RESET GAME").scroll_to_me(); settle(&mut h);
    h.get_by_label("RESET GAME").click(); settle(&mut h);
    h.get_by_label("Click again: wipes this game").click(); settle(&mut h);
    assert_eq!(core.state()["games"]["valorant"]["teams"][0]["score"], 0);

    // --- Overwatch: DEBUG CAPTURE on the real board, then USE a name from it
    {
        let mut g = core.lock();
        g.state["selectedGame"] = json!("overwatch");
        g.state["activeView"] = json!("control");
    }
    settle(&mut h);
    h.get_by_label("DEBUG CAPTURE").scroll_to_me(); settle(&mut h);
    h.get_by_label("DEBUG CAPTURE").click();
    for _ in 0..80 { settle(&mut h); if h.query_all_by_label_contains("DEBUG CAPTURE · ").next().is_some() { break; } }
    assert!(h.query_all_by_label_contains("DEBUG CAPTURE · ").next().is_some(), "debug capture shown");
    assert!(h.query_all_by_label_contains("AUTO-ALIGN · ").next().is_some(), "align summary");
    assert!(h.query_all_by_label_contains("→ 215").next().is_some(), "home 1 damage cell read 215");
    h.get_by_label("HIDE DEBUG").click(); settle(&mut h);
    assert!(h.query_all_by_label_contains("DEBUG CAPTURE · ").next().is_none(), "hidden");
    // TEST READ twice fills the table (two equal reads)
    for _ in 0..2 {
        h.get_by_label("TEST READ").click();
        for _ in 0..60 { settle(&mut h); if !h.query_all_by_label("Read the scoreboard once").next().is_none() { break; } }
        std::thread::sleep(Duration::from_millis(300));
    }
    for _ in 0..10 { settle(&mut h); }
    assert_eq!(core.state()["games"]["overwatch"]["overwatchOcr"]["live"]["teams"]["home"]["players"][0]["damage"], 215, "board published to the overlay state");

    // --- game picker: Rocket League, no undo point (persistState)
    let undo_len = core.lock().history.len();
    h.get_by_role_and_label(egui::accesskit::Role::Button, "Map Pool").click(); settle(&mut h);
    {
        let mut st = core.lock();
        st.state["selectedGame"] = json!("valorant");
    }
    assert_eq!(core.lock().history.len(), undo_len, "view switches add no undo steps");

    svc.shutdown();
    let _ = fobs.kill();
    let _ = std::fs::remove_dir_all(dir);
}
