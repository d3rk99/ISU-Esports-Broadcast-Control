//! Parity of isu-ocr icons / block colours / consensus / identity with the real JS
//! (parity-board.json from `node rust/scripts/parity-board.cjs`, on Derk's real frames).
use std::path::Path;

use isu_ocr::board::{self, Frame, Roi};
use isu_ocr::consensus::{Consensus, Identity, Read, apply_sweep, empty_board};
use isu_ocr::icons::{AgentMatcher, GearMatcher};
use serde_json::{Value, json};

struct Img { w: i32, h: i32, rgb: Vec<u8> }
impl Frame for Img {
    fn rgb(&self, x: i32, y: i32) -> [u8; 3] { let (lx, ly) = (x - 500, y - 280); if lx < 0 || ly < 0 || lx >= self.w || ly >= self.h { return [0, 0, 0]; } let o = ((ly * self.w + lx) * 3) as usize; [self.rgb[o], self.rgb[o + 1], self.rgb[o + 2]] }
    fn lum(&self, x: i32, y: i32) -> u8 { let p = self.rgb(x, y); ((f64::from(p[0]) * 0.299 + f64::from(p[1]) * 0.587 + f64::from(p[2]) * 0.114) + 0.5).floor() as u8 }
}
fn repo() -> std::path::PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..") }
fn load(f: &str) -> Img {
    let d = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(repo().join("test/fixtures").join(f)).unwrap()));
    let mut r = d.read_info().unwrap(); let mut buf = vec![0; r.output_buffer_size().unwrap()]; let info = r.next_frame(&mut buf).unwrap(); let ch = info.color_type.samples();
    Img { w: info.width as i32, h: info.height as i32, rgb: buf[..info.buffer_size()].chunks(ch).flat_map(|c| [c[0], c[1 % ch], c[2 % ch]]).collect() }
}
fn cases() -> Value { serde_json::from_str(include_str!("parity-board.json")).unwrap() }
fn opt(s: &Option<String>) -> Value { s.as_ref().map_or(Value::Null, |x| json!(x)) }
/// A score as JSON the way JS prints it (36, not 36.0), so JSON equality compares values.
fn n(x: f64) -> Value { isu_core::game_config::jnum(x) }

#[test]
fn icons_align_and_colours_match_js_on_real_frames() {
    let c = cases();
    let am = AgentMatcher::load(&repo().join("electron")).unwrap();
    let gm = GearMatcher::load(&repo().join("electron")).unwrap();
    let mut fails = Vec::new();
    for (f, want) in c["frames"].as_object().unwrap() {
        let img = load(f);
        let a = board::align_board(&img);
        if json!({ "found": a.found, "dx": a.dx, "dy": a.dy }) != json!({ "found": want["align"]["found"], "dx": want["align"]["dx"], "dy": want["align"]["dy"] }) { fails.push(format!("{f} align rust {:?}", (a.found, a.dx, a.dy))); }
        for (s, side) in ["home", "away"].iter().enumerate() {
            if want["colors"][side] != json!(board::block_color(&img, &a, s)) { fails.push(format!("{f} {side} colour")); }
        }
        for w in want["rows"].as_array().unwrap() {
            let s = if w["side"] == "home" { 0 } else { 1 }; let r = w["row"].as_u64().unwrap() as usize;
            let cy = a.rows[s][r];
            if json!(cy) != w["cy"] { fails.push(format!("{f} {s}:{r} cy rust {cy} js {}", w["cy"])); }
            let m = am.match_at(&img, board::AGENT.x + 16 + a.dx, cy);
            let got = json!({ "agent": opt(&m.agent), "candidate": m.candidate, "score": n(m.score), "runnerUp": m.runner_up, "runnerUpScore": n(m.runner_up_score) });
            if got != w["agent"] { fails.push(format!("{f} {s}:{r} agent rust {got} js {}", w["agent"])); }
            let g = gm.weapon(&img, Roi { x: board::LOADOUT.x + a.dx, y: cy - 12, w: board::LOADOUT.w, h: 24 });
            if opt(&g.name) != w["weapon"]["weapon"] || (g.name.is_some() || w["weapon"]["score"] != json!(0)) && n(g.score) != w["weapon"]["score"] { fails.push(format!("{f} {s}:{r} weapon rust {:?} {} js {}", g.name, g.score, w["weapon"])); }
            let sh = gm.shield(&img, board::SHIELD.x + a.dx, board::SHIELD.x + board::SHIELD.w + a.dx, cy);
            if opt(&sh.name) != w["shield"]["shield"] || n(sh.score) != w["shield"]["score"] { fails.push(format!("{f} {s}:{r} shield rust {:?} {} js {}", sh.name, sh.score, w["shield"])); }
        }
        for (k, only) in [("box", None), ("boxOnly", Some(vec!["viper".to_string(), "jett".into(), "sova".into()]))] {
            let m = am.match_box(&img, 560.0, 330.0, 40.0, only.as_deref());
            let got = json!({ "agent": opt(&m.agent), "candidate": m.candidate, "score": n(m.score), "runnerUp": m.runner_up, "runnerUpScore": n(m.runner_up_score) });
            if got != want[k] { fails.push(format!("{f} {k} rust {got} js {}", want[k])); }
        }
    }
    assert!(fails.is_empty(), "{} differences:\n{}", fails.len(), fails.join("\n"));
}

fn side_of(v: &Value) -> usize { if v == "home" { 0 } else { 1 } }
fn field(v: &Value) -> &'static str { ["name", "ultimate", "kills", "deaths", "assists", "credits", "ping", "agent", "weapon", "shield"].into_iter().find(|f| v == *f).unwrap() }

#[test]
fn consensus_matches_js() {
    let c = cases();
    let mut bd = empty_board();
    bd["teams"]["home"]["players"][2]["nameManual"] = json!(true);
    bd["teams"]["home"]["players"][2]["name"] = json!("Manual");
    let mut con = Consensus::default();
    for (i, step) in c["consensus"].as_array().unwrap().iter().enumerate() {
        let reads: Vec<Read> = step["sweep"].as_array().unwrap().iter().map(|r| Read { side: side_of(&r[0]), row: r[1].as_u64().unwrap() as usize, field: field(&r[2]), value: (!r[3].is_null()).then(|| r[3].clone()), board_row: None }).collect();
        let changed = apply_sweep(&mut bd, &mut con, &reads, step["now"].as_f64().unwrap());
        assert_eq!(json!(changed), step["changed"], "sweep {i} changed");
        assert_eq!(bd, step["board"], "sweep {i} board");
    }
}

#[test]
fn identity_matches_js() {
    let c = cases();
    let mut id = Identity::default();
    id.set_known_names(&["Sn0wfal".into(), "BaldReaper".into(), "newx".into()], &[]);
    for (i, step) in c["identity"].as_array().unwrap().iter().enumerate() {
        let mut reads: Vec<Read> = step["reads"].as_array().unwrap().iter().map(|r| Read { side: side_of(&r["side"]), row: r["row"].as_u64().unwrap() as usize, field: field(&r["field"]), value: (!r["value"].is_null()).then(|| r["value"].clone()), board_row: None }).collect();
        id.remap(&mut reads);
        for (got, want) in reads.iter().zip(step["remapped"].as_array().unwrap()) {
            assert_eq!(json!(got.row), want["row"], "step {i} row of {want}");
            assert_eq!(got.board_row.map_or(Value::Null, |b| json!(b)), want.get("boardRow").cloned().unwrap_or(Value::Null), "step {i} boardRow of {want}");
        }
        let moves: Vec<Value> = id.last_moves.iter().map(|m| json!({ "side": (["home", "away"][m.side]), "slot": m.slot, "tag": m.tag, "from": m.from, "to": m.to })).collect();
        assert_eq!(Value::Array(moves), step["moves"], "step {i} moves");
        let (h, a): (Vec<usize>, Vec<usize>) = ((0..5).map(|s| id.row_of(0, s)).collect(), (0..5).map(|s| id.row_of(1, s)).collect());
        let rows = json!([h, a]);
        assert_eq!(rows, step["rowOf"], "step {i} rowOf");
        for cf in step["confirmAfter"].as_array().unwrap() { id.confirm(side_of(&cf[0]), cf[1].as_u64().unwrap() as usize, cf[2].as_str().unwrap()); }
    }
}
