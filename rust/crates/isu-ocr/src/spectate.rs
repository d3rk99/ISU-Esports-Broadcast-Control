//! Spectated-player tracker: electron/spectate-tracker.cjs (norm, similarity, matchCandidates,
//! cleanCrop, VARIANTS, boxColor, SpectateTracker, rocketLeagueSpectated) and
//! electron/valorant-portrait-match.cjs (PortraitMatcher).
use std::collections::HashMap;
use std::path::Path;

use serde_json::{Value, json};

use crate::board::Frame;
use crate::icons::AgentMatcher;
use crate::tess::{Gray, Tess};

/// DEFAULT_ROIS / DEFAULT_PORTRAITS (1920x1080).
pub fn default_roi(game: &str) -> Option<crate::board::Roi> {
    use crate::board::Roi;
    match game {
        "valorant" => Some(Roi { x: 113, y: 816, w: 213, h: 41 }),
        "overwatch" => Some(Roi { x: 150, y: 954, w: 200, h: 40 }),
        "rocketleague" => Some(Roi { x: 660, y: 930, w: 600, h: 60 }),
        _ => None,
    }
}
pub const VALORANT_PORTRAIT: Portrait = Portrait { x: 31.0, y: 794.0, s: 81.0 };

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Portrait {
    pub x: f64,
    pub y: f64,
    pub s: f64,
}

/// norm(s): lower, o->0, i/l/|/! ->1, s->5, keep [a-z0-9].
pub fn norm(s: &str) -> Vec<char> {
    s.to_lowercase()
        .chars()
        .map(|c| match c {
            'o' => '0',
            'i' | 'l' | '|' | '!' => '1',
            's' => '5',
            c => c,
        })
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect()
}

fn lev(x: &[char], y: &[char]) -> usize {
    let mut prev: Vec<usize> = (0..=y.len()).collect();
    for i in 1..=x.len() {
        let mut cur = vec![i];
        for j in 1..=y.len() {
            cur.push((prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + usize::from(x[i - 1] != y[j - 1])));
        }
        prev = cur;
    }
    prev[y.len()]
}

fn sim_norm(x: &[char], y: &[char]) -> f64 {
    if x.is_empty() || y.is_empty() {
        return 0.0;
    }
    if x == y {
        return 1.0;
    }
    1.0 - lev(x, y) as f64 / x.len().max(y.len()) as f64
}

/// similarity(a, b).
pub fn similarity(a: &str, b: &str) -> f64 {
    sim_norm(&norm(a), &norm(b))
}

#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub name: String,
    pub station: Option<f64>,
    pub side: String,
    pub team: String,
    pub agent: String,
}

/// matchCandidates(text, candidates) -> (best, runnerUp) as (index, score).
pub fn match_candidates(text: &str, cands: &[Candidate]) -> (Option<(usize, f64)>, Option<(usize, f64)>) {
    let t = norm(text);
    let mut scored: Vec<(usize, f64)> = cands
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let n = norm(&c.name);
            let mut best = similarity(text, &c.name);
            if !n.is_empty() && t.len() > n.len() {
                for w in (n.len() - 1).max(1)..=n.len() + 1 {
                    let mut i0 = 0;
                    while i0 + w <= t.len() {
                        // JS: similarity(t.slice(...), n): both get norm() again (idempotent here)
                        let s = sim_norm(&norm(&t[i0..i0 + w].iter().collect::<String>()), &n);
                        if s > best {
                            best = s;
                        }
                        i0 += 1;
                    }
                }
            }
            (i, best)
        })
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    (scored.first().copied(), scored.get(1).copied())
}

#[derive(Debug, Clone, Copy)]
pub struct Variant {
    pub mode: &'static str,
    pub thr: f64,
}
/// VARIANTS.
pub const VARIANTS: [Variant; 4] = [Variant { mode: "white", thr: 190.0 }, Variant { mode: "white", thr: 160.0 }, Variant { mode: "edge", thr: 170.0 }, Variant { mode: "thr", thr: 215.0 }];

/// cleanCrop(rgb, roi, { mode, thr, sat = 45, scale = 3, pad = 16 }) -> (image, inkShare).
pub fn clean_crop(f: &dyn Frame, roi: crate::board::Roi, v: Variant) -> (Gray, f64) {
    let (sat, scale, pad) = (45i32, 3usize, 16usize);
    let lum_at = |x: i32, y: i32| {
        let [r, g, b] = f.rgb(x, y);
        0.299 * f64::from(r) + 0.587 * f64::from(g) + 0.114 * f64::from(b)
    };
    let (rw, rh) = (roi.w as usize, roi.h as usize);
    let mut ink = vec![0u8; rw * rh];
    for y in 0..rh {
        for x in 0..rw {
            let (px, py) = (roi.x + x as i32, roi.y + y as i32);
            let [r, g, b] = f.rgb(px, py);
            let l = 0.299 * f64::from(r) + 0.587 * f64::from(g) + 0.114 * f64::from(b);
            let on = match v.mode {
                "white" => l >= v.thr && i32::from(r.max(g).max(b)) - i32::from(r.min(g).min(b)) < sat,
                "edge" => {
                    l >= v.thr && {
                        let mut dark = 255.0f64;
                        for dy in -2..=2 {
                            for dx in -2..=2 {
                                dark = dark.min(lum_at(px + dx, py + dy));
                            }
                        }
                        l - dark >= 90.0
                    }
                }
                _ => l >= v.thr,
            };
            ink[y * rw + x] = u8::from(on);
        }
    }
    let (ww, hh) = (rw * scale, rh * scale);
    let (w, h) = (ww + pad * 2, hh + pad * 2);
    let mut out = vec![255u8; w * h];
    for y in 0..hh {
        for x in 0..ww {
            if ink[(y / scale) * rw + x / scale] != 0 {
                out[(y + pad) * w + x + pad] = 0;
            }
        }
    }
    let count: usize = ink.iter().map(|&v| usize::from(v)).sum();
    (Gray { w, h, px: out }, count as f64 / ink.len() as f64)
}

/// boxColor(rgb, box): 'red' | 'teal' | ''.
pub fn box_color(f: &dyn Frame, b: Portrait) -> &'static str {
    let (bx, by, s) = (b.x as i32, b.y as i32, b.s);
    let e = ((s * 0.08 + 0.5).floor() as i32).max(3);
    let si = s as i32;
    let (mut red, mut teal, mut n) = (0f64, 0f64, 0f64);
    let mut look = |x: i32, y: i32| {
        let [r, g, bl] = f.rgb(x, y).map(i32::from);
        n += 1.0;
        if r > g + 60 && r > bl + 50 && r > 120 {
            red += 1.0;
        } else if g > r + 50 && bl > r + 30 && g > 110 {
            teal += 1.0;
        }
    };
    for y in by..by + si {
        for k in 0..e {
            if f64::from(y) < b.y + s * 0.6 {
                look(bx + k, y);
            }
            look(bx + si - 1 - k, y);
        }
    }
    for x in bx + e..bx + si - e {
        for k in 0..e {
            look(x, by + k);
        }
    }
    if red > n * 0.18 && red > teal * 2.0 {
        "red"
    } else if teal > n * 0.18 && teal > red * 2.0 {
        "teal"
    } else {
        ""
    }
}

/// PortraitMatcher (agent + team colour in one match).
pub struct PortraitMatcher {
    size: usize,
    refs: Vec<(String, String, Vec<u8>)>, // (agent, color, rgb)
}

#[derive(Debug, Clone, PartialEq)]
pub struct PortraitMatch {
    pub agent: Option<String>,
    pub color: String,
    pub candidate: String,
    pub candidate_color: String,
    pub score: f64,
    pub runner_up: Option<String>,
    pub runner_up_score: Option<f64>,
    pub other_color_score: Option<f64>,
}

impl PortraitMatcher {
    pub fn load(dir: &Path) -> anyhow::Result<Self> {
        let meta: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("valorant-agent-portraits.json"))?)?;
        let bin = std::fs::read(dir.join("valorant-agent-portraits.bin"))?;
        let size = meta["size"].as_u64().unwrap() as usize;
        let n = size * size * 3;
        let refs = meta["items"].as_array().unwrap().iter().enumerate().map(|(i, it)| (it["agent"].as_str().unwrap().to_string(), it["color"].as_str().unwrap().to_string(), bin[i * n..(i + 1) * n].to_vec())).collect();
        Ok(Self { size, refs })
    }

    /// match(rgbAt, box, { only, maxScore = 55, agentGap = 8, colorGap = 6 }).
    pub fn match_box(&self, f: &dyn Frame, b: Portrait, only: &[String]) -> PortraitMatch {
        let (max_score, agent_gap, color_gap) = (55.0, 8.0, 6.0);
        let s = self.size;
        let refs: Vec<&(String, String, Vec<u8>)> = if only.len() >= 2 { self.refs.iter().filter(|r| only.contains(&r.0)).collect() } else { self.refs.iter().collect() };
        let jr = |x: f64| (x + 0.5).floor() as i32;
        let mut samples = Vec::new();
        for inset in [0.0, 3.0, 6.0] {
            for dx in [-3.0, 0.0, 3.0] {
                for dy in [-3.0, 0.0, 3.0] {
                    let side = b.s - inset * 2.0;
                    let k = side / s as f64;
                    let mut px = vec![0u8; s * s * 3];
                    for y in 0..s {
                        for x in 0..s {
                            let p = f.rgb(jr(b.x + inset + dx + (x as f64 + 0.5) * k), jr(b.y + inset + dy + (y as f64 + 0.5) * k));
                            let o = (y * s + x) * 3;
                            px[o..o + 3].copy_from_slice(&p);
                        }
                    }
                    samples.push(px);
                }
            }
        }
        let mut scored: Vec<(&str, &str, f64)> = refs
            .iter()
            .map(|(agent, color, rp)| {
                let mut best = f64::INFINITY;
                for px in &samples {
                    let (mut sum, mut n) = (0f64, 0f64);
                    for y in (0..s).step_by(2) {
                        for x in (0..s).step_by(2) {
                            if (x as f64) < s as f64 * 0.4 && (y as f64) > s as f64 * 0.6 {
                                continue;
                            }
                            let o = (y * s + x) * 3;
                            for c in 0..3 {
                                let d = f64::from(px[o + c]) - f64::from(rp[o + c]);
                                sum += d * d;
                            }
                            n += 3.0;
                        }
                    }
                    let sc = (sum / n).sqrt();
                    if sc < best {
                        best = sc;
                    }
                }
                (agent.as_str(), color.as_str(), best)
            })
            .collect();
        scored.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal));
        let top = scored[0];
        let other_agent = scored.iter().find(|x| x.0 != top.0);
        let other_color = scored.iter().find(|x| x.0 == top.0 && x.1 != top.1);
        let agent_ok = top.2 <= max_score && other_agent.is_none_or(|o| o.2 - top.2 >= agent_gap);
        let color_ok = agent_ok && other_color.is_none_or(|o| o.2 - top.2 >= color_gap);
        let r1 = |v: f64| ((v * 10.0) + 0.5).floor() / 10.0;
        PortraitMatch {
            agent: agent_ok.then(|| top.0.to_string()),
            color: if color_ok { top.1.to_string() } else { String::new() },
            candidate: top.0.to_string(),
            candidate_color: top.1.to_string(),
            score: r1(top.2),
            runner_up: other_agent.map(|o| o.0.to_string()),
            runner_up_score: other_agent.map(|o| r1(o.2)),
            other_color_score: other_color.map(|o| r1(o.2)),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Current {
    pub name: String,
    pub station: Option<f64>,
    pub side: String,
    pub team: String,
    pub agent: String,
    pub score: f64,
    pub via: String,
    pub since: f64,
}

#[derive(Debug, Clone)]
pub struct Winner {
    pub name: String,
    pub n: u32,
    pub score: f64,
    pub via: &'static str,
}

/// One portrait read (readPortrait result).
#[derive(Debug, Clone, Default)]
pub struct PortraitRead {
    pub agent: Option<String>,
    pub candidate: String,
    pub color: String,
    pub side: String,
    pub score: f64,
    pub player: Option<(String, Option<f64>)>,
}

/// SpectateTracker({ minScore = 0.62, minMargin = 0.12, confirm = 3, window = 4, holdMs = 4000 }).
pub struct Tracker {
    pub min_score: f64,
    pub min_margin: f64,
    pub confirm: usize,
    pub window: usize,
    pub hold_ms: f64,
    pub candidates: Vec<Candidate>,
    /// { red, teal } -> 'home' | 'away'
    pub sides: Option<(String, String)>,
    history: Vec<Option<String>>,
    pub current: Option<Current>,
    last_seen_at: f64,
    portrait_run: u32,
    portrait_last: Option<String>,
    metadata_changed: bool,
    pub last_portrait: Option<PortraitRead>,
    pub agents: Option<AgentMatcher>,
    pub portraits: Option<PortraitMatcher>,
}

impl Default for Tracker {
    fn default() -> Self {
        Self { min_score: 0.62, min_margin: 0.12, confirm: 3, window: 4, hold_ms: 4000.0, candidates: Vec::new(), sides: None, history: Vec::new(), current: None, last_seen_at: 0.0, portrait_run: 0, portrait_last: None, metadata_changed: false, last_portrait: None, agents: None, portraits: None }
    }
}

pub const ALLOWED: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 _.#-";

impl Tracker {
    /// setSides({ red, teal }).
    pub fn set_sides(&mut self, sides: &Value) {
        let red = sides.get("red").and_then(Value::as_str).filter(|v| *v == "home" || *v == "away");
        self.sides = red.map(|r| (r.to_string(), sides.get("teal").and_then(Value::as_str).unwrap_or("").to_string()));
    }

    /// setCandidates(list): blank names dropped, duplicates (case-insensitive) merged.
    pub fn set_candidates(&mut self, list: &[Value]) -> usize {
        let mut seen: Vec<Candidate> = Vec::new();
        for c in list {
            let name = c.get("name").filter(|v| isu_core::game_config::truthy(Some(v))).map(|v| isu_core::game_config::js_string(Some(v))).unwrap_or_default().trim().to_string();
            if name.is_empty() || seen.iter().any(|s| s.name.to_lowercase() == name.to_lowercase()) {
                continue;
            }
            let s = |k: &str| c.get(k).filter(|v| isu_core::game_config::truthy(Some(v))).map(|v| isu_core::game_config::js_string(Some(v))).unwrap_or_default();
            seen.push(Candidate { name, station: isu_core::game_config::to_number(c.get("station")).filter(|x| *x != 0.0), side: s("side"), team: s("team"), agent: s("agent") });
        }
        self.candidates = seen;
        if let Some(cur) = self.current.as_mut() {
            if let Some(c) = self.candidates.iter().find(|c| c.name == cur.name) {
                if c.side != cur.side || c.team != cur.team || c.station != cur.station || c.agent != cur.agent {
                    cur.side.clone_from(&c.side);
                    cur.team.clone_from(&c.team);
                    cur.station = c.station;
                    cur.agent.clone_from(&c.agent);
                    self.metadata_changed = true;
                }
            }
        }
        self.candidates.len()
    }

    /// readPortrait(rgb, box).
    pub fn read_portrait(&self, f: &dyn Frame, b: Portrait) -> PortraitRead {
        let mut only: Vec<String> = Vec::new();
        for c in &self.candidates {
            if !c.agent.is_empty() && !only.contains(&c.agent) {
                only.push(c.agent.clone());
            }
        }
        let (agent, candidate, color, score) = if let Some(pm) = &self.portraits {
            let m = pm.match_box(f, b, &only);
            (m.agent, m.candidate, m.color, m.score)
        } else if let Some(am) = &self.agents {
            let color = box_color(f, b).to_string();
            let m = am.match_box(f, b.x, b.y, b.s, Some(&only));
            (m.agent, m.candidate, color, m.score)
        } else {
            return PortraitRead::default();
        };
        let side = match (&self.sides, color.as_str()) {
            (Some((red, _)), "red") => red.clone(),
            (Some((_, teal)), "teal") => teal.clone(),
            _ => String::new(),
        };
        let mut player = None;
        if let (Some(a), false) = (&agent, side.is_empty()) {
            let hits: Vec<&Candidate> = self.candidates.iter().filter(|c| &c.agent == a && c.side == side).collect();
            if hits.len() == 1 {
                player = Some((hits[0].name.clone(), hits[0].station));
            }
        }
        PortraitRead { agent, candidate, color, side, score, player }
    }

    /// portraitStep(rgb, portrait): fast path only.
    pub fn portrait_step(&mut self, f: &dyn Frame, b: Portrait, now: f64) -> Option<(bool, Value)> {
        if (self.agents.is_none() && self.portraits.is_none()) || self.candidates.is_empty() {
            return None;
        }
        let p = self.read_portrait(f, b);
        self.last_portrait = Some(p.clone());
        p.player.map(|(name, _)| self.report(Some(Winner { name, n: 0, score: 1.0, via: "portrait" }), now))
    }

    /// readName(rgb, roi): the 4 cleanups (one engine each, in parallel threads), votes.
    pub fn read_name(&self, engines: &mut [Tess], f: &dyn Frame, roi: crate::board::Roi) -> Option<Winner> {
        let cands = &self.candidates;
        let reads: Vec<Option<(usize, f64, f64)>> = std::thread::scope(|s| {
            let hs: Vec<_> = VARIANTS
                .iter()
                .zip(engines.iter_mut())
                .map(|(v, t)| {
                    s.spawn(move || {
                        let (img, share) = clean_crop(f, roi, *v);
                        if !(0.004..=0.45).contains(&share) {
                            return None;
                        }
                        let r = t.recognize(&img, ALLOWED, false);
                        if r.text.is_empty() {
                            return None;
                        }
                        let (best, ru) = match_candidates(&r.text, cands);
                        best.map(|(i, sc)| (i, sc, sc - ru.map_or(0.0, |x| x.1)))
                    })
                })
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        self.vote(&reads)
    }

    fn vote(&self, reads: &[Option<(usize, f64, f64)>]) -> Option<Winner> {
        let mut order: Vec<usize> = Vec::new();
        let mut votes: HashMap<usize, (u32, f64)> = HashMap::new();
        for (i, sc, margin) in reads.iter().flatten() {
            if *sc >= self.min_score && *margin >= self.min_margin {
                if !votes.contains_key(i) {
                    order.push(*i);
                }
                let v = votes.entry(*i).or_insert((0, 0.0));
                v.0 += 1;
                v.1 = v.1.max(*sc);
            }
        }
        let mut ranked: Vec<(usize, (u32, f64))> = order.iter().map(|i| (*i, votes[i])).collect();
        ranked.sort_by(|a, b| b.1.0.cmp(&a.1.0).then(b.1.1.partial_cmp(&a.1.1).unwrap_or(std::cmp::Ordering::Equal)));
        ranked.first().map(|(i, (n, sc))| Winner { name: self.candidates[*i].name.clone(), n: *n, score: *sc, via: "name" })
    }

    /// sweep(rgb, roi, portrait): portrait fast path, then the 4 cleanups one after another.
    pub fn sweep(&mut self, engine: &mut Tess, f: &dyn Frame, roi: crate::board::Roi, portrait: Option<Portrait>, now: f64) -> (bool, Value) {
        if self.candidates.is_empty() {
            return self.report(None, now);
        }
        if let Some(b) = portrait.filter(|_| self.agents.is_some() || self.portraits.is_some()) {
            let p = self.read_portrait(f, b);
            if let Some((name, _)) = p.player.clone() {
                return self.report(Some(Winner { name, n: 0, score: 1.0, via: "portrait" }), now);
            }
            self.last_portrait = Some(p);
        }
        let mut reads = Vec::new();
        for v in VARIANTS {
            let (img, share) = clean_crop(f, roi, v);
            if !(0.004..=0.45).contains(&share) {
                reads.push(None);
                continue;
            }
            let r = engine.recognize(&img, ALLOWED, false);
            let (best, ru) = if r.text.is_empty() { (None, None) } else { match_candidates(&r.text, &self.candidates) };
            reads.push(best.map(|(i, sc)| (i, sc, sc - ru.map_or(0.0, |x| x.1))));
        }
        let winner = self.vote(&reads);
        self.report(winner, now)
    }

    /// report(winner): history vote, portrait / strong-name fast switch, hold timeout.
    pub fn report(&mut self, winner: Option<Winner>, t: f64) -> (bool, Value) {
        self.history.push(winner.as_ref().map(|w| w.name.clone()));
        if self.history.len() > self.window {
            self.history.remove(0);
        }
        let sure = winner.as_ref().is_some_and(|w| w.via == "portrait" || w.n >= 3);
        self.portrait_run = if sure {
            if self.portrait_last.as_deref() == winner.as_ref().map(|w| w.name.as_str()) { self.portrait_run + 1 } else { 1 }
        } else {
            0
        };
        self.portrait_last = if sure { winner.as_ref().map(|w| w.name.clone()) } else { None };
        if winner.is_some() {
            self.last_seen_at = t;
        }
        // counts in first-seen order; sort by count desc (stable)
        let mut order: Vec<&String> = Vec::new();
        let mut counts: HashMap<&String, usize> = HashMap::new();
        for n in self.history.iter().flatten() {
            if !counts.contains_key(n) {
                order.push(n);
            }
            *counts.entry(n).or_insert(0) += 1;
        }
        let mut ranked: Vec<(&String, usize)> = order.iter().map(|n| (*n, counts[n])).collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1));
        let top = ranked.first().map(|(n, c)| ((*n).clone(), *c));
        let mut changed = std::mem::take(&mut self.metadata_changed);
        let cur_name = self.current.as_ref().map(|c| c.name.clone());
        let fast = (self.portrait_run >= 2 && winner.as_ref().map(|w| &w.name) != cur_name.as_ref()).then(|| winner.as_ref().unwrap().name.clone());
        let need = self.confirm.min(self.window);
        let pick = fast.clone().or_else(|| top.as_ref().filter(|(_, c)| *c >= need).map(|(n, _)| n.clone()));
        if let Some(pick) = pick.filter(|p| Some(p) != cur_name.as_ref()) {
            let c = self.candidates.iter().find(|x| x.name == pick).cloned();
            let mine = winner.as_ref().filter(|w| w.name == pick);
            let score = mine.map_or(self.current.as_ref().map_or(0.0, |c| c.score), |w| w.score);
            let via = mine.map_or("name".to_string(), |w| w.via.to_string());
            self.current = Some(match c {
                Some(c) => Current { name: c.name, station: c.station, side: c.side, team: c.team, agent: c.agent, score, via, since: t },
                None => Current { name: pick, score, via, since: t, ..Default::default() },
            });
            changed = true;
        } else if let (Some(cur), Some(w)) = (self.current.as_mut(), winner.as_ref()) {
            if w.name == cur.name {
                cur.score = w.score;
            }
        }
        if self.current.is_some() && t - self.last_seen_at > self.hold_ms {
            self.current = None;
            changed = true;
        }
        (changed, self.snapshot(t))
    }

    pub fn snapshot(&self, now: f64) -> Value {
        let c = self.current.clone().unwrap_or_default();
        json!({ "via": c.via, "name": c.name, "station": c.station.map(isu_core::game_config::jnum), "side": c.side, "team": c.team,
                "score": isu_core::game_config::jnum(((c.score * 100.0) + 0.5).floor() / 100.0), "since": isu_core::game_config::jnum(c.since),
                "updatedAt": isu_core::game_config::jnum(now), "candidates": self.candidates.len() })
    }

    pub fn clear(&mut self) {
        self.history.clear();
        self.current = None;
        self.last_seen_at = 0.0;
    }

    /// whyNot(): plain-words reason nothing is matched yet.
    pub fn why_not(&self) -> String {
        if self.agents.is_none() && self.portraits.is_none() {
            return "AGENT ICONS NOT LOADED (matcher missing): rebuild the Bridge from the latest commit".into();
        }
        if self.candidates.is_empty() {
            return "No player names from the controller yet (is the receiver on and the key the same?)".into();
        }
        let with_agent = self.candidates.iter().filter(|c| !c.agent.is_empty()).count();
        if with_agent == 0 {
            return "Controller sent names but NO agents: turn on the VALORANT scoreboard reader (Observer 3) so it knows who plays what".into();
        }
        if self.sides.is_none() {
            return "No red/teal info: select VALORANT in the controller (it sends which team is red this half)".into();
        }
        let Some(p) = &self.last_portrait else { return format!("{with_agent} players with agents · waiting for a frame") };
        if p.color.is_empty() {
            return format!("Portrait box colour not red/teal (agent {}): check the portrait box position", if p.candidate.is_empty() { "?" } else { &p.candidate });
        }
        match &p.agent {
            None => format!("{} box, agent not sure (best {} {}): portrait box position / icon", p.color, p.candidate, isu_core::game_config::num_to_js(p.score)),
            Some(a) => format!("{a} on {} ({}) but no {} player has {a} on the reader's board", p.color, p.side, p.side),
        }
    }
}

/// rocketLeagueSpectated(state): the Stats API's Game.Target -> roster station.
pub fn rocket_league_spectated(state: &Value, now: f64) -> Value {
    let empty = json!({});
    let game = state.pointer("/games/rocketleague").unwrap_or(&empty);
    let live = game.pointer("/rocketLeague/live").unwrap_or(&empty);
    let name = live.get("spectatedPlayer").filter(|v| isu_core::game_config::truthy(Some(v))).map(|v| isu_core::game_config::js_string(Some(v))).unwrap_or_default().trim().to_string();
    let status = live.get("status").and_then(Value::as_str).unwrap_or("");
    let age = live.get("dataAgeMs").filter(|v| !v.is_null()).map(|v| isu_core::game_config::to_number(Some(v)).unwrap_or(f64::NAN)).unwrap_or(0.0);
    let fresh = matches!(status, "connected" | "simulating") && age < 10000.0;
    if name.is_empty() || !fresh || isu_core::game_config::truthy(live.get("replay")) {
        return json!({ "name": "", "station": null, "side": "", "team": "", "receivedAt": isu_core::game_config::jnum(now), "game": "rocketleague" });
    }
    let mut hit: Option<Value> = None;
    let mut best = 0.9;
    for (side, coll, ti) in [("home", "rosters", 0), ("away", "awayRosters", 1)] {
        let team = game.pointer(&format!("/teams/{ti}/name")).filter(|v| isu_core::game_config::truthy(Some(v))).map(|v| isu_core::game_config::js_string(Some(v))).unwrap_or_default();
        for key in ["varsity", "jv"] {
            for p in game.get(coll).and_then(|r| r.get(key)).and_then(Value::as_array).into_iter().flatten() {
                for tag in [p.get("handle"), p.get("name")] {
                    let tag = tag.filter(|v| isu_core::game_config::truthy(Some(v))).map(|v| isu_core::game_config::js_string(Some(v)));
                    let sc = tag.as_deref().map_or(0.0, |t| similarity(t, &name));
                    if sc >= best {
                        best = sc;
                        let shown = p.get("handle").filter(|v| isu_core::game_config::truthy(Some(v))).or_else(|| p.get("name"));
                        let st = isu_core::game_config::js_round(isu_core::game_config::num_or_zero(p.get("stageStation")));
                        hit = Some(json!({ "name": shown.cloned().unwrap_or(Value::Null), "station": if st != 0.0 { isu_core::game_config::jnum(st) } else { Value::Null }, "side": side, "team": team }));
                    }
                }
            }
        }
    }
    let mut out = match hit {
        Some(h) => h,
        None => {
            let player = live.get("players").and_then(Value::as_array).and_then(|ps| ps.iter().find(|p| p.get("name").and_then(Value::as_str) == Some(name.as_str())));
            let blue = isu_core::game_config::num_or_zero(game.pointer("/rocketLeague/blueTeam"));
            let ti = player.map_or(-1.0, |p| if isu_core::game_config::to_number(p.get("teamNum")) == Some(0.0) { blue } else { 1.0 - blue });
            let side = if ti == 0.0 { "home" } else if ti == 1.0 { "away" } else { "" };
            let team = if ti >= 0.0 { game.pointer(&format!("/teams/{}/name", ti as i64)).filter(|v| isu_core::game_config::truthy(Some(v))).map(|v| isu_core::game_config::js_string(Some(v))).unwrap_or_default() } else { String::new() };
            json!({ "station": null, "side": side, "team": team })
        }
    };
    // JS: { name, ...hit, apiName, receivedAt, game } -> hit.name (roster handle) overrides name
    let mut m = serde_json::Map::new();
    m.insert("name".into(), json!(name));
    for (k, v) in out.as_object_mut().unwrap().clone() {
        m.insert(k, v);
    }
    m.insert("apiName".into(), json!(name));
    m.insert("receivedAt".into(), isu_core::game_config::jnum(now));
    m.insert("game".into(), json!("rocketleague"));
    Value::Object(m)
}
