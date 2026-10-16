//! VALORANT scoreboard reader: electron/valorant-board-parse.cjs (PROFILE, findHeader, snapRow,
//! alignBoard, cellRois, creditsRoi, glyphCount, plausibleRead, parseCell, readCell) and the
//! cell image the test fixtures / live capture feed Tesseract (test/valorant-board-fixtures.cjs cellImage).
use crate::tess::{Gray, Tess};

/// A frame: luminance + RGB lookups on the 1920x1080 grid (outside = 0, like frameLuminance).
pub trait Frame: Sync {
    fn lum(&self, x: i32, y: i32) -> u8;
    fn rgb(&self, x: i32, y: i32) -> [u8; 3];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Icon,
    Text,
    Ult,
    Count,
    Credits,
}

#[derive(Debug, Clone, Copy)]
pub struct Column {
    pub x: i32,
    pub w: i32,
    pub h: Option<i32>,
    pub kind: Kind,
    pub allowed: &'static str,
    pub lang: Option<&'static str>,
}

/// PROFILE (measured on the ISU observer screenshot, 1080p grid).
pub struct Profile {
    pub header_y: i32,
    pub header_labels: [i32; 6],
    pub row_offsets: [[i32; 5]; 2],
    pub cell_height: i32,
    pub text_threshold: u8,
}

pub const PROFILE: Profile = Profile {
    header_y: 314,
    header_labels: [658, 866, 986, 1120, 1242, 1317],
    row_offsets: [[32, 66, 100, 134, 168], [262, 296, 331, 365, 398]],
    cell_height: 18,
    text_threshold: 175,
};
pub const WIDTH: i32 = 1920;

pub const AGENT: Column = Column { x: 567, w: 32, h: None, kind: Kind::Icon, allowed: "", lang: None };
pub const LOADOUT: Column = Column { x: 1035, w: 122, h: None, kind: Kind::Icon, allowed: "", lang: None };
pub const SHIELD: Column = Column { x: 1150, w: 64, h: None, kind: Kind::Icon, allowed: "", lang: None };

/// READ_FIELDS in order, with their columns.
pub const READ_FIELDS: [(&str, Column); 7] = [
    ("name", Column { x: 634, w: 190, h: None, kind: Kind::Text, allowed: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 _.#", lang: Some("val") }),
    ("ultimate", Column { x: 842, w: 56, h: None, kind: Kind::Ult, allowed: "0123456789/READY", lang: None }),
    ("kills", Column { x: 936, w: 24, h: Some(14), kind: Kind::Count, allowed: "0123456789", lang: None }),
    ("deaths", Column { x: 976, w: 24, h: Some(14), kind: Kind::Count, allowed: "0123456789", lang: None }),
    ("assists", Column { x: 1016, w: 24, h: Some(14), kind: Kind::Count, allowed: "0123456789", lang: None }),
    ("credits", Column { x: 1229, w: 44, h: Some(14), kind: Kind::Credits, allowed: "0123456789,", lang: None }),
    ("ping", Column { x: 1302, w: 30, h: Some(14), kind: Kind::Count, allowed: "0123456789", lang: None }),
];

pub const SIDES: [&str; 2] = ["home", "away"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Roi {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Debug, Clone)]
pub struct Align {
    pub found: bool,
    pub dx: i32,
    pub dy: i32,
    /// rows[side][row] = centre y
    pub rows: [[i32; 5]; 2],
}

fn js_round(x: f64) -> i32 {
    (x + 0.5).floor() as i32
}

/// findHeader(lum, profile): (dx, dy) of the header line, or None.
fn find_header(f: &dyn Frame, p: &Profile) -> Option<(i32, i32)> {
    let (search_y, search_x) = (60, 80);
    let thr = p.text_threshold;
    let x0 = (p.header_labels[0] - search_x - 40).max(0);
    let x1 = (p.header_labels[5] + search_x + 40).min(WIDTH);
    let mut best: Option<(i32, i32, f64)> = None; // (y, dx, err)
    let mut ink = vec![0u8; (x1 - x0) as usize];
    for y in p.header_y - search_y..=p.header_y + search_y {
        ink.iter_mut().for_each(|v| *v = 0);
        for dy in -3..=3 {
            for x in x0..x1 {
                if f.lum(x, y + dy) >= thr {
                    ink[(x - x0) as usize] = 1;
                }
            }
        }
        let mut runs: Vec<(i32, i32)> = Vec::new();
        let (mut s, mut gap_at) = (-1i32, -1i32);
        let n = ink.len() as i32;
        for i in 0..=n {
            let on = i < n && ink[i as usize] != 0;
            if on {
                if s < 0 {
                    s = i;
                }
                gap_at = -1;
                continue;
            }
            if s >= 0 {
                if gap_at < 0 {
                    gap_at = i;
                }
                if i - gap_at > 9 || i == n {
                    runs.push((s + x0, gap_at - 1 + x0));
                    s = -1;
                    gap_at = -1;
                }
            }
        }
        let centres: Vec<f64> = runs.iter().filter(|(a, b)| b - a >= 12 && b - a <= 80).map(|(a, b)| f64::from(a + b) / 2.0).collect();
        if centres.len() < 6 {
            continue;
        }
        for i in 0..=centres.len() - 6 {
            let run = &centres[i..i + 6];
            let dx = run[0] - f64::from(p.header_labels[0]);
            let err = run.iter().zip(p.header_labels).map(|(c, l)| (c - f64::from(l) - dx).abs()).sum::<f64>() / 6.0;
            let better = match best {
                None => true,
                Some((by, _, be)) => err < be - 0.5 || ((err - be).abs() <= 0.5 && (y - p.header_y).abs() < (by - p.header_y).abs()),
            };
            if err <= 6.0 && better {
                best = Some((y, js_round(dx), err));
            }
        }
    }
    let (by, dx, _) = best?;
    let has_ink = |y: i32| {
        let mut n = 0;
        for c in p.header_labels {
            for x in c - 10..=c + 10 {
                if f.lum(x + dx, y) >= thr {
                    n += 1;
                }
            }
        }
        n >= 6
    };
    let (mut top, mut bottom) = (by, by);
    while top > by - 12 && has_ink(top - 1) {
        top -= 1;
    }
    while bottom < by + 12 && has_ink(bottom + 1) {
        bottom += 1;
    }
    Some((dx, js_round(f64::from(top + bottom) / 2.0 - f64::from(p.header_y))))
}

/// snapRow(lum, profile, cy, dx, search = 9).
fn snap_row(f: &dyn Frame, p: &Profile, cy: i32, dx: i32) -> i32 {
    let search = 9;
    let cols = [READ_FIELDS[2].1, READ_FIELDS[3].1, READ_FIELDS[4].1];
    let mut bands = Vec::new();
    let mut top = -1;
    for y in cy - search - 9..=cy + search + 10 {
        let mut n = 0;
        for c in &cols {
            for x in c.x + dx..c.x + c.w + dx {
                if f.lum(x, y) >= p.text_threshold {
                    n += 1;
                }
            }
        }
        if n >= 2 && top < 0 {
            top = y;
        }
        if n < 2 && top >= 0 {
            bands.push((top, y - 1));
            top = -1;
        }
    }
    let mut good: Vec<i32> = bands.iter().filter(|(a, b)| b - a >= 6 && b - a <= 16).map(|(a, b)| js_round(f64::from(a + b) / 2.0 - f64::from(cy))).filter(|c| c.abs() <= search).collect();
    good.sort_by_key(|c| c.abs()); // stable, like Array.prototype.sort
    good.first().copied().unwrap_or(0)
}

/// alignBoard(lum, profile).
pub fn align_board(f: &dyn Frame) -> Align {
    let p = &PROFILE;
    let header = find_header(f, p);
    let (dx, dy) = header.unwrap_or((0, 0));
    let mut rows = [[0; 5]; 2];
    for (s, offs) in p.row_offsets.iter().enumerate() {
        for (r, off) in offs.iter().enumerate() {
            let cy = p.header_y + dy + off;
            rows[s][r] = cy + snap_row(f, p, cy, dx);
        }
    }
    Align { found: header.is_some(), dx, dy, rows }
}

#[derive(Debug, Clone, Copy)]
pub struct Cell {
    pub side: usize,
    pub row: usize,
    pub field: &'static str,
    pub column: Column,
    pub roi: Roi,
}

/// cellRois(profile, align): side by side, row by row, READ_FIELDS order.
pub fn cell_rois(a: &Align) -> Vec<Cell> {
    let p = &PROFILE;
    let mut cells = Vec::with_capacity(70);
    for side in 0..2 {
        for row in 0..5 {
            let cy = a.rows[side][row];
            for (field, column) in READ_FIELDS {
                let h = column.h.unwrap_or(p.cell_height + if field == "name" { 4 } else { 0 });
                cells.push(Cell { side, row, field, column, roi: Roi { x: column.x + a.dx, y: js_round(f64::from(cy) - f64::from(h) / 2.0), w: column.w, h } });
            }
        }
    }
    cells
}

/// creditsRoi(lum, roi, { thr = 150 }).
pub fn credits_roi(f: &dyn Frame, roi: Roi) -> Option<Roi> {
    let thr = 150;
    let (x0, x1) = (roi.x - 10, roi.x + roi.w + 6);
    struct Run {
        x0: i32,
        x1: i32,
        h: i32,
    }
    let mut runs: Vec<Run> = Vec::new();
    let (mut s, mut top, mut bot) = (-1, i32::MAX, -1);
    for x in x0..=x1 {
        let mut on = false;
        if x < x1 {
            for y in roi.y - 2..roi.y + roi.h + 2 {
                if f.lum(x, y) >= thr {
                    on = true;
                    top = top.min(y);
                    bot = bot.max(y);
                }
            }
        }
        if on && s < 0 {
            s = x;
        }
        if !on && s >= 0 {
            runs.push(Run { x0: s, x1: x - 1, h: bot - top + 1 });
            s = -1;
            top = i32::MAX;
            bot = -1;
        }
    }
    let tall: Vec<&Run> = runs.iter().filter(|r| r.h >= 6).collect();
    if tall.is_empty() {
        return None;
    }
    let hmax = tall.iter().map(|r| r.h).max().unwrap();
    let mut i = 0;
    while i < tall.len() - 1 && tall[i].h <= hmax - 2 && tall[i].x1 - tall[i].x0 <= 9 {
        i += 1;
    }
    let digits: Vec<&&Run> = tall[i..].iter().filter(|r| r.h >= hmax - 2).collect();
    let first = digits.first()?;
    let a = first.x0 - 2;
    let b = runs.last().unwrap().x1 + 3;
    Some(Roi { x: a, y: roi.y, w: (b - a).max(6), h: roi.h })
}

/// glyphCount(lum, roi, { thr, digitWidth = 7.5, minH = 6 }).
pub fn glyph_count(f: &dyn Frame, roi: Roi, thr: u8) -> i32 {
    let (digit_w, min_h) = (7.5, 6);
    let (mut count, mut start, mut top, mut bottom) = (0, -1, i32::MAX, -1);
    for x in roi.x..=roi.x + roi.w {
        let mut on = false;
        if x < roi.x + roi.w {
            for y in roi.y..roi.y + roi.h {
                if f.lum(x, y) >= thr {
                    on = true;
                    top = top.min(y);
                    bottom = bottom.max(y);
                }
            }
        }
        if on && start < 0 {
            start = x;
        }
        if !on && start >= 0 {
            if bottom - top + 1 >= min_h {
                count += js_round(f64::from(x - start) / digit_w).max(1);
            }
            start = -1;
            top = i32::MAX;
            bottom = -1;
        }
    }
    count
}

/// A parsed cell value (JS: string | number | null).
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Text(String),
    Num(i64),
}

impl Value {
    pub fn to_json(&self) -> serde_json::Value {
        match self {
            Value::Text(s) => serde_json::Value::String(s.clone()),
            Value::Num(n) => serde_json::Value::from(*n),
        }
    }
    fn len(&self) -> usize {
        match self {
            Value::Text(s) => s.chars().count(),
            Value::Num(n) => n.to_string().len(),
        }
    }
}

fn digits(t: &str) -> String {
    t.chars()
        .map(|c| match c {
            'O' | 'o' => '0',
            'I' | 'l' | '|' => '1',
            'S' | 's' => '5',
            c => c,
        })
        .filter(char::is_ascii_digit)
        .collect()
}

/// parseCell(field, text).
pub fn parse_cell(field: &str, text: &str) -> Option<Value> {
    let raw = text.trim();
    match field {
        "name" => {
            let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
            // JS: .replace(/\s+/g, ' ') keeps a single space where tabs/newlines were (trimmed first)
            let name: String = collapsed.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '.' | '#')).collect();
            let name = name.trim().to_string();
            (name.chars().count() >= 2).then_some(Value::Text(name))
        }
        "ultimate" => {
            let up = raw.to_ascii_uppercase();
            let letters = raw.chars().filter(char::is_ascii_alphabetic).count();
            if ult_ready_re(&up) || (letters >= 4 && !raw.chars().any(|c| c.is_ascii_digit())) {
                return Some(Value::Text("READY".into()));
            }
            let t: String = raw
                .chars()
                .map(|c| match c {
                    'O' | 'o' => '0',
                    'I' | 'l' | '|' => '1',
                    c => c,
                })
                .filter(|c| !c.is_ascii_alphabetic())
                .collect();
            let mut m: Option<(u32, u32)> = clean_ult(&t);
            if m.is_none() {
                let d: Vec<u32> = t.chars().filter_map(|c| c.to_digit(10)).collect();
                if (3..=4).contains(&d.len()) {
                    m = Some((d[0], d[d.len() - 1]));
                }
            }
            let (cur, req) = m?;
            if !(5..=9).contains(&req) || cur > req {
                return None;
            }
            Some(Value::Text(if cur == req { "READY".into() } else { format!("{cur}/{req}") }))
        }
        _ => {
            let d = digits(raw);
            if d.is_empty() {
                return None;
            }
            let v: f64 = d.parse().ok()?; // Number('0012') = 12; huge strings stay huge (rejected below)
            match field {
                "credits" => (v <= 9000.0 && v % 50.0 == 0.0).then_some(Value::Num(v as i64)),
                "ping" => (v <= 999.0).then_some(Value::Num(v as i64)),
                _ => (v <= 99.0).then_some(Value::Num(v as i64)),
            }
        }
    }
}

/// /READY|R?EAD?Y|RE?ADY/i on an upper-cased string. Expanded: every string those three
/// alternatives match is one of READY, EADY, EAY, REAY, RADY; a search hit = one of them is a substring.
fn ult_ready_re(up: &str) -> bool {
    ["READY", "EADY", "EAY", "REAY", "RADY"].iter().any(|p| up.contains(p))
}

/// /^(\d)\s*\/\s*(\d)$/
fn clean_ult(t: &str) -> Option<(u32, u32)> {
    let (a, b) = t.split_once('/')?;
    let (a, b) = (a.trim(), b.trim());
    // JS \s*: only whitespace allowed around the slash, exactly one digit each side
    if a.len() == 1 && b.len() == 1 && t.trim() == t {
        return Some((a.chars().next()?.to_digit(10)?, b.chars().next()?.to_digit(10)?));
    }
    None
}

/// plausibleRead(field, value, glyphs): numbers must have exactly the pixel digit count.
fn plausible(field: &str, v: Option<Value>, glyphs: Option<i32>) -> Option<Value> {
    let v = v?;
    match (field, glyphs) {
        ("name" | "ultimate", _) | (_, None) => Some(v),
        (_, Some(g)) => (v.len() as i32 == g).then_some(v),
    }
}

/// The OCR input: test/valorant-board-fixtures.cjs cellImage = lum -> bilinear `scale`x ->
/// `>= threshold` is ink -> black on white, 16 px white border. This is the path the JS accuracy
/// tests prove on Derk's frames. NOT identical to the Electron live path
/// (valorant-capture.cjs preprocessNativeImage: Electron 'best' resize, `> threshold`, no border),
/// which cannot be reproduced bit for bit outside Electron. See rust/README.md "OCR input".
pub fn cell_image(f: &dyn Frame, roi: Roi, scale: i32, threshold: u8) -> Gray {
    let pad = 16;
    let (w, h) = ((roi.w * scale + pad * 2) as usize, (roi.h * scale + pad * 2) as usize);
    let mut px = vec![255u8; w * h];
    let s = f64::from(scale);
    for y in 0..roi.h * scale {
        for x in 0..roi.w * scale {
            let fx = f64::from(roi.x) + (f64::from(x) + 0.5) / s - 0.5;
            let fy = f64::from(roi.y) + (f64::from(y) + 0.5) / s - 0.5;
            let (x0, y0) = (fx.floor() as i32, fy.floor() as i32);
            let (tx, ty) = (fx - f64::from(x0), fy - f64::from(y0));
            let l = |xx, yy| f64::from(f.lum(xx, yy));
            let v = l(x0, y0) * (1.0 - tx) * (1.0 - ty) + l(x0 + 1, y0) * tx * (1.0 - ty) + l(x0, y0 + 1) * (1.0 - tx) * ty + l(x0 + 1, y0 + 1) * tx * ty;
            px[(y + pad) as usize * w + (x + pad) as usize] = if v >= f64::from(threshold) { 0 } else { 255 };
        }
    }
    Gray { w, h, px }
}

/// NUMBER_LADDER / TEXT_LADDER ([threshold, scale]).
const NUMBER_LADDER: [(u8, i32); 6] = [(150, 4), (175, 4), (125, 4), (175, 6), (110, 5), (150, 6)];
const TEXT_LADDER: [(u8, i32); 3] = [(175, 4), (150, 4), (130, 4)];

/// The OCR engines a sweep needs: one per language ('eng', 'val').
pub trait Ocr {
    fn tess(&mut self, lang: Option<&str>) -> &mut Tess;
}

/// readCell(ocr, lum, cell, makeImage): a value, or None when not sure (never a guess).
pub fn read_cell(ocr: &mut dyn Ocr, f: &dyn Frame, mut cell: Cell) -> Option<Value> {
    let is_text = cell.field == "name";
    if cell.field == "credits" {
        cell.roi = credits_roi(f, cell.roi)?;
    }
    let g = if is_text || cell.field == "ultimate" { None } else { Some(glyph_count(f, cell.roi, 150)) };
    if g == Some(0) {
        return Some(Value::Num(0));
    }
    let ladder: &[(u8, i32)] = if is_text { &TEXT_LADDER } else { &NUMBER_LADDER };
    for &(thr, scale) in ladder {
        let img = cell_image(f, cell.roi, scale, thr);
        let r = ocr.tess(cell.column.lang).recognize(&img, cell.column.allowed, g == Some(1));
        if r.confidence < if is_text { 0.6 } else { 0.7 } {
            continue;
        }
        if let Some(v) = plausible(cell.field, parse_cell(cell.field, &r.text), g) {
            return Some(v);
        }
    }
    None
}

/// blockColor(rgb, profile, align, side): 'teal' (defenders) | 'red' (attackers) | '' (not sure).
pub fn block_color(f: &dyn Frame, a: &Align, side: usize) -> &'static str {
    let p = &PROFILE;
    let (mut teal, mut red, mut n) = (0, 0, 0);
    let name = READ_FIELDS[0].1;
    for off in p.row_offsets[side] {
        let cy = p.header_y + a.dy + off;
        let mut x = AGENT.x + 40 + a.dx;
        while x < name.x + name.w + a.dx {
            for dy in [-6, 6] {
                let [r, g, b] = f.rgb(x, cy + dy).map(i32::from);
                if r + g + b < 120 {
                    continue;
                }
                n += 1;
                if g > r + 18 && b > r + 10 {
                    teal += 1;
                } else if r > g + 18 && r > b + 10 {
                    red += 1;
                }
            }
            x += 4;
        }
    }
    let n = f64::from(n);
    if n < 20.0 {
        ""
    } else if teal > red * 2 && f64::from(teal) >= n * 0.25 {
        "teal"
    } else if red > teal * 2 && f64::from(red) >= n * 0.25 {
        "red"
    } else {
        ""
    }
}
