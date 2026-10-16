//! VALORANT top HUD (round score + round timer): electron/valorant-hud-reader.cjs HudReader,
//! digit templates from electron/valorant-hud-digits.json.
use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;

use crate::board::{Frame, Roi};

pub const HOME_SCORE: Roi = Roi { x: 800, y: 32, w: 100, h: 30 };
pub const TIMER: Roi = Roi { x: 912, y: 26, w: 100, h: 40 };
pub const AWAY_SCORE: Roi = Roi { x: 1020, y: 32, w: 100, h: 30 };

#[derive(Debug, Clone, PartialEq)]
pub struct Timer {
    pub seconds: f64,
    pub display: String,
    pub low_time: bool,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Hud {
    pub home_score: Option<u32>,
    pub away_score: Option<u32>,
    pub timer: Option<Timer>,
}

struct Glyph {
    x0: i32,
    x1: i32,
    y0: i32,
    y1: i32,
}

pub struct HudReader {
    w: usize,
    h: usize,
    score: Vec<(String, Vec<u8>)>,
    timer: Vec<(String, Vec<u8>)>,
}

impl HudReader {
    pub fn load(dir: &Path) -> anyhow::Result<Self> {
        let d: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("valorant-hud-digits.json"))?)?;
        let set = |k: &str| -> Vec<(String, Vec<u8>)> {
            d[k].as_array().unwrap().iter().map(|t| (crate_js_string(&t["d"]), t["m"].as_str().unwrap().bytes().map(|c| u8::from(c == b'1')).collect())).collect()
        };
        Ok(Self { w: d["w"].as_u64().unwrap() as usize, h: d["h"].as_u64().unwrap() as usize, score: set("score"), timer: set("timer") })
    }

    /// glyphs(lum, roi, thr = 122).
    fn glyphs(f: &dyn Frame, roi: Roi, thr: u8) -> Vec<Glyph> {
        let ink = |x, y| f.lum(x, y) >= thr;
        let mut runs = Vec::new();
        let mut s = -1;
        for x in roi.x..=roi.x + roi.w {
            let on = x < roi.x + roi.w && (roi.y..roi.y + roi.h).any(|y| ink(x, y));
            if on && s < 0 {
                s = x;
            }
            if !on && s >= 0 {
                let (mut y0, mut y1) = (i32::MAX, -1);
                for y in roi.y..roi.y + roi.h {
                    for xx in s..x {
                        if ink(xx, y) {
                            y0 = y0.min(y);
                            y1 = y1.max(y);
                        }
                    }
                }
                runs.push(Glyph { x0: s, x1: x, y0, y1: y1 + 1 });
                s = -1;
            }
        }
        if runs.is_empty() {
            return runs;
        }
        let hmax = runs.iter().map(|r| r.y1 - r.y0).max().unwrap();
        if hmax < 10 {
            return Vec::new();
        }
        let hf = f64::from(hmax);
        runs.into_iter().filter(|r| f64::from(r.y1 - r.y0) >= hf * 0.8 && r.x1 - r.x0 >= 4 && f64::from(r.x1 - r.x0) <= hf * 0.9).collect()
    }

    /// cell(lum, b, thr): scaled by height, centred in a w x h cell.
    fn cell(&self, f: &dyn Frame, b: &Glyph, thr: u8) -> Vec<u8> {
        let (bh, bw) = (b.y1 - b.y0, b.x1 - b.x0);
        let nw = (((f64::from(bw) * self.h as f64 / f64::from(bh)) + 0.5).floor() as i64).clamp(1, self.w as i64) as usize;
        let off = (self.w - nw) / 2;
        let mut out = vec![0u8; self.w * self.h];
        for j in 0..self.h {
            for i in 0..nw {
                let sx = b.x0 + ((bw - 1).min(((i as f64 + 0.5) * f64::from(bw) / nw as f64).floor() as i32));
                let sy = b.y0 + ((bh - 1).min(((j as f64 + 0.5) * f64::from(bh) / self.h as f64).floor() as i32));
                out[j * self.w + off + i] = u8::from(f.lum(sx, sy) >= thr);
            }
        }
        out
    }

    /// digit(cell, kind, { minScore = 0.55, minGap = 0.06 }).
    fn digit(&self, cell: &[u8], timer: bool) -> Option<String> {
        let set = if timer { &self.timer } else { &self.score };
        let mut order: Vec<&str> = Vec::new();
        let mut best: HashMap<&str, f64> = HashMap::new();
        for (d, m) in set {
            let (mut inter, mut uni) = (0u32, 0u32);
            for k in 0..cell.len() {
                inter += u32::from(cell[k] & m[k]);
                uni += u32::from(cell[k] | m[k]);
            }
            let s = if uni > 0 { f64::from(inter) / f64::from(uni) } else { 0.0 };
            if !best.contains_key(d.as_str()) {
                order.push(d);
            }
            let e = best.entry(d).or_insert(0.0);
            if s > *e {
                *e = s;
            }
        }
        let mut r: Vec<(&str, f64)> = order.iter().map(|d| (*d, best[d])).collect();
        r.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let ok = r[0].1 >= 0.55 && r[0].1 - r.get(1).map_or(0.0, |x| x.1) >= 0.06;
        ok.then(|| r[0].0.to_string())
    }

    /// readDigits(lum, roi, kind, thrs).
    fn read_digits(&self, f: &dyn Frame, roi: Roi, timer: bool, thrs: &[u8]) -> Option<String> {
        'thr: for &thr in thrs {
            let gs = Self::glyphs(f, roi, thr);
            if gs.is_empty() || gs.len() > 4 {
                continue;
            }
            let mut text = String::new();
            for g in &gs {
                match self.digit(&self.cell(f, g, thr), timer) {
                    Some(d) => text.push_str(&d),
                    None => continue 'thr,
                }
            }
            if !text.is_empty() {
                return Some(text);
            }
        }
        None
    }

    /// read(lum, { dx, dy }).
    pub fn read(&self, f: &dyn Frame, dx: i32, dy: i32) -> Hud {
        let at = |r: Roi| Roi { x: r.x + dx, y: r.y + dy, ..r };
        let score = |r: Roi| -> Option<u32> {
            let t = self.read_digits(f, at(r), false, &[150, 185, 210, 230])?;
            let v: u32 = t.parse().ok()?;
            (t.len() <= 2 && v <= 30).then_some(v)
        };
        let mut timer = None;
        if let Some(t) = self.read_digits(f, at(TIMER), true, &[122, 170, 200, 225]) {
            let num = |s: &str| s.parse::<u32>().ok();
            if t.len() == 3 {
                if let (Some(m), Some(s)) = (num(&t[..1]), num(&t[1..])) {
                    if m <= 2 && s <= 59 && m * 60 + s <= 140 {
                        timer = Some(Timer { seconds: f64::from(m * 60 + s), display: format!("{m}:{}", &t[1..]), low_time: false });
                    }
                }
            } else if t.len() == 4 {
                if let (Some(s), Some(c)) = (num(&t[..2]), num(&t[2..])) {
                    if s <= 10 {
                        timer = Some(Timer { seconds: f64::from(s) + f64::from(c) / 100.0, display: format!("{}.{}", &t[..2], &t[2..]), low_time: true });
                    }
                }
            }
        }
        Hud { home_score: score(HOME_SCORE), away_score: score(AWAY_SCORE), timer }
    }
}

fn crate_js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => isu_core::game_config::js_string(Some(other)),
    }
}
