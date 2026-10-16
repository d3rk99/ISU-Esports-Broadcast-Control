//! VALORANT scoreboard service: electron/valorant-board-service.cjs ValorantBoardService.
//! Every interval: capture the window, read the top HUD (score + timer), find the board, OCR every
//! cell on a worker pool, match agents / guns / shields, remap rows to players, consensus, publish.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::board::{self, Cell, Frame, Ocr, Roi};
use crate::capture::{Bgra, Source};
use crate::consensus::{Consensus, Identity, Read, SIDE_NAMES, apply_sweep, empty_board};
use crate::hud::HudReader;
use crate::icons::{AgentMatcher, GearMatcher};
use crate::tess::Tess;

#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub enabled: bool,
    pub window_name: String,
    pub interval_ms: u64,
    pub workers: usize,
}

/// DEFAULT_WORKERS: max(2, min(8, floor(cpus / 2))).
pub fn default_workers() -> usize {
    let cpus = std::thread::available_parallelism().map(usize::from).unwrap_or(4);
    (cpus / 2).clamp(2, 8)
}

/// normalizeSettings(s).
pub fn normalize_settings(v: &Value) -> Settings {
    let num = |k: &str| isu_core::game_config::to_number(v.get(k)).filter(|x| *x != 0.0);
    let window = v.get("windowName").filter(|x| isu_core::game_config::truthy(Some(x))).map(|x| isu_core::game_config::js_string(Some(x))).unwrap_or_else(|| "VALORANT".into());
    Settings {
        enabled: isu_core::game_config::truthy(v.get("enabled")),
        window_name: window.chars().take(120).collect(),
        interval_ms: isu_core::game_config::js_round(num("intervalMs").unwrap_or(500.0)).clamp(200.0, 5000.0) as u64,
        workers: isu_core::game_config::js_round(num("workers").unwrap_or(default_workers() as f64)).clamp(1.0, 16.0) as usize,
    }
}

pub fn settings_json(s: &Settings) -> Value {
    json!({ "enabled": s.enabled, "windowName": s.window_name, "intervalMs": s.interval_ms, "workers": s.workers })
}

/// Model locations: eng = tesseract.js's eng (unpacked) or any tessdata folder with eng.traineddata,
/// val = electron/ocr-models (val.traineddata), templates = electron/.
#[derive(Debug, Clone)]
pub struct Models {
    pub eng_dir: PathBuf,
    pub val_dir: PathBuf,
    pub templates_dir: PathBuf,
}

struct Worker {
    eng: Tess,
    val: Option<Tess>,
}
impl Ocr for Worker {
    fn tess(&mut self, lang: Option<&str>) -> &mut Tess {
        // customLangAvailable: no val model -> English
        match (lang, self.val.as_mut()) {
            (Some("val"), Some(v)) => v,
            _ => &mut self.eng,
        }
    }
}

pub type Callback = Box<dyn Fn(Value) + Send + Sync>;

struct Inner {
    settings: Settings,
    board: Value,
    consensus: Consensus,
    identity: Identity,
    name_overrides: std::collections::HashMap<(usize, usize), String>,
    status: Value,
    m: MatchState,
    score_votes: [Vec<Option<u32>>; 2],
    last_align: Option<(bool, i32, i32)>,
    workers: Vec<Worker>,
    sweeps: u64,
}

#[derive(Debug, Clone, Default)]
struct MatchState {
    home: Option<u32>,
    away: Option<u32>,
    timer: Option<crate::hud::Timer>,
    spike: bool,
    updated_at: f64,
}

impl MatchState {
    fn to_json(&self) -> Value {
        json!({
            "homeScore": self.home, "awayScore": self.away,
            "timer": self.timer.as_ref().map(|t| json!({ "seconds": isu_core::game_config::jnum(t.seconds), "display": t.display, "lowTime": t.low_time })),
            "spikePlanted": self.spike, "updatedAt": isu_core::game_config::jnum(self.updated_at)
        })
    }
}

pub struct BoardService {
    inner: Mutex<Inner>,
    source: Arc<dyn Source>,
    models: Models,
    agents: Option<AgentMatcher>,
    gear: Option<GearMatcher>,
    hud: Option<HudReader>,
    on_state: Callback,
    on_status: Callback,
    running: AtomicBool,
    loop_on: Arc<AtomicBool>,
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

impl BoardService {
    pub fn new(source: Arc<dyn Source>, models: Models, on_state: Callback, on_status: Callback) -> Arc<Self> {
        let t = &models.templates_dir;
        Arc::new(Self {
            inner: Mutex::new(Inner {
                settings: normalize_settings(&json!({})),
                board: empty_board(),
                consensus: Consensus::default(),
                identity: Identity::default(),
                name_overrides: Default::default(),
                status: json!({ "state": "disabled", "message": "VALORANT scoreboard OCR is off", "sweepMs": 0, "sweeps": 0 }),
                m: MatchState::default(),
                score_votes: [Vec::new(), Vec::new()],
                last_align: None,
                workers: Vec::new(),
                sweeps: 0,
            }),
            source,
            agents: AgentMatcher::load(t).ok(),
            gear: GearMatcher::load(t).ok(),
            hud: HudReader::load(t).ok(),
            models,
            on_state,
            on_status,
            running: AtomicBool::new(false),
            loop_on: Arc::new(AtomicBool::new(false)),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// getStatus(): status + settings.
    pub fn status(&self) -> Value {
        let g = self.lock();
        let mut s = g.status.clone();
        s["settings"] = settings_json(&g.settings);
        s
    }

    fn set_status(&self, state: &str, message: &str, extra: Value) {
        {
            let mut g = self.lock();
            g.status["state"] = json!(state);
            g.status["message"] = json!(message);
            for (k, v) in extra.as_object().cloned().unwrap_or_default() {
                g.status[k] = v;
            }
        }
        (self.on_status)(self.status());
    }

    /// configure(next): merge, then start or stop the loop.
    pub fn configure(self: &Arc<Self>, next: &Value) -> Value {
        let mut merged = settings_json(&self.lock().settings);
        for (k, v) in next.as_object().cloned().unwrap_or_default() {
            merged[k] = v;
        }
        let s = normalize_settings(&merged);
        self.lock().settings = s.clone();
        if s.enabled { self.start() } else { self.stop() }
        self.status()
    }

    fn start(self: &Arc<Self>) {
        if self.loop_on.swap(true, Ordering::AcqRel) {
            return;
        }
        let w = self.lock().settings.window_name.clone();
        self.set_status("starting", &format!("Looking for the \"{w}\" window"), json!({}));
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            while me.loop_on.load(Ordering::Acquire) && me.lock().settings.enabled {
                let started = Instant::now();
                if let Err(e) = me.sweep() {
                    me.set_status("error", &e, json!({}));
                }
                let iv = Duration::from_millis(me.lock().settings.interval_ms);
                std::thread::sleep(iv.saturating_sub(started.elapsed()));
            }
            me.loop_on.store(false, Ordering::Release);
        });
    }

    pub fn stop(&self) {
        self.loop_on.store(false, Ordering::Release);
        if !self.lock().settings.enabled {
            self.set_status("disabled", "VALORANT scoreboard OCR is off", json!({}));
        }
    }

    pub fn shutdown(&self) {
        self.lock().settings.enabled = false;
        self.stop();
        self.source.stop();
    }

    /// clear(): everything back to empty.
    pub fn clear(&self) {
        {
            let mut g = self.lock();
            g.m = MatchState::default();
            g.score_votes = [Vec::new(), Vec::new()];
            g.board = empty_board();
            g.consensus = Consensus::default();
            g.name_overrides.clear();
            g.identity.reset();
        }
        (self.on_state)(self.snapshot());
    }

    pub fn set_known_names(&self, home: &[String], away: &[String]) {
        self.lock().identity.set_known_names(home, away);
    }

    /// setPlayerName({ side, row, name }): operator name for one slot ('' clears).
    pub fn set_player_name(&self, side: &str, row: i64, name: &str) -> Result<Value, String> {
        let s = SIDE_NAMES.iter().position(|x| *x == side).ok_or("side must be home or away")?;
        if !(0..=4).contains(&row) {
            return Err("row must be 0-4".into());
        }
        let r = row as usize;
        let clean: String = name.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(32).collect();
        {
            let mut g = self.lock();
            let now = now_ms();
            let p = &mut g.board["teams"][side]["players"][r];
            p["name"] = json!(clean);
            p["nameManual"] = json!(!clean.is_empty());
            p["updatedAt"] = isu_core::game_config::jnum(now);
            g.board["updatedAt"] = isu_core::game_config::jnum(now);
            if clean.is_empty() {
                g.name_overrides.remove(&(s, r));
                g.identity.clear_tag(s, r);
            } else {
                g.name_overrides.insert((s, r), clean.clone());
                g.identity.confirm(s, r, &clean);
            }
        }
        let snap = self.snapshot();
        (self.on_state)(snap.clone());
        Ok(snap)
    }

    /// snapshot(): board + match + status + align.
    pub fn snapshot(&self) -> Value {
        let mut s = self.lock().board.clone();
        let g = self.lock();
        s["match"] = g.m.to_json();
        drop(g);
        s["status"] = self.status();
        let g = self.lock();
        s["align"] = g.last_align.map_or(Value::Null, |(found, dx, dy)| json!({ "dx": dx, "dy": dy, "found": found }));
        s
    }

    fn ensure_workers(&self, g: &mut Inner) -> Result<(), String> {
        let want = g.settings.workers;
        while g.workers.len() < want {
            let eng = Tess::new(&self.models.eng_dir, "eng").map_err(|e| e.to_string())?;
            let val = self.models.val_dir.join("val.traineddata").exists().then(|| Tess::new(&self.models.val_dir, "val").ok()).flatten();
            g.workers.push(Worker { eng, val });
        }
        g.workers.truncate(want);
        Ok(())
    }

    /// readHud(lum): score needs 2 matching reads in a row; timer passed through; spike = score, no timer.
    fn read_hud(&self, f: &dyn Frame, g: &mut Inner) -> bool {
        let Some(hud) = &self.hud else { return false };
        let r = hud.read(f, 0, 0);
        let before = (g.m.home, g.m.away, g.m.timer.clone(), g.m.spike);
        for (side, v) in [(0, r.home_score), (1, r.away_score)] {
            let votes = &mut g.score_votes[side];
            votes.push(v);
            if votes.len() > 2 {
                votes.remove(0);
            }
            if v.is_some() && votes.len() == 2 && votes[0] == v {
                if side == 0 { g.m.home = v } else { g.m.away = v }
            }
        }
        g.m.spike = r.timer.is_none() && r.home_score.is_some() && r.away_score.is_some();
        g.m.timer = r.timer;
        if (g.m.home, g.m.away, g.m.timer.clone(), g.m.spike) != before {
            g.m.updated_at = now_ms();
            return true;
        }
        false
    }

    /// sweep(): one full read. Ok(changed).
    pub fn sweep(&self) -> Result<bool, String> {
        if self.running.swap(true, Ordering::AcqRel) {
            return Ok(false);
        }
        let r = self.sweep_inner();
        self.running.store(false, Ordering::Release);
        r
    }

    fn sweep_inner(&self) -> Result<bool, String> {
        let started = Instant::now();
        let window = self.lock().settings.window_name.clone();
        let frame: Bgra = self.source.capture(&window, 8, None)?;
        if frame.w != 1920 || frame.h != 1080 {
            return Err(format!("Captured frame is {}x{}; the board reader needs a 16:9 window (scaled to 1920x1080)", frame.w, frame.h));
        }
        let mut g = self.lock();
        let match_changed = self.read_hud(&frame, &mut g);
        let align = board::align_board(&frame);
        g.last_align = Some((align.found, align.dx, align.dy));
        let sweeps = g.sweeps + 1;
        g.sweeps = sweeps;
        if !align.found {
            drop(g);
            if match_changed {
                (self.on_state)(self.snapshot());
            }
            self.set_status("no-board", "Window found but no scoreboard visible (is Tab open on Observer 3?)", json!({ "sweepMs": started.elapsed().as_millis() as u64, "sweeps": sweeps }));
            return Ok(false);
        }
        self.ensure_workers(&mut g)?;
        let cells: Vec<Cell> = board::cell_rois(&align);
        let n = g.workers.len().max(1);
        // OCR lanes: cells round-robin over the workers, in parallel threads
        let mut values: Vec<Option<board::Value>> = vec![None; cells.len()];
        {
            let workers = &mut g.workers;
            let fr = &frame;
            let cl = &cells;
            std::thread::scope(|s| {
                let hs: Vec<_> = workers.iter_mut().enumerate().map(|(wi, w)| s.spawn(move || cl.iter().enumerate().filter(|(i, _)| i % n == wi).map(|(i, c)| (i, board::read_cell(w, fr, *c))).collect::<Vec<_>>())).collect();
                for h in hs {
                    for (i, v) in h.join().unwrap() {
                        values[i] = v;
                    }
                }
            });
        }
        let mut reads: Vec<Read> = cells.iter().zip(values).map(|(c, v)| Read { side: c.side, row: c.row, field: c.field, value: v.map(|x| x.to_json()), board_row: None }).collect();
        for side in 0..2 {
            for row in 0..5 {
                let cy = align.rows[side][row];
                if let Some(a) = &self.agents {
                    reads.push(Read { side, row, field: "agent", value: a.match_at(&frame, board::AGENT.x + 16 + align.dx, cy).agent.map(Value::String), board_row: None });
                }
                if let Some(gm) = &self.gear {
                    let w = gm.weapon(&frame, Roi { x: board::LOADOUT.x + align.dx, y: cy - 12, w: board::LOADOUT.w, h: 24 });
                    reads.push(Read { side, row, field: "weapon", value: w.name.map(Value::String), board_row: None });
                    let sh = gm.shield(&frame, board::SHIELD.x + align.dx, board::SHIELD.x + board::SHIELD.w + align.dx, cy);
                    reads.push(Read { side, row, field: "shield", value: sh.name.map(Value::String), board_row: None });
                }
            }
        }
        let now = now_ms();
        g.identity.remap(&mut reads);
        let Inner { board: bd, consensus, .. } = &mut *g;
        let changed = apply_sweep(bd, consensus, &reads, now);
        let colors = [board::block_color(&frame, &align, 0), board::block_color(&frame, &align, 1)];
        if !g.board.get("colors").is_some_and(Value::is_object) {
            g.board["colors"] = json!({ "home": "", "away": "" });
        }
        for (s, c) in colors.iter().enumerate() {
            if !c.is_empty() {
                g.board["colors"][SIDE_NAMES[s]] = json!(c);
            }
        }
        for side in 0..2 {
            for slot in 0..5 {
                let name = g.board["teams"][SIDE_NAMES[side]]["players"][slot]["name"].as_str().unwrap_or("").to_string();
                g.identity.confirm(side, slot, &name);
                let row = g.identity.row_of(side, slot);
                let p = &mut g.board["teams"][SIDE_NAMES[side]]["players"][slot];
                if p["row"] != json!(row) {
                    p["row"] = json!(row);
                    p["updatedAt"] = isu_core::game_config::jnum(now);
                }
            }
        }
        let moved = !g.identity.last_moves.is_empty();
        let seen = reads.iter().filter(|r| r.value.is_some()).count();
        let total = reads.len();
        drop(g);
        let sign = |v: i32| if v >= 0 { format!("+{v}") } else { v.to_string() };
        self.set_status("reading", &format!("Reading {seen}/{total} cells · board {}/{} px", sign(align.dx), sign(align.dy)), json!({ "sweepMs": started.elapsed().as_millis() as u64, "sweeps": sweeps, "lastSweepAt": isu_core::game_config::jnum(now) }));
        let any = changed || match_changed || moved;
        if any {
            (self.on_state)(self.snapshot());
        }
        Ok(any)
    }
}

/// Default model locations for a dev checkout (repo = the folder with electron/ and node_modules/).
pub fn dev_models(repo: &Path, cache: &Path) -> anyhow::Result<Models> {
    let eng_dir = crate::tess::unpack_gz_model(&repo.join("node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz"), cache, "eng")?;
    Ok(Models { eng_dir, val_dir: repo.join("electron/ocr-models"), templates_dir: repo.join("electron") })
}
