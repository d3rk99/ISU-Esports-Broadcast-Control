//! Overwatch 2 spectator scoreboard: electron/overwatch-ocr-parse.cjs (profile, inkBands,
//! statOffset, headerColumns, alignBoard, cellRois, parseCell, glyphCount, plausibleRead,
//! ringFill, discFill, resolveUltimate, OverwatchConsensus, emptyBoard, applySweep) and
//! electron/overwatch-hero-match.cjs (HeroMatcher). Profile from electron/overwatch-ocr-profiles.json.
use std::collections::HashMap;
use std::path::Path;

use serde_json::{Value, json};

use crate::board::{Frame, Roi};

pub const STAT_FIELDS: [&str; 6] = ["elims", "assists", "deaths", "damage", "healing", "mitigation"];
pub const ALL_FIELDS: [&str; 9] = ["name", "hero", "ultimate", "elims", "assists", "deaths", "damage", "healing", "mitigation"];

fn jr(x: f64) -> i32 {
    (x + 0.5).floor() as i32
}

#[derive(Debug, Clone)]
pub struct Column {
    pub field: String,
    pub x: i32,
    pub w: i32,
    pub allowed: String,
    pub shear: f64,
    pub threshold: Option<u8>,
    pub lang: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Profile {
    pub width: i32,
    pub height: i32,
    pub cell_height: i32,
    pub name_cell_height: Option<i32>,
    pub teams: Vec<(String, Vec<i32>)>,
    /// in the JSON's key order (Object.entries)
    pub columns: Vec<Column>,
    pub ring_cx: f64,
    pub ring_dy: f64,
    pub ring_radius: f64,
    pub ready_radius: f64,
    pub pre_scale: i32,
    pub pre_threshold: u8,
    pub bar_left: Option<i32>,
    pub align_dx: i32,
    pub align_dy: i32,
    pub header_left: i32,
    pub perk_gap: f64,
    pub name_gap: f64,
    pub box_scale: f64,
}

impl Profile {
    pub fn load(dir: &Path, id: &str) -> anyhow::Result<Self> {
        let all: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("overwatch-ocr-profiles.json"))?)?;
        let p = all.get(id).unwrap_or(&all["default-1080p"]);
        let i = |v: &Value, d: i64| v.as_i64().unwrap_or(d) as i32;
        let columns = p["columns"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, c)| Column {
                field: k.clone(),
                x: i(&c["x"], 0),
                w: i(&c["w"], 0),
                allowed: c["allowedChars"].as_str().unwrap_or("").to_string(),
                shear: c["shear"].as_f64().unwrap_or(0.0),
                threshold: c["threshold"].as_u64().map(|t| t as u8),
                lang: c["lang"].as_str().map(str::to_string),
            })
            .collect();
        let teams = p["teams"].as_array().unwrap().iter().map(|t| (t["id"].as_str().unwrap().to_string(), t["rowCenters"].as_array().unwrap().iter().map(|v| v.as_i64().unwrap() as i32).collect())).collect();
        let ring = &p["ultimateRing"];
        let al = &p["align"];
        Ok(Self {
            width: i(&p["width"], 1920),
            height: i(&p["height"], 1080),
            cell_height: i(&p["cellHeight"], 16),
            name_cell_height: p["nameCellHeight"].as_i64().map(|v| v as i32),
            teams,
            columns,
            ring_cx: ring["cx"].as_f64().unwrap_or(670.0),
            ring_dy: ring["dy"].as_f64().unwrap_or(0.0),
            ring_radius: ring["radius"].as_f64().unwrap_or(16.0),
            ready_radius: ring["readyRadius"].as_f64().filter(|r| *r != 0.0).unwrap_or(12.0),
            pre_scale: i(&p["preprocess"]["scale"], 3),
            pre_threshold: p["preprocess"]["threshold"].as_u64().unwrap_or(127) as u8,
            bar_left: p["barLeft"].as_i64().map(|v| v as i32),
            align_dx: i(&al["dx"], 24),
            align_dy: i(&al["dy"], 14),
            header_left: i(&al["headerLeft"], 360),
            perk_gap: al["perkGap"].as_f64().unwrap_or(140.0),
            name_gap: al["nameGap"].as_f64().unwrap_or(23.0),
            box_scale: p["boxScale"].as_f64().unwrap_or(1.0),
        })
    }

    pub fn col(&self, f: &str) -> Option<&Column> {
        self.columns.iter().find(|c| c.field == f)
    }
}

#[derive(Debug, Clone, Copy)]
struct Band {
    h: i32,
    c: f64,
}

/// inkBands(lum, x0, x1, y0, y1, thr, minPx, isInk).
fn ink_bands(x0: i32, x1: i32, y0: i32, y1: i32, min_px: i32, is_ink: &dyn Fn(i32, i32) -> bool) -> Vec<Band> {
    let mut bands = Vec::new();
    let mut start = -1;
    for y in y0..=y1 {
        let mut on = false;
        if y < y1 {
            let mut n = 0;
            for x in x0..x1 {
                if is_ink(x, y) {
                    n += 1;
                    if n >= min_px {
                        on = true;
                        break;
                    }
                }
            }
        }
        if on && start < 0 {
            start = y;
        }
        if !on && start >= 0 {
            bands.push(Band { h: y - start, c: f64::from(start + y - 1) / 2.0 });
            start = -1;
        }
    }
    bands
}

/// statOffset(lum, profile, statDy).
fn stat_offset(f: &dyn Frame, p: &Profile, stat_dy: &HashMap<(usize, usize), i32>) -> i32 {
    let mut cols: Vec<&Column> = STAT_FIELDS.iter().filter_map(|s| p.col(s)).collect();
    if cols.len() < 2 {
        return 0;
    }
    cols.sort_by_key(|c| c.x);
    let range = p.align_dx;
    let x0 = cols[0].x - range - 2;
    let last = cols[cols.len() - 1];
    let x1 = last.x + last.w + range + 2;
    let mut ink = vec![0f64; (x1 - x0) as usize];
    for (ti, (_, rows)) in p.teams.iter().enumerate() {
        for (r, cy) in rows.iter().enumerate() {
            let c = cy + stat_dy.get(&(ti, r)).copied().unwrap_or(0);
            for y in c - 7..=c + 7 {
                for x in x0..x1 {
                    if f.lum(x, y) >= 165 {
                        ink[(x - x0) as usize] += 1.0;
                    }
                }
            }
        }
    }
    if ink.iter().sum::<f64>() < 40.0 {
        return 0;
    }
    let mut shifts = Vec::new();
    for col in &cols {
        let mid = f64::from(col.x) + f64::from(col.w) / 2.0;
        let (mut sum, mut n) = (0.0, 0.0);
        for x in jr(mid - f64::from(col.w) / 2.0 - f64::from(range))..=jr(mid + f64::from(col.w) / 2.0 + f64::from(range)) {
            let v = if x >= x0 && x < x1 { ink[(x - x0) as usize] } else { 0.0 };
            sum += v * f64::from(x);
            n += v;
        }
        if n >= 8.0 {
            shifts.push(sum / n - mid);
        }
    }
    if shifts.len() < 3 {
        return 0;
    }
    shifts.sort_by(f64::total_cmp);
    let median = shifts[shifts.len() / 2];
    let agree = shifts.iter().filter(|d| (*d - median).abs() <= 4.0).count();
    if agree >= (shifts.len() as f64 * 0.6).ceil() as usize && median.abs() >= 3.0 { jr(median) } else { 0 }
}

/// headerColumns result: column centres + leftDx.
#[derive(Debug, Clone, PartialEq)]
pub struct Header {
    pub cols: Vec<(String, i32)>,
    pub left_dx: i32,
}

impl Header {
    pub fn get(&self, f: &str) -> Option<i32> {
        self.cols.iter().find(|(k, _)| k == f).map(|(_, v)| *v)
    }
}

/// headerColumns(lum, profile).
pub fn header_columns(f: &dyn Frame, p: &Profile) -> Option<Header> {
    let cols: Vec<&Column> = STAT_FIELDS.iter().filter_map(|s| p.col(s)).collect();
    let first_row = p.teams.iter().flat_map(|(_, r)| r.iter().copied()).min().unwrap();
    let x0 = (cols.iter().map(|c| c.x).min().unwrap() - p.header_left).max(0);
    let x1 = cols.iter().map(|c| c.x + c.w).max().unwrap() + 110;
    let mut bar_rows = Vec::new();
    for y in first_row - 75..first_row - 25 {
        let (mut run, mut best) = (0, 0);
        let mut x = x0;
        while x < x1 {
            if f.lum(x, y) >= 180 {
                run += 4;
                best = best.max(run);
            } else if run != 0 && f.lum(x + 4, y) < 180 {
                run = 0;
            }
            x += 4;
        }
        if best >= 400 {
            bar_rows.push(y);
        }
    }
    if bar_rows.len() < 8 {
        return None;
    }
    if bar_rows[bar_rows.len() - 1] - bar_rows[0] <= 45 {
        let (a, b) = (bar_rows[0], bar_rows[bar_rows.len() - 1]);
        bar_rows = (a..=b).collect();
    }
    let mid_y = bar_rows[bar_rows.len() / 2];
    let mut bar_left = None;
    for x in 0..x1.min(x0 + 500) {
        let light = (0..120).step_by(4).filter(|k| f.lum(x + k, mid_y) >= 180).count();
        if light >= 28 {
            bar_left = Some(x);
            break;
        }
    }
    let (top, bottom) = (bar_rows[0], bar_rows[bar_rows.len() - 1]);
    let in_bar = |x: i32| f.lum(x, top + 1) >= 180 || f.lum(x, bottom - 1) >= 180;
    let mut dark = vec![0i32; (x1 - x0) as usize];
    for &y in &bar_rows {
        for x in x0..x1 {
            if f.lum(x, y) < 110 && in_bar(x) {
                dark[(x - x0) as usize] += 1;
            }
        }
    }
    let mut blobs: Vec<(i32, i32)> = Vec::new();
    let mut start = -1;
    for i in 0..=dark.len() as i32 {
        let on = (i as usize) < dark.len() && dark[i as usize] > 1;
        if on && start < 0 {
            start = i;
        }
        if !on && start >= 0 {
            blobs.push((start + x0, i + x0));
            start = -1;
        }
    }
    let mut merged: Vec<(i32, i32)> = Vec::new();
    for b in blobs {
        match merged.last_mut() {
            Some(l) if b.0 - l.1 <= 6 => l.1 = b.1,
            _ => merged.push(b),
        }
    }
    let labels: Vec<f64> = merged.iter().filter(|(a, b)| b - a >= 3 && b - a <= 40).map(|(a, b)| f64::from(a + b) / 2.0).collect();
    if labels.len() < cols.len() {
        return None;
    }
    let expected: Vec<f64> = cols.iter().map(|c| f64::from(c.x) + f64::from(c.w) / 2.0).collect();
    let mut best: Option<(Vec<f64>, f64)> = None;
    for s in 0..=labels.len() - cols.len() {
        let run = &labels[s..s + cols.len()];
        let (mut err, mut ok) = (0.0, true);
        for i in 1..cols.len() {
            let (want, got) = (expected[i] - expected[i - 1], run[i] - run[i - 1]);
            if (got - want).abs() > want * 0.35 {
                ok = false;
                break;
            }
            err += (got - want).abs();
        }
        if ok && best.as_ref().is_none_or(|b| err < b.1) {
            best = Some((run.to_vec(), err));
        }
    }
    let (run, _) = best?;
    let mut left_dx = match (bar_left, p.bar_left) {
        (Some(b), Some(pb)) if pb != 0 => b - pb,
        _ => 0,
    };
    if left_dx.abs() > 400 {
        left_dx = 0;
    }
    Some(Header { cols: cols.iter().zip(run).map(|(c, x)| (c.field.clone(), jr(x))).collect(), left_dx })
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct RowAlign {
    pub stat_dy: i32,
    pub name_dy: i32,
    pub name_x: Option<i32>,
    pub name_right: Option<i32>,
}

#[derive(Debug, Clone)]
pub struct Align {
    pub dx: i32,
    /// rows[team][row]
    pub rows: Vec<Vec<RowAlign>>,
    pub cols: Option<Header>,
    pub left_dx: i32,
    pub perks: bool,
    pub view: &'static str,
    pub forced: bool,
}

/// alignBoard(lum, profile, rgb).
pub fn align_board(f: &dyn Frame, p: &Profile, use_rgb: bool) -> Align {
    let search = p.align_dy;
    let header = header_columns(f, p);
    let left_dx = header.as_ref().map_or(0, |h| h.left_dx);
    let stat_x = |c: &Column| header.as_ref().and_then(|h| h.get(&c.field)).map_or(f64::from(c.x), |v| f64::from(v) - f64::from(c.w) / 2.0);
    let stat_cols: Vec<&Column> = STAT_FIELDS.iter().filter_map(|s| p.col(s)).collect();
    let sx0 = stat_cols.iter().map(|c| stat_x(c)).fold(f64::INFINITY, f64::min);
    let sx1 = stat_cols.iter().map(|c| stat_x(c) + f64::from(c.w)).fold(f64::NEG_INFINITY, f64::max);
    // inkBands loops `for (let x = x0; x < x1; ...)` with fractional bounds: x = x0, x0+1, ... < x1
    let lum_ink = |x: i32, y: i32| f.lum(x, y) >= 165;
    let mut rows: Vec<Vec<RowAlign>> = Vec::new();
    for (_, centers) in &p.teams {
        let mut team = Vec::new();
        for &cy in centers {
            let bands = ink_bands_f(sx0, sx1, cy - search, cy + search + 1, &lum_ink);
            let mut sb: Vec<Band> = bands.into_iter().filter(|b| b.h >= 6 && b.h <= 20).collect();
            sb.sort_by(|a, b| (a.c - f64::from(cy)).abs().partial_cmp(&(b.c - f64::from(cy)).abs()).unwrap());
            team.push(RowAlign { stat_dy: sb.first().map_or(0, |b| jr(b.c - f64::from(cy))), name_dy: 0, name_x: None, name_right: None });
        }
        rows.push(team);
    }
    let dx = if header.is_some() {
        0
    } else {
        let m: HashMap<(usize, usize), i32> = rows.iter().enumerate().flat_map(|(t, r)| r.iter().enumerate().map(move |(i, a)| ((t, i), a.stat_dy))).collect();
        stat_offset(f, p, &m)
    };
    let elims = p.col("elims");
    let elims_mid = header.as_ref().and_then(|h| h.get("elims")).map(f64::from).or_else(|| elims.map(|c| f64::from(c.x) + f64::from(c.w) / 2.0 + f64::from(dx)));
    let perks = match (&header, elims) {
        (Some(h), Some(c)) => f64::from(h.get("elims").unwrap() - left_dx) - (f64::from(c.x) + f64::from(c.w) / 2.0) >= 50.0,
        _ => false,
    };
    let name_right = elims_mid.map(|m| m - if perks { p.perk_gap } else { p.name_gap });
    let is_text = |x: i32, y: i32| {
        if f.lum(x, y) < 165 {
            return false;
        }
        if !use_rgb {
            return true;
        }
        let [r, g, b] = f.rgb(x, y);
        i32::from(r.max(g).max(b)) - i32::from(r.min(g).min(b)) < 70
    };
    if let Some(n) = p.col("name") {
        let nx = n.x + left_dx;
        let right = match name_right {
            Some(nr) => (nx + n.w + 40).min(jr(nr)),
            None => nx + n.w,
        };
        for (ti, (_, centers)) in p.teams.iter().enumerate() {
            for (row, &cy0) in centers.iter().enumerate() {
                let r = &mut rows[ti][row];
                r.name_right = Some(right);
                let cy = cy0 + r.stat_dy;
                let (ya, yb) = (cy - 22, cy + 9);
                let mut runs: Vec<(i32, i32)> = Vec::new();
                let mut start = -1;
                for x in nx - 40..=right {
                    let mut on = false;
                    if x < right {
                        let mut hits = 0;
                        for y in ya..yb {
                            if is_text(x, y) {
                                hits += 1;
                                if hits >= 2 {
                                    on = true;
                                    break;
                                }
                            }
                        }
                    }
                    if on && start < 0 {
                        start = x;
                    }
                    if !on && start >= 0 {
                        runs.push((start, x));
                        start = -1;
                    }
                }
                let mut merged: Vec<(i32, i32)> = Vec::new();
                for run in runs {
                    match merged.last_mut() {
                        Some(l) if run.0 - l.1 <= 6 => l.1 = run.1,
                        _ => merged.push(run),
                    }
                }
                if merged.is_empty() {
                    continue;
                }
                // reduce: keeps the first of equally wide runs
                let mut best = merged[0];
                for m in &merged[1..] {
                    if m.1 - m.0 > best.1 - best.0 {
                        best = *m;
                    }
                }
                for m in &merged {
                    if m.0 > best.1 && m.0 - best.1 <= 12 {
                        best = (best.0, m.1);
                    }
                }
                if best.1 - best.0 < 12 {
                    continue;
                }
                r.name_x = Some(best.0);
                let mut nb: Vec<Band> = ink_bands(best.0, best.1, ya, yb + 1, 2, &is_text).into_iter().filter(|b| b.h >= 8).collect();
                nb.sort_by(|a, b| b.h.cmp(&a.h));
                if let Some(band) = nb.first() {
                    r.name_dy = jr(band.c - f64::from(cy0));
                }
            }
        }
    }
    let view = if header.is_some() {
        if f64::from(left_dx) - if perks { -50.0 } else { 0.0 } <= -150.0 { "player" } else { "spectator" }
    } else {
        "unknown"
    };
    Align { dx, rows, cols: header, left_dx, perks, view, forced: false }
}

/// inkBands for the stat block: x0/x1 come from column centres (rounded) minus w/2, and every
/// profile column width is even, so they are whole numbers. Checked in the parity test.
fn ink_bands_f(x0: f64, x1: f64, y0: i32, y1: i32, is_ink: &dyn Fn(i32, i32) -> bool) -> Vec<Band> {
    debug_assert!(x0 == x0.trunc() && x1 == x1.trunc(), "stat block bounds must be whole: {x0} {x1}");
    ink_bands(x0 as i32, x1 as i32, y0, y1, 2, is_ink)
}

/// viewFallback(profile, view): forced BOARD VIEW setting.
pub fn view_fallback(p: &Profile, a: &mut Align, view: &'static str) {
    if view == "player" {
        let cols = STAT_FIELDS.iter().filter_map(|s| p.col(s)).map(|c| (c.field.clone(), jr(f64::from(c.x) + f64::from(c.w) / 2.0) - 183)).collect();
        a.cols = Some(Header { cols, left_dx: -282 });
        a.left_dx = -282;
    } else {
        a.cols = None;
        a.left_dx = 0;
    }
    a.view = view;
    a.forced = true;
}

#[derive(Debug, Clone)]
pub struct Cell {
    pub team: usize,
    pub row: usize,
    pub field: String,
    pub column: Column,
    pub roi: Roi,
}

/// cellRois(profile, align): `box_scale` = align.boxScale (service: settings.boxScale / 100).
pub fn cell_rois(p: &Profile, a: Option<&Align>, box_scale: Option<f64>) -> Vec<Cell> {
    let mut cells = Vec::new();
    let left = a.map_or(0, |a| a.left_dx);
    for (ti, (_, centers)) in p.teams.iter().enumerate() {
        for (row, &cy) in centers.iter().enumerate() {
            let ra = a.and_then(|a| a.rows.get(ti)).and_then(|r| r.get(row)).cloned().unwrap_or_default();
            for column in &p.columns {
                let field = column.field.as_str();
                let h = if field == "name" { p.name_cell_height.unwrap_or(p.cell_height) } else { p.cell_height };
                let lx = column.x + left;
                let (mut x, c);
                if field == "name" {
                    c = cy + ra.name_dy;
                    x = lx;
                    if let Some(nx) = ra.name_x {
                        x = (lx - 40).max((lx + 110).min(nx - 4));
                    }
                } else if STAT_FIELDS.contains(&field) {
                    c = cy + if ra.stat_dy.abs() >= 3 { ra.stat_dy } else { 0 };
                    x = match a.and_then(|a| a.cols.as_ref()).and_then(|h| h.get(field)) {
                        Some(cx) => jr(f64::from(cx) - f64::from(column.w) / 2.0),
                        None => column.x + a.map_or(0, |a| a.dx),
                    };
                } else {
                    c = cy + if ra.stat_dy.abs() >= 3 { ra.stat_dy } else { 0 };
                    x = lx;
                }
                let right = match ra.name_right {
                    Some(nr) if field == "name" => (lx + column.w).min(nr),
                    _ => lx + column.w,
                };
                let w = if field == "name" { (right - x).max(60) } else { column.w };
                let k = if field == "name" { 1.0 } else { box_scale.unwrap_or(p.box_scale).clamp(0.8, 1.3) };
                let gw = jr(f64::from(w) * k) - w;
                let gh = jr(f64::from(h) * k) - h;
                let bx = x - (f64::from(gw) / 2.0).floor() as i32;
                cells.push(Cell {
                    team: ti,
                    row,
                    field: field.to_string(),
                    column: column.clone(),
                    roi: Roi { x: bx, y: c - jr(f64::from(h) / 2.0) - (f64::from(gh) / 2.0).floor() as i32, w: w + gw, h: h + gh },
                });
            }
        }
    }
    cells
}

/// cleanDigits(text).
fn clean_digits(t: &str) -> String {
    t.chars()
        .map(|c| match c {
            'O' | 'o' => '0',
            'I' | 'l' | '|' => '1',
            'S' | 's' => '5',
            'B' => '8',
            c => c,
        })
        .filter(char::is_ascii_digit)
        .collect()
}

/// parseCell(field, text) -> Value (string / number) or None.
pub fn parse_cell(field: &str, text: &str) -> Option<Value> {
    if field == "name" {
        let name = text.split_whitespace().collect::<Vec<_>>().join(" ");
        let n = name.encode_utf16().count();
        return (2..=24).contains(&n).then(|| json!(name));
    }
    let d = clean_digits(text);
    if d.is_empty() {
        return None;
    }
    let v: f64 = d.parse().ok()?;
    if !v.is_finite() {
        return None;
    }
    let max = match field {
        "ultimate" => 100.0,
        "elims" | "assists" | "deaths" => 199.0,
        _ => 99_999.0,
    };
    (v <= max).then(|| json!(v as i64))
}

/// ringFill(sample, cx, cy, radius, { lit = 150, steps = 180 }).
pub fn ring_fill(f: &dyn Frame, cx: f64, cy: f64, radius: f64) -> f64 {
    let (lit, steps) = (150u8, 180);
    let mut run = 0;
    for i in 0..steps {
        let t = f64::from(i) / f64::from(steps) * std::f64::consts::PI * 2.0;
        let mut best = 0u8;
        for dr in [-1.5, -0.75, 0.0, 0.75, 1.5] {
            best = best.max(f.lum(jr(cx + (radius + dr) * t.sin()), jr(cy - (radius + dr) * t.cos())));
        }
        if best < lit {
            break;
        }
        run += 1;
    }
    f64::from(run) / f64::from(steps)
}

/// glyphCount(sample, roi, { bright = 120, digitWidth = 8.3 }).
pub fn glyph_count(f: &dyn Frame, roi: Roi) -> i32 {
    let (bright, digit_w) = (120u8, 8.3);
    let cy = roi.y + jr(f64::from(roi.h) / 2.0);
    let (mut count, mut start, mut tall) = (0, -1, false);
    for x in roi.x..=roi.x + roi.w + 1 {
        let (mut any, mut top) = (false, false);
        if x <= roi.x + roi.w {
            for y in cy - 6..=cy + 5 {
                if f.lum(x, y) > bright {
                    any = true;
                    if y <= cy - 2 {
                        top = true;
                    }
                }
            }
        }
        if any {
            if start < 0 {
                start = x;
            }
            tall = tall || top;
        } else if start >= 0 {
            if tall {
                count += jr(f64::from(x - start) / digit_w).max(1);
            }
            start = -1;
            tall = false;
        }
    }
    count
}

/// plausibleRead(field, value, glyphs).
pub fn plausible(field: &str, v: Option<Value>, glyphs: Option<i32>) -> Option<Value> {
    let v = v?;
    if field == "name" || v == "READY" {
        return Some(v);
    }
    match glyphs {
        None => Some(v),
        Some(g) => (isu_core::game_config::js_string(Some(&v)).len() as i32 == g).then_some(v),
    }
}

pub const READY_DISC_FILL: f64 = 0.6;

/// discFill(sample, cx, cy, radius = 12, { bright = 150 }).
pub fn disc_fill(f: &dyn Frame, cx: f64, cy: f64, radius: f64) -> f64 {
    let (mut total, mut lit) = (0, 0);
    for y in (cy - radius).floor() as i32..=(cy + radius).ceil() as i32 {
        for x in (cx - radius).floor() as i32..=(cx + radius).ceil() as i32 {
            if (f64::from(x) - cx).powi(2) + (f64::from(y) - cy).powi(2) > radius * radius {
                continue;
            }
            total += 1;
            if f.lum(x, y) > 150 {
                lit += 1;
            }
        }
    }
    if total > 0 { f64::from(lit) / f64::from(total) } else { 0.0 }
}

pub fn is_ready_disc(f: &dyn Frame, cx: f64, cy: f64, radius: f64) -> bool {
    disc_fill(f, cx, cy, radius) >= READY_DISC_FILL
}

/// resolveUltimate(printed, ring).
pub fn resolve_ultimate(printed: Option<&Value>, ring: f64) -> Option<Value> {
    if let Some(p) = printed.filter(|v| v.is_number()) {
        return Some(p.clone());
    }
    (ring >= 0.97).then(|| json!("READY"))
}

/// OverwatchConsensus.
pub struct Consensus {
    cells: HashMap<String, (Value, u32)>,
}

impl Default for Consensus {
    fn default() -> Self {
        Self { cells: HashMap::new() }
    }
}

impl Consensus {
    fn suspicious(field: &str, cur: &Value, next: &Value) -> bool {
        let (Some(c), Some(n)) = (cur.as_f64(), next.as_f64()) else { return false };
        if field == "ultimate" || field == "hero" {
            return false;
        }
        if n < c {
            return true;
        }
        let step = if matches!(field, "elims" | "assists" | "deaths") { 5.0 } else { 3000.0 };
        n - c > step
    }

    pub fn observe(&mut self, key: &str, field: &str, current: &Value, next: Option<&Value>) -> (bool, Value) {
        let Some(next) = next.filter(|v| !v.is_null()) else { return (false, current.clone()) };
        let cell = self.cells.entry(key.to_string()).or_insert_with(|| (next.clone(), 0));
        if &cell.0 != next {
            *cell = (next.clone(), 0);
        }
        cell.1 += 1;
        if current == next {
            return (true, current.clone());
        }
        let needed = if field == "name" { 3 } else if current.is_null() { 2 } else if Self::suspicious(field, current, next) { 4 } else { 2 };
        if cell.1 >= needed { (true, next.clone()) } else { (false, current.clone()) }
    }

    pub fn reset(&mut self) {
        self.cells.clear();
    }
}

pub fn empty_board() -> Value {
    let players = |side: &str| -> Value {
        Value::Array((0..5).map(|i| json!({ "side": side, "slot": i + 1, "name": "", "nameManual": false, "hero": null, "ultimate": null, "elims": null, "assists": null, "deaths": null, "damage": null, "healing": null, "mitigation": null, "updatedAt": 0 })).collect())
    };
    json!({ "teams": { "home": { "players": players("home") }, "away": { "players": players("away") } }, "updatedAt": 0 })
}

/// One raw read.
#[derive(Debug, Clone)]
pub struct Read {
    pub side: String,
    pub row: usize,
    pub field: String,
    pub value: Option<Value>,
}

/// applySweep(board, consensus, reads, now). '' counts as null.
pub fn apply_sweep(board: &mut Value, c: &mut Consensus, reads: &[Read], now: f64) -> bool {
    let mut changed = false;
    for r in reads {
        if !ALL_FIELDS.contains(&r.field.as_str()) {
            continue;
        }
        let Some(player) = board["teams"].get_mut(&r.side).and_then(|t| t["players"].get_mut(r.row)) else { continue };
        let key = format!("{}:{}:{}", r.side, r.row, r.field);
        let raw = player.get(&r.field).cloned().unwrap_or(Value::Null);
        let current = if raw == "" { Value::Null } else { raw };
        let (accept, value) = c.observe(&key, &r.field, &current, r.value.as_ref());
        if accept && value != current {
            player[&r.field] = value;
            player["updatedAt"] = isu_core::game_config::jnum(now);
            changed = true;
        }
    }
    if changed {
        board["updatedAt"] = isu_core::game_config::jnum(now);
    }
    changed
}

// --------------------------------------------------------------------- heroes ---

pub const HERO_MIN_SCORE: f64 = 0.65;
pub const HERO_MIN_GAP: f64 = 0.12;

#[derive(Debug, Clone, PartialEq)]
pub struct HeroMatch {
    pub hero: Option<String>,
    pub candidate: Option<String>,
    pub score: f64,
    pub runner_up: f64,
    pub gap: f64,
}

/// HeroMatcher (window x 590, w 50, halfH 24; offsets x 8..14, y 4..16 step 2).
pub struct HeroMatcher {
    window: (i32, i32, i32),
    cuts: Vec<(String, Vec<Vec<f32>>)>,
}

/// normalise(values): mean-removed (per channel), unit length. f32 like the JS Float32Array.
fn normalise(values: &[f32]) -> Vec<f32> {
    let n = (values.len() / 3) as f64;
    let mut mean = [0f64; 3];
    for (i, v) in values.iter().enumerate() {
        mean[i % 3] += f64::from(*v);
    }
    for m in &mut mean {
        *m /= n;
    }
    let mut out = vec![0f32; values.len()];
    let mut norm = 0f64;
    for (i, v) in values.iter().enumerate() {
        let d = (f64::from(*v) - mean[i % 3]) as f32;
        out[i] = d;
        norm += f64::from(d) * f64::from(d);
    }
    let norm = { let s = norm.sqrt(); if s == 0.0 { 1.0 } else { s } };
    for o in &mut out {
        *o = (f64::from(*o) / norm) as f32;
    }
    out
}

impl HeroMatcher {
    pub fn load(dir: &Path) -> anyhow::Result<Self> {
        let meta: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("overwatch-hero-templates.json"))?)?;
        let blob = std::fs::read(dir.join("overwatch-hero-templates.bin"))?;
        let s = meta["size"].as_u64().unwrap() as usize;
        let stride = s * s * 3;
        let (wx, ww, hh) = (590, 50usize, 24usize);
        let h = hh * 2;
        let cuts = meta["heroes"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(i, name)| {
                let rgb = &blob[i * stride..(i + 1) * stride];
                let mut variants = Vec::new();
                let mut oy = 4;
                while oy <= 16.min(s - h) {
                    let mut ox = 8;
                    while ox <= 14.min(s - ww) {
                        let mut v = Vec::with_capacity(ww * h * 3);
                        for y in 0..h {
                            for x in 0..ww {
                                let o = ((oy + y) * s + ox + x) * 3;
                                v.extend([f32::from(rgb[o]), f32::from(rgb[o + 1]), f32::from(rgb[o + 2])]);
                            }
                        }
                        variants.push(normalise(&v));
                        ox += 2;
                    }
                    oy += 2;
                }
                (name.as_str().unwrap().to_string(), variants)
            })
            .collect();
        Ok(Self { window: (wx, ww as i32, hh as i32), cuts })
    }

    /// match(rgbAt, rowCenter). `shift` = align.leftDx (the JS wraps rgbAt with x + shift).
    pub fn match_row(&self, f: &dyn Frame, row_center: i32, shift: i32) -> HeroMatch {
        let (x0, w, half) = self.window;
        let mut raw = Vec::with_capacity((w * half * 2 * 3) as usize);
        for y in 0..half * 2 {
            for x in 0..w {
                let p = f.rgb(x0 + x + shift, row_center - half + y);
                raw.extend([f32::from(p[0]), f32::from(p[1]), f32::from(p[2])]);
            }
        }
        let board = normalise(&raw);
        let (mut best, mut best_score, mut second) = (None::<&str>, -1f64, -1f64);
        for (hero, variants) in &self.cuts {
            let mut top = -1f64;
            for v in variants {
                // JS: dot accumulated in a double (plain number), products of f32 values
                let mut dot = 0f64;
                for i in 0..v.len() {
                    dot += f64::from(v[i]) * f64::from(board[i]);
                }
                if dot > top {
                    top = dot;
                }
            }
            if top > best_score {
                second = best_score;
                best_score = top;
                best = Some(hero);
            } else if top > second {
                second = top;
            }
        }
        let gap = best_score - second;
        let ok = best_score >= HERO_MIN_SCORE && gap >= HERO_MIN_GAP;
        let r2 = |x: f64| (x * 100.0 + 0.5).floor() / 100.0;
        HeroMatch { hero: if ok { best.map(str::to_string) } else { None }, candidate: best.map(str::to_string), score: r2(best_score), runner_up: r2(second), gap: r2(gap) }
    }
}

/// The OCR input for an Overwatch cell, exactly as test/overwatch-ocr.test.cjs cellImageFrom builds
/// it from the live preprocessing: bilinear `scale`x, invert (255 - lum), `v < threshold` = ink, 20 px
/// border, optional shear (rows shifted by round(shear * (y - H/2))).
pub fn cell_image(f: &dyn Frame, roi: Roi, scale: i32, threshold: u8, shear: f64) -> crate::tess::Gray {
    let pad = 20usize;
    let (iw, ih) = ((roi.w * scale) as usize, (roi.h * scale) as usize);
    let (w, h) = (iw + pad * 2, ih + pad * 2);
    let s = f64::from(scale);
    let mut inner = vec![255u8; iw * ih];
    for y in 0..ih {
        for x in 0..iw {
            let fx = f64::from(roi.x) + (x as f64 + 0.5) / s - 0.5;
            let fy = f64::from(roi.y) + (y as f64 + 0.5) / s - 0.5;
            let (x0, y0) = (fx.floor() as i32, fy.floor() as i32);
            let (tx, ty) = (fx - f64::from(x0), fy - f64::from(y0));
            let l = |a, b| f64::from(f.lum(a, b));
            let lum = l(x0, y0) * (1.0 - tx) * (1.0 - ty) + l(x0 + 1, y0) * tx * (1.0 - ty) + l(x0, y0 + 1) * (1.0 - tx) * ty + l(x0 + 1, y0 + 1) * tx * ty;
            inner[y * iw + x] = if 255.0 - lum < f64::from(threshold) { 0 } else { 255 };
        }
    }
    let mut px = vec![255u8; w * h];
    for y in 0..ih {
        let shift = if shear != 0.0 { jr(shear * (y as f64 - ih as f64 / 2.0)) } else { 0 };
        for x in 0..iw {
            let sx = x as i32 - shift;
            if sx >= 0 && (sx as usize) < iw {
                px[(y + pad) * w + x + pad] = inner[y * iw + sx as usize];
            }
        }
    }
    crate::tess::Gray { w, h, px }
}
