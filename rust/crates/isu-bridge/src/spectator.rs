//! isu-net's Spectator trait on top of isu-ocr: window capture + SpectateTracker + 4 OCR engines
//! (one per name cleanup, like the JS 'spectate-lane-N' workers).
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use isu_net::bridge::Spectator;
use isu_ocr::board::Roi;
use isu_ocr::capture::{Bgra, Source};
use isu_ocr::icons::AgentMatcher;
use isu_ocr::spectate::{Portrait, PortraitMatcher, Tracker};
use isu_ocr::tess::Tess;
use serde_json::{Value, json};

pub struct Models {
    /// folder with eng.traineddata
    pub eng_dir: PathBuf,
    /// electron/ocr-models (val / ow)
    pub custom_dir: PathBuf,
    /// electron/ (agent icons + portraits)
    pub data_dir: PathBuf,
}

pub struct OcrSpectator {
    source: Arc<dyn Source>,
    tracker: Mutex<Tracker>,
    frame: Mutex<Option<Bgra>>,
    engines: Mutex<Vec<Tess>>,
    lang: Mutex<String>,
    models: Models,
    pub load_error: String,
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

impl OcrSpectator {
    pub fn new(source: Arc<dyn Source>, models: Models) -> Self {
        let mut t = Tracker::default();
        let mut err = String::new();
        match AgentMatcher::load(&models.data_dir) {
            Ok(a) => t.agents = Some(a),
            Err(e) => err = e.to_string(),
        }
        t.portraits = PortraitMatcher::load(&models.data_dir).ok();
        Self { source, tracker: Mutex::new(t), frame: Mutex::new(None), engines: Mutex::new(Vec::new()), lang: Mutex::new("eng".into()), models, load_error: err }
    }

    /// 4 engines for the current language (custom model if present, else English).
    fn ensure_engines(&self) -> Result<(), String> {
        let lang = self.lang.lock().unwrap().clone();
        let mut e = self.engines.lock().unwrap();
        if e.len() == 4 {
            return Ok(());
        }
        e.clear();
        let custom = lang != "eng" && self.models.custom_dir.join(format!("{lang}.traineddata")).exists();
        for _ in 0..4 {
            let t = if custom { Tess::new(&self.models.custom_dir, &lang) } else { Tess::new(&self.models.eng_dir, "eng") };
            e.push(t.map_err(|x| x.to_string())?);
        }
        Ok(())
    }
}

fn roi_of(v: &Value) -> Roi {
    let g = |k: &str| v[k].as_f64().unwrap_or(0.0) as i32;
    Roi { x: g("x"), y: g("y"), w: g("w"), h: g("h") }
}

impl Spectator for OcrSpectator {
    fn set_candidates(&self, list: &[Value], sides: &Value) {
        let mut t = self.tracker.lock().unwrap();
        t.set_candidates(list);
        t.set_sides(sides);
    }
    fn set_lang(&self, lang: &str) {
        let mut l = self.lang.lock().unwrap();
        if *l != lang {
            *l = lang.to_string();
            self.engines.lock().unwrap().clear();
        }
    }
    fn clear(&self) {
        self.tracker.lock().unwrap().clear();
    }
    fn next_frame(&self, window: &str, after: Option<u64>) -> Result<(u64, f64), String> {
        // spectate asks for 30 fps (captureFps: 30) and a frame newer than the last one
        let f = self.source.capture(window, 30, after)?;
        let seq = f.seq;
        *self.frame.lock().unwrap() = Some(f);
        Ok((seq, now_ms()))
    }
    fn portrait_step(&self, portrait: &Value) -> Option<(bool, Value)> {
        let f = self.frame.lock().unwrap().clone()?;
        let b = Portrait { x: portrait["x"].as_f64()?, y: portrait["y"].as_f64()?, s: portrait["s"].as_f64()? };
        self.tracker.lock().unwrap().portrait_step(&f, b, now_ms())
    }
    fn report_none(&self) -> (bool, Value) {
        self.tracker.lock().unwrap().report(None, now_ms())
    }
    fn name_step(&self, roi: &Value) -> (bool, Value) {
        let Some(f) = self.frame.lock().unwrap().clone() else { return self.report_none() };
        if self.ensure_engines().is_err() {
            return self.report_none();
        }
        // read_name only borrows the tracker immutably; take a snapshot of what it needs
        let winner = {
            let mut engines = self.engines.lock().unwrap();
            let t = self.tracker.lock().unwrap();
            t.read_name(&mut engines, &f, roi_of(roi))
        };
        self.tracker.lock().unwrap().report(winner, now_ms())
    }
    fn why_not(&self) -> String {
        if !self.load_error.is_empty() && self.tracker.lock().unwrap().agents.is_none() {
            return format!("AGENT ICONS NOT LOADED ({}): rebuild the Bridge from the latest commit", self.load_error);
        }
        self.tracker.lock().unwrap().why_not()
    }
    fn last(&self) -> Value {
        let t = self.tracker.lock().unwrap();
        match &t.last_portrait {
            Some(p) => json!({ "portrait": { "agent": p.agent, "candidate": p.candidate, "color": p.color, "side": p.side, "score": p.score, "player": p.player.as_ref().map(|(n, s)| json!({ "name": n, "station": s })) } }),
            None => json!({}),
        }
    }
}
