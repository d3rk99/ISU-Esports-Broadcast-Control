//! Overwatch scoreboard service: electron/overwatch-ocr-service.cjs OverwatchOcrService.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use isu_core::game_config::{js_round, js_string, to_number, truthy};
use serde_json::{Value, json};

use crate::board::Frame;
use crate::capture::{Bgra, Source};
use crate::overwatch::{self as ow, Align, Cell, Consensus, HeroMatcher, Profile, Read};
use crate::tess::Tess;

#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub enabled: bool,
    pub window_name: String,
    pub profile_id: String,
    pub interval_ms: u64,
    pub workers: usize,
    pub auto_align: bool,
    pub view: &'static str,
    pub box_scale: i64,
}

/// normalizeSettings(s).
pub fn normalize_settings(v: &Value) -> Settings {
    let num = |k: &str| to_number(v.get(k)).filter(|x| *x != 0.0);
    Settings {
        enabled: truthy(v.get("enabled")),
        window_name: v.get("windowName").filter(|x| truthy(Some(x))).map(|x| js_string(Some(x))).unwrap_or_else(|| "Overwatch".into()).chars().take(120).collect(),
        profile_id: v.get("profileId").filter(|x| truthy(Some(x))).map(|x| js_string(Some(x))).unwrap_or_else(|| "default-1080p".into()),
        interval_ms: js_round(num("intervalMs").unwrap_or(500.0)).clamp(200.0, 5000.0) as u64,
        workers: js_round(num("workers").unwrap_or(crate::service::default_workers() as f64)).clamp(1.0, 16.0) as usize,
        auto_align: v.get("autoAlign") != Some(&json!(false)),
        view: match v.get("view").and_then(Value::as_str) {
            Some("spectator") => "spectator",
            Some("player") => "player",
            _ => "auto",
        },
        box_scale: js_round(num("boxScale").unwrap_or(108.0)).clamp(80.0, 130.0) as i64,
    }
}

pub fn settings_json(s: &Settings) -> Value {
    json!({ "enabled": s.enabled, "windowName": s.window_name, "profileId": s.profile_id, "intervalMs": s.interval_ms, "workers": s.workers, "autoAlign": s.auto_align, "view": s.view, "boxScale": s.box_scale })
}

#[derive(Debug, Clone)]
pub struct Models {
    pub eng_dir: PathBuf,
    /// folder with ow.traineddata (electron/ocr-models)
    pub ow_dir: PathBuf,
    /// electron/ (profiles + hero templates)
    pub data_dir: PathBuf,
}

struct Worker {
    eng: Tess,
    ow: Option<Tess>,
}

pub type Callback = Box<dyn Fn(Value) + Send + Sync>;

struct Inner {
    settings: Settings,
    profile: Profile,
    board: Value,
    consensus: Consensus,
    overrides: HashMap<(String, usize), String>,
    status: Value,
    last_hero_at: Option<Instant>,
    workers: Vec<Worker>,
    sweeps: u64,
}

pub struct OverwatchService {
    inner: Mutex<Inner>,
    source: Arc<dyn Source>,
    models: Models,
    heroes: Option<HeroMatcher>,
    on_state: Callback,
    on_status: Callback,
    running: AtomicBool,
    loop_on: AtomicBool,
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// MIN_CONFIDENCE: score 0.75, text 0.6.
const MIN_SCORE: f64 = 0.75;
const MIN_TEXT: f64 = 0.6;

impl OverwatchService {
    pub fn new(source: Arc<dyn Source>, models: Models, on_state: Callback, on_status: Callback) -> anyhow::Result<Arc<Self>> {
        let profile = Profile::load(&models.data_dir, "default-1080p")?;
        Ok(Arc::new(Self {
            inner: Mutex::new(Inner {
                settings: normalize_settings(&json!({})),
                profile,
                board: ow::empty_board(),
                consensus: Consensus::default(),
                overrides: HashMap::new(),
                status: json!({ "state": "disabled", "message": "Overwatch OCR is off", "sweepMs": 0, "sweeps": 0 }),
                last_hero_at: None,
                workers: Vec::new(),
                sweeps: 0,
            }),
            source,
            heroes: HeroMatcher::load(&models.data_dir).ok(),
            models,
            on_state,
            on_status,
            running: AtomicBool::new(false),
            loop_on: AtomicBool::new(false),
        }))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

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

    pub fn snapshot(&self) -> Value {
        self.lock().board.clone()
    }

    pub fn configure(self: &Arc<Self>, next: &Value) -> Value {
        let (before, mut merged) = {
            let g = self.lock();
            (g.settings.clone(), settings_json(&g.settings))
        };
        for (k, v) in next.as_object().cloned().unwrap_or_default() {
            merged[k] = v;
        }
        let s = normalize_settings(&merged);
        if before.profile_id != s.profile_id {
            if let Ok(p) = Profile::load(&self.models.data_dir, &s.profile_id) {
                self.lock().profile = p;
            }
            self.lock().settings = s.clone();
            self.clear();
        } else {
            self.lock().settings = s.clone();
        }
        if s.enabled { self.start() } else { self.stop() }
        self.status()
    }

    fn start(self: &Arc<Self>) {
        if self.loop_on.swap(true, Ordering::AcqRel) {
            return;
        }
        let w = self.lock().settings.window_name.clone();
        self.set_status("starting", &format!("Looking for the “{w}” window"), json!({}));
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            while me.loop_on.load(Ordering::Acquire) && me.lock().settings.enabled {
                let started = Instant::now();
                if let Err(e) = me.sweep() {
                    me.set_status("error", &e, json!({}));
                }
                std::thread::sleep(Duration::from_millis(me.lock().settings.interval_ms).saturating_sub(started.elapsed()));
            }
            me.loop_on.store(false, Ordering::Release);
        });
    }

    pub fn stop(&self) {
        self.loop_on.store(false, Ordering::Release);
        if self.lock().status["state"] != "disabled" {
            self.set_status("disabled", "Overwatch OCR is off", json!({}));
        }
    }

    pub fn shutdown(&self) {
        self.lock().settings.enabled = false;
        self.stop();
    }

    pub fn clear(&self) {
        {
            let mut g = self.lock();
            g.board = ow::empty_board();
            g.consensus.reset();
            g.overrides.clear();
        }
        (self.on_state)(self.snapshot());
    }

    /// setPlayerName({ side, row, name }).
    pub fn set_player_name(&self, side: &str, row: f64, name: &str) -> Result<Value, String> {
        if side != "home" && side != "away" {
            return Err("side must be home or away".into());
        }
        let r = js_round(row);
        if !(0.0..=4.0).contains(&r) {
            return Err("row must be 0-4".into());
        }
        let r = r as usize;
        // JS: .replace(/\s+/g, ' ').trim().slice(0, 24) (24 UTF-16 units)
        let joined = name.split_whitespace().collect::<Vec<_>>().join(" ");
        let clean = String::from_utf16_lossy(&joined.encode_utf16().take(24).collect::<Vec<u16>>());
        {
            let mut g = self.lock();
            let now = now_ms();
            if clean.is_empty() {
                g.overrides.remove(&(side.to_string(), r));
            } else {
                g.overrides.insert((side.to_string(), r), clean.clone());
            }
            let p = &mut g.board["teams"][side]["players"][r];
            p["name"] = json!(clean);
            p["nameManual"] = json!(!clean.is_empty());
            p["updatedAt"] = isu_core::game_config::jnum(now);
            g.board["updatedAt"] = isu_core::game_config::jnum(now);
        }
        let s = self.snapshot();
        (self.on_state)(s.clone());
        Ok(s)
    }

    fn ensure_workers(&self, g: &mut Inner) -> Result<(), String> {
        while g.workers.len() < g.settings.workers {
            let eng = Tess::new(&self.models.eng_dir, "eng").map_err(|e| e.to_string())?;
            let owm = self.models.ow_dir.join("ow.traineddata").exists().then(|| Tess::new(&self.models.ow_dir, "ow").ok()).flatten();
            g.workers.push(Worker { eng, ow: owm });
        }
        let n = g.settings.workers;
        g.workers.truncate(n);
        Ok(())
    }

    /// debugCapture(): one frame, every cell with its crop, the OCR text, confidence, digits seen and
    /// the accepted value, the align result and the hero matches (overwatch-ocr-service.cjs).
    pub fn debug_capture(&self) -> Result<Value, String> {
        let window = self.lock().settings.window_name.clone();
        let frame: Bgra = self.source.capture(&window, 8, None)?;
        let mut g = self.lock();
        let p = g.profile.clone();
        if frame.w as i32 != p.width || frame.h as i32 != p.height {
            return Err(format!("Captured frame is {}x{} but the OCR boxes are for {}x{}; use a 16:9 window", frame.w, frame.h, p.width, p.height));
        }
        let mut align: Option<Align> = g.settings.auto_align.then(|| ow::align_board(&frame, &p, true));
        if let Some(a) = align.as_mut() {
            if g.settings.view != "auto" && a.view != g.settings.view {
                ow::view_fallback(&p, a, g.settings.view);
            }
        }
        let cells = ow::cell_rois(&p, align.as_ref(), Some(g.settings.box_scale as f64 / 100.0));
        self.ensure_workers(&mut g)?;
        let left = align.as_ref().map_or(0, |a| a.left_dx);
        let mut out = Vec::new();
        for cell in &cells {
            let w = &mut g.workers[0];
            let text = cell.field == "name";
            let thr = match cell.column.threshold { Some(t) if t != 120 => 255 - t, _ => 120 };
            let img = ow::cell_image(&frame, cell.roi, p.pre_scale, thr, cell.column.shear);
            let tess = match (&cell.column.lang, w.ow.as_mut()) { (Some(l), Some(t)) if l == "ow" => t, _ => &mut w.eng };
            let r = tess.recognize(&img, &cell.column.allowed, false);
            let side = p.teams[cell.team].0.clone();
            let cy = cell.roi.y + cell.roi.h / 2;
            let ready = cell.field == "ultimate" && ow::is_ready_disc(&frame, p.ring_cx + f64::from(left), f64::from(cy) + p.ring_dy, p.ready_radius);
            let accepted = if ready { Some(json!("READY")) } else { Self::read_cell(w, &frame, &p, cell) };
            out.push(json!({
                "side": side, "row": cell.row, "field": cell.field,
                "roi": { "x": cell.roi.x, "y": cell.roi.y, "w": cell.roi.w, "h": cell.roi.h },
                "rawDataUrl": crop_png(&frame, cell.roi), "processedDataUrl": gray_png(&img),
                "text": r.text.trim(), "confidence": (r.confidence * 100.0).round(),
                "glyphs": if text { Value::Null } else { json!(ow::glyph_count(&frame, cell.roi)) },
                "accepted": accepted.unwrap_or(Value::Null)
            }));
        }
        drop(g);
        let mut heroes = Vec::new();
        if let Some(hm) = &self.heroes {
            for (ti, (side, centers)) in p.teams.iter().enumerate() {
                for (row, &cy) in centers.iter().enumerate() {
                    let dy = align.as_ref().map_or(0, |a| a.rows[ti][row].stat_dy);
                    let m = hm.match_row(&frame, cy + if dy.abs() >= 3 { dy } else { 0 }, left);
                    heroes.push(json!({ "side": side, "row": row, "hero": m.hero, "candidate": m.candidate, "score": m.score, "runnerUp": m.runner_up }));
                }
            }
        }
        let align_json = align.as_ref().map(|a| {
            let mut rows = serde_json::Map::new();
            for (ti, (side, _)) in p.teams.iter().enumerate() {
                for (row, ra) in a.rows[ti].iter().enumerate() {
                    rows.insert(format!("{side}:{row}"), json!({ "statDy": ra.stat_dy, "nameDy": ra.name_dy }));
                }
            }
            let cols = a.cols.as_ref().map(|h| Value::Object(h.cols.iter().map(|(k, v)| (k.clone(), json!(v))).collect()));
            json!({ "dx": a.dx, "leftDx": a.left_dx, "perks": a.perks, "view": a.view, "forced": a.forced, "cols": cols, "rows": rows })
        });
        Ok(json!({
            "heroes": heroes, "align": align_json, "capturedAt": isu_core::game_config::jnum(now_ms()),
            "sourceName": frame.source_name, "backend": "wgc", "width": frame.w, "height": frame.h,
            "sourceWidth": frame.source_w, "sourceHeight": frame.source_h, "frameDataUrl": frame_png(&frame), "cells": out
        }))
    }

    /// readCell(frame, profile, cell).
    fn read_cell(w: &mut Worker, f: &dyn Frame, p: &Profile, cell: &Cell) -> Option<Value> {
        let text = cell.field == "name";
        let glyphs = (!text).then(|| ow::glyph_count(f, cell.roi));
        if glyphs == Some(0) {
            return None;
        }
        // OCR input as the JS accuracy tests build it (test/overwatch-ocr.test.cjs cellImageFrom with
        // the service's preprocess): `255 - lum < t` is ink, t = 255 - column threshold (names: 185
        // -> 70) or 120 for the profile default. Electron's live crop differs (see board::cell_image).
        let scale0 = p.pre_scale;
        let thr = match cell.column.threshold {
            Some(t) if t != 120 => 255 - t,
            _ => 120,
        };
        let tess = match (&cell.column.lang, w.ow.as_mut()) {
            (Some(l), Some(t)) if l == "ow" => t,
            _ => &mut w.eng,
        };
        let mut attempt = |scale: i32, single: bool| -> Option<Value> {
            let img = ow::cell_image(f, cell.roi, scale, thr, cell.column.shear);
            let r = tess.recognize(&img, &cell.column.allowed, single);
            if r.confidence < if text { MIN_TEXT } else { MIN_SCORE } {
                return None;
            }
            ow::plausible(&cell.field, ow::parse_cell(&cell.field, &r.text), glyphs)
        };
        let mut v = attempt(scale0, false);
        if v.is_none() && !text && glyphs == Some(1) {
            for scale in [4, 6] {
                v = attempt(scale, true);
                if v.is_some() {
                    break;
                }
            }
        }
        v
    }

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
        let mut g = self.lock();
        let p = g.profile.clone();
        if frame.w as i32 != p.width || frame.h as i32 != p.height {
            return Err(format!("Captured frame is {}x{} but the OCR boxes are for {}x{}; use a 16:9 window", frame.w, frame.h, p.width, p.height));
        }
        let mut align: Option<Align> = g.settings.auto_align.then(|| ow::align_board(&frame, &p, true));
        if let Some(a) = align.as_mut() {
            if g.settings.view != "auto" && a.view != g.settings.view {
                ow::view_fallback(&p, a, g.settings.view);
            }
        }
        let t_align = started.elapsed();
        let cells = ow::cell_rois(&p, align.as_ref(), Some(g.settings.box_scale as f64 / 100.0));
        self.ensure_workers(&mut g)?;
        let n = g.workers.len().max(1);
        let mut values: Vec<Option<Value>> = vec![None; cells.len()];
        {
            let (workers, fr, cl, pr) = (&mut g.workers, &frame, &cells, &p);
            std::thread::scope(|s| {
                let hs: Vec<_> = workers.iter_mut().enumerate().map(|(wi, w)| s.spawn(move || cl.iter().enumerate().filter(|(i, _)| i % n == wi).map(|(i, c)| (i, Self::read_cell(w, fr, pr, c))).collect::<Vec<_>>())).collect();
                for h in hs {
                    for (i, v) in h.join().unwrap() {
                        values[i] = v;
                    }
                }
            });
        }
        let t_ocr = started.elapsed();
        let mut reads: Vec<Read> = cells.iter().zip(values).map(|(c, v)| Read { side: p.teams[c.team].0.clone(), row: c.row, field: c.field.clone(), value: v }).collect();
        // ult: READY disc wins, else the ring when the number is unreadable
        let left = align.as_ref().map_or(0, |a| a.left_dx);
        for (ti, (side, centers)) in p.teams.iter().enumerate() {
            for (row, &cy0) in centers.iter().enumerate() {
                let dy = align.as_ref().map_or(0, |a| a.rows[ti][row].stat_dy);
                let cy = f64::from(cy0 + if dy.abs() >= 3 { dy } else { 0 });
                let rcx = p.ring_cx + f64::from(left);
                let Some(read) = reads.iter_mut().find(|r| &r.side == side && r.row == row && r.field == "ultimate") else { continue };
                if ow::is_ready_disc(&frame, rcx, cy + p.ring_dy, p.ready_radius) {
                    read.value = Some(json!("READY"));
                    continue;
                }
                if read.value.is_some() {
                    continue;
                }
                read.value = ow::resolve_ultimate(None, ow::ring_fill(&frame, rcx, cy + p.ring_dy, p.ring_radius));
            }
        }
        if g.last_hero_at.is_none_or(|t| t.elapsed() >= Duration::from_millis(900)) {
            if let Some(hm) = &self.heroes {
                // The 10 rows are independent: match them in parallel (same math, same order of results).
                let jobs: Vec<(String, usize, i32)> = p.teams.iter().enumerate().flat_map(|(ti, (side, centers))| {
                    let al = align.as_ref();
                    centers.iter().enumerate().map(move |(row, &cy)| {
                        let dy = al.map_or(0, |a| a.rows[ti][row].stat_dy);
                        (side.clone(), row, cy + if dy.abs() >= 3 { dy } else { 0 })
                    })
                }).collect();
                let fr = &frame;
                let found: Vec<Read> = std::thread::scope(|s| {
                    let hs: Vec<_> = jobs.iter().map(|(side, row, cy)| s.spawn(move || Read { side: side.clone(), row: *row, field: "hero".into(), value: hm.match_row(fr, *cy, left).hero.map(Value::String) })).collect();
                    hs.into_iter().map(|h| h.join().unwrap()).collect()
                });
                reads.extend(found);
            }
            g.last_hero_at = Some(Instant::now());
        }
        if std::env::var_os("ISU_OW_TIMING").is_some() {
            eprintln!("ow sweep: align {:.1} ms, ocr {:.1} ms, rings+heroes {:.1} ms", t_align.as_secs_f64() * 1e3, (t_ocr - t_align).as_secs_f64() * 1e3, (started.elapsed() - t_ocr).as_secs_f64() * 1e3);
        }
        let filtered: Vec<Read> = reads.iter().filter(|r| !(r.field == "name" && g.overrides.contains_key(&(r.side.clone(), r.row)))).cloned().collect();
        let now = now_ms();
        let Inner { board, consensus, .. } = &mut *g;
        let changed = ow::apply_sweep(board, consensus, &filtered, now);
        g.sweeps += 1;
        let sweeps = g.sweeps;
        drop(g);
        let seen = reads.iter().filter(|r| r.value.is_some()).count();
        let layout = align.as_ref().map_or(String::new(), |a| {
            let v = match a.view {
                "player" => "player view (own stat card)",
                "spectator" => "spectator view",
                _ => "layout not found, default boxes",
            };
            format!(" · {v}{}", if a.perks { " · perks" } else { "" })
        });
        let extra = json!({ "sweepMs": started.elapsed().as_millis() as u64, "sweeps": sweeps, "lastSweepAt": isu_core::game_config::jnum(now) });
        if seen > 0 {
            self.set_status("reading", &format!("Reading {seen}/{} cells{layout}", reads.len()), extra);
        } else {
            self.set_status("no-board", "Window found but no scoreboard visible (is Tab open on this spectator?)", extra);
        }
        if changed {
            (self.on_state)(self.snapshot());
        }
        Ok(changed)
    }
}

fn png_data_url(w: u32, h: u32, color: png::ColorType, data: &[u8]) -> String {
    let mut buf = Vec::new();
    {
        let mut e = png::Encoder::new(&mut buf, w, h);
        e.set_color(color);
        e.set_depth(png::BitDepth::Eight);
        if let Ok(mut wr) = e.write_header() {
            let _ = wr.write_image_data(data);
        }
    }
    use base64::Engine;
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(buf))
}

/// The whole captured frame (BGRA -> RGB PNG).
fn frame_png(f: &Bgra) -> String {
    let rgb: Vec<u8> = f.px.chunks(4).flat_map(|p| [p[2], p[1], p[0]]).collect();
    png_data_url(f.w, f.h, png::ColorType::Rgb, &rgb)
}

/// One cell's raw crop.
fn crop_png(f: &Bgra, r: crate::board::Roi) -> String {
    let (x0, y0) = (r.x.max(0) as u32, r.y.max(0) as u32);
    let (w, h) = ((r.w.max(1) as u32).min(f.w.saturating_sub(x0)), (r.h.max(1) as u32).min(f.h.saturating_sub(y0)));
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for y in y0..y0 + h {
        for x in x0..x0 + w {
            let i = ((y * f.w + x) * 4) as usize;
            rgb.extend_from_slice(&[f.px[i + 2], f.px[i + 1], f.px[i]]);
        }
    }
    png_data_url(w, h, png::ColorType::Rgb, &rgb)
}

/// The black/white image the OCR reads.
fn gray_png(g: &crate::tess::Gray) -> String {
    png_data_url(g.w as u32, g.h as u32, png::ColorType::Grayscale, &g.px)
}
