//! electron/valorant-board-parse.cjs BoardConsensus / emptyBoard / applySweep and
//! electron/valorant-board-identity.cjs BoardIdentity (follow players, not rows).
//! The board is JSON (same shape the JS service publishes): teams.home/away.players[5].
use std::collections::HashMap;

use serde_json::{Value, json};

/// One read of one cell in one sweep. value None = not sure.
#[derive(Debug, Clone, PartialEq)]
pub struct Read {
    pub side: usize,
    pub row: usize,
    pub field: &'static str,
    pub value: Option<Value>,
    /// set by remap: the board row this read came from
    pub board_row: Option<usize>,
}

pub const SIDE_NAMES: [&str; 2] = ["home", "away"];

/// emptyPlayer / emptyBoard.
pub fn empty_board() -> Value {
    let players = |side: &str| -> Value {
        Value::Array(
            (0..5)
                .map(|i| json!({ "side": side, "row": i, "agent": null, "weapon": null, "shield": null, "name": "", "ultimate": null, "kills": null, "deaths": null, "assists": null, "credits": null, "ping": null, "updatedAt": 0 }))
                .collect(),
        )
    };
    json!({ "updatedAt": 0, "teams": { "home": { "players": players("home") }, "away": { "players": players("away") } } })
}

/// BoardConsensus({ first = 2, change = 2, correction = 4, nameReads = 3 }).
pub struct Consensus {
    first: u32,
    change: u32,
    correction: u32,
    name_reads: u32,
    cells: HashMap<String, (Value, u32)>, // key -> (candidate, streak)
}

impl Default for Consensus {
    fn default() -> Self {
        Self { first: 2, change: 2, correction: 4, name_reads: 3, cells: HashMap::new() }
    }
}

fn is_count(field: &str) -> bool {
    matches!(field, "kills" | "deaths" | "assists")
}

impl Consensus {
    /// suspicious(field, current, next): K/D/A going down or jumping more than 5.
    fn suspicious(field: &str, cur: &Value, next: &Value) -> bool {
        match (cur.as_f64(), next.as_f64()) {
            (Some(c), Some(n)) if is_count(field) => n < c || n - c > 5.0,
            _ => false,
        }
    }

    /// observe(key, field, current, next) -> (accept, value).
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
        let needed = if field == "name" {
            self.name_reads
        } else if current.is_null() {
            self.first
        } else if Self::suspicious(field, current, next) {
            self.correction
        } else {
            self.change
        };
        if cell.1 >= needed { (true, next.clone()) } else { (false, current.clone()) }
    }
}

/// applySweep(board, consensus, reads, now) -> changed.
pub fn apply_sweep(board: &mut Value, c: &mut Consensus, reads: &[Read], now: f64) -> bool {
    let mut changed = false;
    for r in reads {
        let Some(player) = board["teams"][SIDE_NAMES[r.side]]["players"].get_mut(r.row) else { continue };
        if r.field == "name" && player.get("nameManual").is_some_and(|v| v.as_bool() == Some(true)) {
            continue;
        }
        let key = format!("{}:{}:{}", SIDE_NAMES[r.side], r.row, r.field);
        let cur = player.get(r.field).cloned().unwrap_or(Value::Null);
        let (accept, value) = c.observe(&key, r.field, &cur, r.value.as_ref());
        if accept && cur != value {
            player[r.field] = value;
            player["updatedAt"] = isu_core::game_config::jnum(now);
            changed = true;
        }
    }
    if changed {
        board["updatedAt"] = isu_core::game_config::jnum(now);
    }
    changed
}

// ------------------------------------------------------------------ identity ---

fn norm(v: &str) -> String {
    v.chars().filter(|c| c.is_ascii_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// valorant-board-identity.cjs tagSimilarity (plain Levenshtein on norm(), no O->0 folding).
pub fn tag_similarity(a: &str, b: &str) -> f64 {
    let (x, y): (Vec<char>, Vec<char>) = (norm(a).chars().collect(), norm(b).chars().collect());
    if x.is_empty() || y.is_empty() {
        return 0.0;
    }
    if x == y {
        return 1.0;
    }
    let mut prev: Vec<usize> = (0..=y.len()).collect();
    for i in 1..=x.len() {
        let mut cur = vec![i];
        for j in 1..=y.len() {
            cur.push((prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + usize::from(x[i - 1] != y[j - 1])));
        }
        prev = cur;
    }
    1.0 - prev[y.len()] as f64 / x.len().max(y.len()) as f64
}

pub const MATCH: f64 = 0.75;
pub const MARGIN: f64 = 0.1;

#[derive(Debug, Clone, Default)]
struct Slot {
    tag: String,
    row_now: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Move {
    pub side: usize,
    pub slot: usize,
    pub tag: String,
    pub from: usize,
    pub to: usize,
}

pub struct Identity {
    slots: [[Slot; 5]; 2],
    known: [Vec<String>; 2],
    pub last_moves: Vec<Move>,
}

impl Default for Identity {
    fn default() -> Self {
        let slots = || std::array::from_fn(|i| Slot { tag: String::new(), row_now: i });
        Self { slots: [slots(), slots()], known: [Vec::new(), Vec::new()], last_moves: Vec::new() }
    }
}

struct Hit {
    tag: String,
    slot: Option<usize>,
    score: f64,
}

impl Identity {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn set_known_names(&mut self, home: &[String], away: &[String]) {
        for (s, list) in [home, away].iter().enumerate() {
            self.known[s] = list.iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
        }
    }

    pub fn confirm(&mut self, side: usize, slot: usize, name: &str) {
        if !name.is_empty() {
            if let Some(s) = self.slots[side].get_mut(slot) {
                s.tag = name.to_string();
            }
        }
    }

    pub fn clear_tag(&mut self, side: usize, slot: usize) {
        self.slots[side][slot].tag.clear();
    }

    pub fn row_of(&self, side: usize, slot: usize) -> usize {
        self.slots[side][slot].row_now
    }

    fn best_for(&self, side: usize, raw: &str) -> Option<Hit> {
        let mut cands: Vec<(String, Option<usize>)> = Vec::new();
        for (i, s) in self.slots[side].iter().enumerate() {
            if !s.tag.is_empty() {
                cands.push((s.tag.clone(), Some(i)));
            }
        }
        for k in &self.known[side] {
            if !cands.iter().any(|(t, _)| norm(t) == norm(k)) {
                cands.push((k.clone(), None));
            }
        }
        let mut best: Option<Hit> = None;
        let mut second = 0.0;
        for (tag, slot) in cands {
            let sc = tag_similarity(raw, &tag);
            match &best {
                None => best = Some(Hit { tag, slot, score: sc }),
                Some(b) if sc > b.score => {
                    second = b.score;
                    best = Some(Hit { tag, slot, score: sc });
                }
                Some(_) => {
                    if sc > second {
                        second = sc;
                    }
                }
            }
        }
        let b = best?;
        (b.score >= MATCH && b.score - second >= MARGIN).then_some(b)
    }

    /// remap(reads): re-key every read from its board row to the player slot sitting there now.
    pub fn remap(&mut self, reads: &mut [Read]) {
        self.last_moves.clear();
        for side in 0..2 {
            // names in first-seen order (JS Map from the reads)
            let mut names: Vec<(usize, String)> = Vec::new();
            for r in reads.iter().filter(|r| r.side == side && r.field == "name") {
                if let Some(Value::String(v)) = &r.value {
                    if !v.is_empty() {
                        if let Some(e) = names.iter_mut().find(|(row, _)| *row == r.row) {
                            e.1.clone_from(v);
                        } else {
                            names.push((r.row, v.clone()));
                        }
                    }
                }
            }
            let row_to_slot: HashMap<usize, usize> = self.slots[side].iter().enumerate().map(|(i, s)| (s.row_now, i)).collect();
            let mut claims: Vec<(usize, Option<usize>, f64)> = Vec::new(); // (row, slot, score)
            for (row, raw) in &names {
                if let Some(h) = self.best_for(side, raw) {
                    claims.push((*row, h.slot, h.score));
                    let _ = h.tag;
                }
            }
            claims.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
            let (mut used_row, mut used_slot) = (Vec::new(), Vec::new());
            let mut next: Vec<(usize, usize)> = Vec::new(); // (row, slot), insertion order
            for (row, slot, _) in claims {
                if used_row.contains(&row) {
                    continue;
                }
                let slot = match slot {
                    Some(s) => s,
                    None => {
                        let here = row_to_slot.get(&row).copied();
                        let pick = match here {
                            Some(h) if self.slots[side][h].tag.is_empty() && !used_slot.contains(&h) => Some(h),
                            _ => (0..5).find(|&i| self.slots[side][i].tag.is_empty() && !used_slot.contains(&i)),
                        };
                        match pick {
                            Some(p) => p,
                            None => continue,
                        }
                    }
                };
                if used_slot.contains(&slot) {
                    continue;
                }
                used_row.push(row);
                used_slot.push(slot);
                next.push((row, slot));
            }
            let mut free_slots: Vec<usize> = (0..5).filter(|i| !used_slot.contains(i)).collect();
            let mut free_rows: Vec<usize> = (0..5).filter(|r| !used_row.contains(r)).collect();
            for i in free_slots.clone() {
                let r = self.slots[side][i].row_now;
                if let Some(p) = free_rows.iter().position(|x| *x == r) {
                    next.push((r, i));
                    free_rows.remove(p);
                    free_slots.retain(|x| *x != i);
                }
            }
            for (k, i) in free_slots.iter().enumerate() {
                if let Some(r) = free_rows.get(k) {
                    next.push((*r, *i));
                }
            }
            // JS: a Map keyed by row, so a later set for the same row wins; iteration = first insertion order
            let mut by_row: Vec<(usize, usize)> = Vec::new();
            for (r, s) in next {
                if let Some(e) = by_row.iter_mut().find(|(rr, _)| *rr == r) {
                    e.1 = s;
                } else {
                    by_row.push((r, s));
                }
            }
            for &(row, slot) in &by_row {
                let s = &mut self.slots[side][slot];
                if s.row_now != row {
                    self.last_moves.push(Move { side, slot, tag: s.tag.clone(), from: s.row_now, to: row });
                }
                s.row_now = row;
            }
            for r in reads.iter_mut().filter(|r| r.side == side) {
                if let Some(&(_, sl)) = by_row.iter().find(|(row, _)| *row == r.row) {
                    r.board_row = Some(r.row);
                    r.row = sl;
                }
            }
        }
    }
}
