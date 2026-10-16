//! Icon matching on the VALORANT board: electron/valorant-board-parse.cjs AgentMatcher and
//! GearMatcher, reading the same template files (electron/valorant-*.json / *.bin).
use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;

use crate::board::{Frame, Roi};

fn js_round1(x: f64) -> f64 {
    ((x * 10.0) + 0.5).floor() / 10.0
}
fn js_round2(x: f64) -> f64 {
    ((x * 100.0) + 0.5).floor() / 100.0
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentMatch {
    pub agent: Option<String>,
    pub candidate: String,
    pub score: f64,
    pub runner_up: String,
    pub runner_up_score: f64,
}

pub struct AgentMatcher {
    size: usize,
    templates: Vec<(String, Vec<u8>)>,
}

impl AgentMatcher {
    /// dir = electron/ (valorant-agent-templates.json + .bin: RGBA size x size per agent).
    pub fn load(dir: &Path) -> anyhow::Result<Self> {
        let meta: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("valorant-agent-templates.json"))?)?;
        let bin = std::fs::read(dir.join("valorant-agent-templates.bin"))?;
        let size = meta["size"].as_u64().unwrap_or(32) as usize;
        let n = size * size * 4;
        let templates = meta["agents"].as_array().unwrap().iter().enumerate().map(|(i, a)| (a.as_str().unwrap().to_string(), bin[i * n..(i + 1) * n].to_vec())).collect();
        Ok(Self { size, templates })
    }

    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.templates.iter().map(|(n, _)| n.as_str())
    }

    /// Score of one template at a top-left (sx, sy), stepping 2 px like the JS.
    fn rms(&self, f: &dyn Frame, px: &[u8], sx: i32, sy: i32) -> f64 {
        let s = self.size;
        let (mut sum, mut wsum) = (0.0f64, 0.0f64);
        for y in (0..s).step_by(2) {
            for x in (0..s).step_by(2) {
                let o = (y * s + x) * 4;
                let a = f64::from(px[o + 3]) / 255.0;
                if a < 0.1 {
                    continue;
                }
                let p = f.rgb(sx + x as i32, sy + y as i32);
                for k in 0..3 {
                    let d = f64::from(p[k]) * a - f64::from(px[o + k]) * a;
                    sum += d * d;
                }
                wsum += a * 3.0;
            }
        }
        (sum / if wsum == 0.0 { 1.0 } else { wsum }).sqrt()
    }

    /// match(rgbAt, cx, cy, { search = 4, maxScore = 46, minGap = 9 }).
    pub fn match_at(&self, f: &dyn Frame, cx: i32, cy: i32) -> AgentMatch {
        let (search, max_score, min_gap) = (4, 46.0, 9.0);
        let half = (self.size / 2) as i32;
        let mut scores: Vec<(f64, &str)> = self
            .templates
            .iter()
            .map(|(name, px)| {
                let mut best = f64::INFINITY;
                for oy in -3..=3 {
                    for ox in -search..=search {
                        let s = self.rms(f, px, cx - half + ox, cy - half + oy);
                        if s < best {
                            best = s;
                        }
                    }
                }
                (best, name.as_str())
            })
            .collect();
        finish(&mut scores, max_score, min_gap)
    }

    /// matchBox(rgbAt, box, { maxScore = 46, minGap = 9, only }): a big POV portrait (box = x, y, s).
    pub fn match_box(&self, f: &dyn Frame, bx: f64, by: f64, bs: f64, only: Option<&[String]>) -> AgentMatch {
        let (max_score, min_gap) = (46.0, 9.0);
        let s = self.size;
        let pool: Vec<&(String, Vec<u8>)> = match only {
            Some(o) if o.len() >= 2 => self.templates.iter().filter(|(n, _)| o.contains(n)).collect(),
            _ => self.templates.iter().collect(),
        };
        let mut tries = Vec::new();
        for inset in [0.0, 4.0, 8.0] {
            for dx in [-3.0, 0.0, 3.0] {
                for dy in [-3.0, 0.0, 3.0] {
                    tries.push((bx + inset + dx, by + inset + dy, bs - inset * 2.0));
                }
            }
        }
        let jr = |x: f64| (x + 0.5).floor() as i32;
        let mut scores: Vec<(f64, &str)> = pool
            .iter()
            .map(|(name, px)| {
                let mut best = f64::INFINITY;
                for &(tx, ty, ts) in &tries {
                    let (mut sum, mut wsum) = (0.0f64, 0.0f64);
                    let k = ts / s as f64;
                    for y in (0..s).step_by(2) {
                        for x in (0..s).step_by(2) {
                            // the team badge covers the bottom-left corner of the POV portrait
                            if (x as f64) < s as f64 * 0.4 && (y as f64) > s as f64 * 0.6 {
                                continue;
                            }
                            let o = (y * s + x) * 4;
                            let a = f64::from(px[o + 3]) / 255.0;
                            if a < 0.1 {
                                continue;
                            }
                            let p = f.rgb(jr(tx + (x as f64 + 0.5) * k), jr(ty + (y as f64 + 0.5) * k));
                            for c in 0..3 {
                                let d = f64::from(p[c]) * a - f64::from(px[o + c]) * a;
                                sum += d * d;
                            }
                            wsum += a * 3.0;
                        }
                    }
                    let sc = (sum / if wsum == 0.0 { 1.0 } else { wsum }).sqrt();
                    if sc < best {
                        best = sc;
                    }
                }
                (best, name.as_str())
            })
            .collect();
        finish(&mut scores, max_score, min_gap)
    }
}

fn finish(scores: &mut [(f64, &str)], max_score: f64, min_gap: f64) -> AgentMatch {
    // JS sort((a, b) => a[0] - b[0]) is stable.
    scores.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let (score, agent) = scores[0];
    let (ru_score, ru) = scores[1];
    let ok = score <= max_score && ru_score - score >= min_gap;
    AgentMatch { agent: ok.then(|| agent.to_string()), candidate: agent.to_string(), score: js_round1(score), runner_up: ru.to_string(), runner_up_score: js_round1(ru_score) }
}

#[derive(Debug, Clone, PartialEq)]
pub struct GearMatch {
    pub name: Option<String>,
    pub candidate: String,
    pub score: f64,
}

pub struct GearMatcher {
    w: usize,
    h: usize,
    weapons: Vec<(String, Vec<u8>)>,
    shield_size: i32,
    shields: Vec<(&'static str, Vec<u8>)>,
}

impl GearMatcher {
    /// dir = electron/ (valorant-gear-templates.json + weapon/real/trained/shield .bin).
    pub fn load(dir: &Path) -> anyhow::Result<Self> {
        let meta: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("valorant-gear-templates.json"))?)?;
        let (w, h) = (meta["w"].as_u64().unwrap() as usize, meta["h"].as_u64().unwrap() as usize);
        let n = w * h;
        let mut weapons = Vec::new();
        let mut add = |names: &Value, file: &str| -> anyhow::Result<()> {
            let Some(list) = names.as_array() else { return Ok(()) };
            let p = dir.join(file);
            if !p.exists() {
                return Ok(());
            }
            let bin = std::fs::read(p)?;
            for (i, nm) in list.iter().enumerate() {
                weapons.push((nm.as_str().unwrap().to_string(), bin[i * n..(i + 1) * n].to_vec()));
            }
            Ok(())
        };
        add(&meta["weapons"], "valorant-weapon-templates.bin")?;
        add(&meta["real"], "valorant-weapon-real.bin")?;
        add(&meta["trained"], "valorant-weapon-trained.bin")?;
        let shield_size = meta["shieldSize"].as_i64().unwrap_or(20) as i32;
        let shields = [("light", "light-armor"), ("heavy", "heavy-armor"), ("regen", "regen-shield")]
            .into_iter()
            .map(|(name, f)| Ok((name, std::fs::read(dir.join(format!("valorant-shield-{f}.bin")))?)))
            .collect::<anyhow::Result<Vec<_>>>()?;
        Ok(Self { w, h, weapons, shield_size, shields })
    }

    /// silhouette(lum, roi, thr = 150): the widest ink run as a w x h mask (None = no gun).
    pub fn silhouette(&self, f: &dyn Frame, roi: Roi, thr: u8) -> Option<Vec<u8>> {
        let col_ink = |x: i32| (roi.y..roi.y + roi.h).filter(|&y| f.lum(x, y) >= thr).count();
        let mut best: Option<(i32, i32)> = None;
        let (mut s, mut gap) = (-1, 0);
        for x in roi.x..=roi.x + roi.w {
            let on = x < roi.x + roi.w && col_ink(x) >= 2;
            if on {
                if s < 0 {
                    s = x;
                }
                gap = 0;
                continue;
            }
            if s >= 0 {
                gap += 1;
                if gap > 3 || x == roi.x + roi.w {
                    let e = x - gap;
                    if best.is_none_or(|(a, b)| e - s > b - a) {
                        best = Some((s, e));
                    }
                    s = -1;
                    gap = 0;
                }
            }
        }
        let (x0, x1) = best?;
        let (mut y0, mut y1) = (i32::MAX, -1);
        for y in roi.y..roi.y + roi.h {
            for x in x0..=x1 {
                if f.lum(x, y) >= thr {
                    y0 = y0.min(y);
                    y1 = y1.max(y);
                }
            }
        }
        if x1 - x0 < 12 {
            return None;
        }
        let (bw, bh) = (f64::from(x1 - x0 + 1), f64::from(y1 - y0 + 1));
        let mut cell = vec![0u8; self.w * self.h];
        for j in 0..self.h {
            for i in 0..self.w {
                let x = x0 + ((i as f64 + 0.5) * bw / self.w as f64).floor() as i32;
                let y = y0 + ((j as f64 + 0.5) * bh / self.h as f64).floor() as i32;
                cell[j * self.w + i] = u8::from(f.lum(x, y) >= thr);
            }
        }
        Some(cell)
    }

    /// weapon(lum, roi, { thr = 150, minScore = 0.6, minGap = 0.05 }).
    pub fn weapon(&self, f: &dyn Frame, roi: Roi) -> GearMatch {
        let (thr, min_score, min_gap) = (150, 0.6, 0.05);
        let Some(cell) = self.silhouette(f, roi, thr) else { return GearMatch { name: None, candidate: String::new(), score: 0.0 } };
        // best IoU per weapon, in first-seen order (JS Map keeps insertion order)
        let mut order: Vec<&str> = Vec::new();
        let mut best: HashMap<&str, f64> = HashMap::new();
        for (name, m) in &self.weapons {
            let (mut inter, mut union) = (0u32, 0u32);
            for k in 0..cell.len() {
                inter += u32::from(cell[k] & m[k]);
                union += u32::from(cell[k] | m[k]);
            }
            let iou = if union > 0 { f64::from(inter) / f64::from(union) } else { 0.0 };
            if !best.contains_key(name.as_str()) {
                order.push(name);
            }
            let e = best.entry(name).or_insert(0.0);
            if iou > *e {
                *e = iou;
            }
        }
        let mut scores: Vec<(f64, &str)> = order.iter().map(|n| (best[n], *n)).collect();
        scores.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let ok = scores[0].0 >= min_score && scores[0].0 - scores[1].0 >= min_gap;
        GearMatch { name: ok.then(|| scores[0].1.to_string()), candidate: scores[0].1.to_string(), score: js_round2(scores[0].0) }
    }

    /// shield(lum, x0, x1, cy, { thr = 150, minScore = 0.55, minGap = 0.15 }) -> 'none' / name / None.
    pub fn shield(&self, f: &dyn Frame, x0: i32, x1: i32, cy: i32) -> GearMatch {
        let (thr, min_score, min_gap) = (150u8, 0.55, 0.15);
        let s = self.shield_size;
        let mut order: Vec<&str> = Vec::new();
        let mut best: HashMap<&str, f64> = HashMap::new();
        // JS: y from cy - S/2 - 4 to cy - S/2 + 4 (S = 20, so integers)
        for y in cy - s / 2 - 4..=cy - s / 2 + 4 {
            for x in x0..=x1 - s {
                let mut ink = 0;
                for j in (0..s).step_by(2) {
                    for i in (0..s).step_by(2) {
                        if f.lum(x + i, y + j) >= thr {
                            ink += 1;
                        }
                    }
                }
                if ink < 6 {
                    continue;
                }
                for (name, m) in &self.shields {
                    let (mut inter, mut union) = (0u32, 0u32);
                    for j in 0..s {
                        for i in 0..s {
                            let p = u8::from(f.lum(x + i, y + j) >= thr);
                            let t = m[(j * s + i) as usize];
                            inter += u32::from(p & t);
                            union += u32::from(p | t);
                        }
                    }
                    let iou = if union > 0 { f64::from(inter) / f64::from(union) } else { 0.0 };
                    if !best.contains_key(name) {
                        order.push(name);
                    }
                    let e = best.entry(name).or_insert(0.0);
                    if iou > *e {
                        *e = iou;
                    }
                }
            }
        }
        let mut ranked: Vec<(&str, f64)> = order.iter().map(|n| (*n, best[n])).collect();
        if ranked.is_empty() {
            return GearMatch { name: Some("none".into()), candidate: "none".into(), score: 0.0 };
        }
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let (name, score) = ranked[0];
        let gap = score - ranked.get(1).map_or(0.0, |r| r.1);
        GearMatch { name: (score >= min_score && gap >= min_gap).then(|| name.to_string()), candidate: name.to_string(), score: js_round2(score) }
    }
}
