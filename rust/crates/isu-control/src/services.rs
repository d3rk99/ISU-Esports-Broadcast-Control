//! Service wiring of electron/main.cjs app.whenReady(): overlay server 3174, Companion API 3176,
//! Display Manager 3178, Rocket League Stats API, spectate receiver, VALORANT board reader,
//! Overwatch reader, OBS stage setup. Everything reports into the Core.
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use isu_core::game_config::truthy;
use serde_json::{Value, json};

use crate::core::Core;

pub struct Services {
    pub core: Arc<Core>,
    pub rt: tokio::runtime::Runtime,
    pub companion: Arc<isu_server::companion::Companion>,
    pub displays: Arc<isu_net::displays::DisplayManager>,
    pub rl: Arc<isu_net::rocket_league::RocketLeagueService>,
    pub spectate: Arc<isu_net::spectate::SpectateReceiver>,
    pub board: Option<Arc<isu_ocr::service::BoardService>>,
    pub overwatch: Option<Arc<isu_ocr::ow_service::OverwatchService>>,
    pub overlay_error: Mutex<String>,
    pub outputs: Arc<crate::outputs::Outputs>,
    pub repo: PathBuf,
    pub exe_dir: PathBuf,
}

/// The folder with public/ + electron/ (packaged: next to the exe or resources\, dev: the repo).
pub fn data_root() -> PathBuf {
    let exe = std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())).unwrap_or_default();
    for c in [exe.join("resources"), exe.clone()].into_iter().chain(std::env::var_os("ISU_NO_DEV_ROOT").is_none().then(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."))) {
        if c.join("public").join("overlays").exists() {
            return c.canonicalize().unwrap_or(c);
        }
    }
    exe
}

/// rocketLeagueLoadoutPackLocations() -> first existing pack (directory with manifest.json or a .zip).
fn find_rl_pack(root: &std::path::Path, exe: &std::path::Path) -> Option<(String, PathBuf)> {
    let roots = [root.join("assests"), std::env::current_dir().unwrap_or_default().join("assests"), exe.join("assests"), exe.join("../../../assests"), exe.join("../../assests")];
    for r in roots {
        for name in ["rl-loadout-assets", "rl-loadout-assets.zip"] {
            let c = r.join(name);
            if c.is_dir() && c.join("manifest.json").exists() {
                return Some(("directory".into(), c));
            }
            if c.is_file() && name.ends_with(".zip") {
                return Some(("zip".into(), c));
            }
        }
    }
    None
}

impl Services {
    pub fn start(core: Arc<Core>) -> Arc<Self> {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().worker_threads(4).build().expect("runtime");
        let root = data_root();
        let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())).unwrap_or_default();
        let files = core.files.clone();
        let store = Arc::clone(&core.store);

        // Display Manager (status -> UI + Companion stage variables)
        let c2 = Arc::clone(&core);
        let displays = isu_net::displays::DisplayManager::new(3178, "0.0.0.0", &files.display_key(), Arc::new(move |st| {
            c2.lock().display_status = st;
            c2.lock().dirty_ui = true;
        }));

        // Companion API: actions run on the core
        let (atx, mut arx) = tokio::sync::mpsc::unbounded_channel::<isu_server::companion::ActionRequest>();
        let d2 = Arc::clone(&displays);
        let s2 = Arc::clone(&store);
        let companion = isu_server::companion::Companion::new(Arc::clone(&store), Arc::new(move || {
            let mut st = d2.status();
            // Companion performs its own freshness check (like currentSpectated in
            // main.cjs), so it needs the raw receipt timestamp, not the overlay DTO.
            let sp = s2.lock().spectated.clone();
            st["spectated"] = json!({ "name": sp.name, "station": sp.station,
                "side": sp.side, "team": sp.team, "receivedAt": sp.received_at });
            st
        }), atx);
        let c3 = Arc::clone(&core);
        let d3 = Arc::clone(&displays);
        rt.spawn(async move {
            while let Some(req) = arx.recv().await {
                // stage.* -> dispatchCompanionStageAction (Display Manager), everything else -> the controller
                let action = req.body.get("action").and_then(Value::as_str).unwrap_or("").to_string();
                let r = if action.starts_with("stage.") { stage_action(&d3, &req.body) } else { c3.companion_action(&req.body) };
                let _ = req.reply.send(r);
            }
        });

        // Rocket League Stats API
        let c4 = Arc::clone(&core);
        let c5 = Arc::clone(&core);
        let rl = isu_net::rocket_league::RocketLeagueService::new(Arc::new(move |ev| { c4.rl_event(&ev); }), Arc::new(move |st| c5.rl_status(&st)));

        // Spectated player receiver
        let c6 = Arc::clone(&core);
        let s6 = Arc::clone(&store);
        let c7 = Arc::clone(&core);
        let spectate = isu_net::spectate::SpectateReceiver::new(
            Arc::new(move |sp| {
                let state = s6.state();
                let r = isu_net::spectate::resolve(&state, &sp);
                s6.set_spectated(isu_server::store::Spectated {
                    name: r.get("name").and_then(Value::as_str).unwrap_or("").into(),
                    station: r.get("station").and_then(Value::as_f64),
                    side: r.get("side").and_then(Value::as_str).unwrap_or("").into(),
                    team: r.get("team").and_then(Value::as_str).unwrap_or("").into(),
                    received_at: r.get("receivedAt").and_then(Value::as_f64).unwrap_or_else(crate::core::now_ms),
                });
                c6.lock().spectate["spectated"] = r;
                c6.lock().dirty_ui = true;
                c6.repaint();
            }),
            Arc::new(move |st| { c7.lock().spectate["status"] = st; c7.lock().dirty_ui = true; c7.repaint(); }),
        );

        // Scoreboard readers (Tesseract + window capture); missing models = reader off, app runs.
        let cache = files.dir.join("ocr-cache");
        // ISU_CAPTURE_FILE=<png>[@x,y]: tests / demos read this picture (grey, placed on a black 1080p frame)
        let source: Arc<dyn isu_ocr::capture::Source> = std::env::var("ISU_CAPTURE_FILE").ok().and_then(|f| file_source(&f)).unwrap_or_else(make_source);
        let c8 = Arc::clone(&core);
        let c9 = Arc::clone(&core);
        // English model: the repo's tesseract.js copy (dev) or tessdata/eng.traineddata next to the exe (installed)
        let eng = isu_ocr::tess::unpack_gz_model(&root.join("node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz"), &cache, "eng")
            .ok()
            .or_else(|| root.join("tessdata/eng.traineddata").exists().then(|| root.join("tessdata")));
        // The reader gets the roster gamertags as hints whenever they change (setValorantBoardKnownNames).
        let board_slot: Arc<std::sync::OnceLock<std::sync::Weak<isu_ocr::service::BoardService>>> = Arc::default();
        let slot2 = Arc::clone(&board_slot);
        let board = eng.clone().map(|eng_dir| isu_ocr::service::Models { eng_dir, val_dir: root.join("electron/ocr-models"), templates_dir: root.join("electron") }).map(|m| {
            isu_ocr::service::BoardService::new(Arc::clone(&source), m, Box::new(move |snap| {
                if let Some(hint) = c8.valorant_board_snapshot(&snap) {
                    send_known_names(&c8, slot2.get().and_then(std::sync::Weak::upgrade).as_deref(), &hint);
                }
            }), Box::new(move |st| c9.valorant_board_status(&st)))
        });
        if let Some(b) = &board {
            let _ = board_slot.set(Arc::downgrade(b));
        }
        let c10 = Arc::clone(&core);
        let c11 = Arc::clone(&core);
        let ow_models = eng.map(|eng| isu_ocr::ow_service::Models { eng_dir: eng, ow_dir: root.join("electron/ocr-models"), data_dir: root.join("electron") });
        let overwatch = ow_models.and_then(|m| isu_ocr::ow_service::OverwatchService::new(Arc::clone(&source), m, Box::new(move |snap| c10.overwatch_snapshot(&snap)), Box::new(move |st| c11.overwatch_status(&st))).ok());

        let me = Arc::new(Self { core: Arc::clone(&core), rt, companion, displays, rl, spectate, board, overwatch, outputs: crate::outputs::Outputs::new(files.clone()), overlay_error: Mutex::new(String::new()), repo: root.clone(), exe_dir: exe_dir.clone() });

        // publishBroadcastState: spectate candidates follow every publish
        let sp2 = Arc::clone(&me.spectate);
        core.on_publish.lock().unwrap().push(Box::new(move |state| {
            sp2.set_candidates(&isu_net::spectate::candidates_from(state), &isu_net::spectate::sides_from(state));
        }));
        // board reader: roster gamertags as hints (setValorantBoardKnownNames)
        // (sent from the core's snapshot handler result in the UI loop)

        // start everything like whenReady()
        let m2 = Arc::clone(&me);
        let (files_a, exe_a, root_a) = (files.clone(), exe_dir.clone(), root.clone());
        me.rt.block_on(async move {
            let (files, exe_dir, root) = (files_a, exe_a, root_a);
            m2.companion.configure(&files.companion()).await;
            m2.displays.start().await;
            if !m2.displays.error().is_empty() {
                m2.core.store.record_diagnostic("displays", &m2.displays.error());
            }
            let f2 = files.clone();
            let exe2 = exe_dir.clone();
            let cfg = isu_server::overlay::Config {
                static_root: root.join("public"),
                asset_root: files.dir.join("broadcast-assets"),
                rl_pack: find_rl_pack(&root, &exe_dir),
                rl_backup: Arc::new(move || match f2.rl_connection(&exe2) {
                    Some(c) => json!({ "enabled": truthy(c.get("enabled")), "source": c.get("source").cloned().unwrap_or(Value::Null), "bridgePort": c.get("bridgePort").cloned().unwrap_or(Value::Null), "tokenPresent": truthy(c.get("bridgeToken")) }),
                    None => Value::Null,
                }),
            };
            if let Err(e) = isu_server::overlay::start(Arc::clone(&m2.core.store), cfg, 3174).await {
                *m2.overlay_error.lock().unwrap() = format!("Port 3174 is unavailable. Close any other copy of ISU Esports Broadcast Control and reopen the app.\n\n{e}");
            }
        });
        let spec = files.merged("spectate-receiver.json", |v| { let s = isu_net::spectate::normalize_settings(v); json!({ "enabled": s.enabled, "port": s.port, "token": s.token }) });
        {
            let _guard = me.rt.enter();
            me.spectate.configure(&spec);
        }
        if let Some(b) = &me.board {
            b.configure(&files.merged("valorant-board-settings.json", |v| isu_ocr::service::settings_json(&isu_ocr::service::normalize_settings(v))));
        }
        if let Some(o) = &me.overwatch {
            o.configure(&files.read("overwatch-ocr-settings.json").unwrap_or(json!({})));
        }
        // the RL connection from the saved file joins the state once (app.js savedRocketLeagueConnection)
        if let Some(saved) = files.rl_connection(&exe_dir) {
            let mut g = core.lock();
            for (k, v) in saved.as_object().cloned().unwrap_or_default() {
                g.state["games"]["rocketleague"]["rocketLeague"][k] = v;
            }
        }
        me.sync_rl();
        // first publish
        let s = core.state();
        core.publish_now(&s);
        // timers (save / live publish / auto advance)
        let c12 = Arc::clone(&core);
        std::thread::spawn(move || loop {
            c12.tick();
            std::thread::sleep(std::time::Duration::from_millis(10));
        });
        // stale spectated name: re-publish so Companion / overlays clear it (main.cjs every 3 s)
        let st = Arc::clone(&store);
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(3));
            let stale = { let g = st.lock(); !g.spectated.name.is_empty() && crate::core::now_ms() - g.spectated.received_at > 10_000.0 };
            if stale {
                let mut sp = st.lock().spectated.clone();
                sp.name.clear();
                sp.station = None;
                st.set_spectated(sp);
            }
        });
        me
    }

    /// syncRocketLeagueConnection(): configure the service + save the connection file.
    pub fn sync_rl(&self) {
        let c = self.core.rl_connection();
        self.core.files.save_rl_connection(&c);
        let rl = Arc::clone(&self.rl);
        let _g = self.rt.enter();
        rl.configure(&c);
    }

    pub fn shutdown(&self) {
        self.outputs.shutdown();
        self.rl.stop();
        self.spectate.stop();
        if let Some(b) = &self.board {
            b.shutdown();
        }
        self.displays.stop();
        self.companion.stop();
    }
}

/// setValorantBoardKnownNames(hint), only when the list changed (app.js valorantKnownNamesSent).
pub fn send_known_names(core: &Core, board: Option<&isu_ocr::service::BoardService>, hint: &Value) {
    let Some(b) = board else { return };
    let key = hint.to_string();
    {
        let mut g = core.lock();
        if g.known_names_sent == key {
            return;
        }
        g.known_names_sent = key;
    }
    let list = |side: &str| -> Vec<String> { hint[side].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect() };
    b.set_known_names(&list("home"), &list("away"));
}

/// dispatchCompanionStageAction(action).
pub fn stage_action(d: &isu_net::displays::DisplayManager, a: &Value) -> Result<Value, (u16, String)> {
    let id = a.get("action").and_then(Value::as_str).unwrap_or("");
    let station_raw = a.get("station").filter(|v| !v.is_null() && v.as_str() != Some(""));
    let station = station_raw.map_or("all".to_string(), |v| isu_core::game_config::js_string(Some(v)));
    let shown = station_raw.filter(|v| truthy(Some(v))).map_or("all".to_string(), |v| isu_core::game_config::js_string(Some(v)));
    let st = |v: Option<&Value>| match v { None | Some(Value::Null) => String::new(), x => isu_core::game_config::js_string(x) };
    match id {
        "stage.display.mode" => {
            let r = d.set_mode(&station, &st(a.get("mode")), &st(a.get("source")));
            if r["ok"] != true { return Err((400, r["error"].as_str().unwrap_or("").into())); }
            Ok(json!({ "message": format!("Displays {shown}: {}", r["mode"].as_str().unwrap_or("")) }))
        }
        "stage.display.noise" => {
            let raw_v = a.get("on").filter(|v| !v.is_null()).or(a.get("state").filter(|v| !v.is_null()));
            let raw = raw_v.map_or("toggle".to_string(), |v| isu_core::game_config::js_string(Some(v))).to_lowercase();
            let on = if raw == "toggle" || raw == "keep" { json!(raw) } else { json!(["on", "true", "1", "start", "play"].contains(&raw.as_str())) };
            let r = d.set_noise(&station, &on, a.get("volume"));
            if r["ok"] != true { return Err((400, r["error"].as_str().unwrap_or("").into())); }
            Ok(json!({ "message": format!("Pink noise {shown}: {}", if r["on"] == true { "on" } else { "off" }) }))
        }
        _ => Err((404, format!("Unknown display action: {id}"))),
    }
}

/// A still picture as the capture source (grey PNG at x,y on a black 1920x1080 frame).
fn file_source(spec: &str) -> Option<Arc<dyn isu_ocr::capture::Source>> {
    let (path, at) = spec.split_once('@').unwrap_or((spec, "0,0"));
    let (ox, oy) = at.split_once(',').map(|(a, b)| (a.parse::<usize>().unwrap_or(0), b.parse::<usize>().unwrap_or(0))).unwrap_or((0, 0));
    let mut d = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(path).ok()?));
    d.set_transformations(png::Transformations::EXPAND);
    let mut r = d.read_info().ok()?;
    let mut buf = vec![0; r.output_buffer_size()?];
    let info = r.next_frame(&mut buf).ok()?;
    let ch = info.color_type.samples();
    let mut px = vec![0u8; 1920 * 1080 * 4];
    for y in 0..info.height as usize {
        for x in 0..info.width as usize {
            let g = buf[(y * info.width as usize + x) * ch];
            let (tx, ty) = (x + ox, y + oy);
            if tx < 1920 && ty < 1080 {
                let o = (ty * 1920 + tx) * 4;
                px[o..o + 4].copy_from_slice(&[g, g, g, 255]);
            }
        }
    }
    let frame = isu_ocr::capture::Bgra { w: 1920, h: 1080, px: Arc::new(px), source_w: 1920, source_h: 1080, normalized: false, source_name: path.to_string(), captured_at: std::time::Instant::now(), seq: 1 };
    struct Still(isu_ocr::capture::Bgra);
    impl isu_ocr::capture::Source for Still {
        fn capture(&self, _w: &str, _f: u32, _n: Option<u64>) -> Result<isu_ocr::capture::Bgra, String> {
            let mut f = self.0.clone();
            f.captured_at = std::time::Instant::now();
            Ok(f)
        }
    }
    Some(Arc::new(Still(frame)))
}

#[cfg(windows)]
fn make_source() -> Arc<dyn isu_ocr::capture::Source> {
    Arc::new(isu_ocr::capture::WgcSource::default())
}

#[cfg(not(windows))]
fn make_source() -> Arc<dyn isu_ocr::capture::Source> {
    struct NoCapture;
    impl isu_ocr::capture::Source for NoCapture {
        fn capture(&self, _w: &str, _fps: u32, _n: Option<u64>) -> Result<isu_ocr::capture::Bgra, String> {
            Err("Window capture needs Windows (Windows Graphics Capture)".into())
        }
    }
    Arc::new(NoCapture)
}
