//! Spectate parity with the real JS (parity-spectate.json, rust/scripts/parity-spectate.cjs):
//! 62 real name-bar crops (the 4 cleanups: ink share + exact image), 12 POV portraits / broadcast
//! frames (agent + colour), fuzzy matching, similarity, the camera vote, Rocket League target.
use std::path::Path;

use isu_ocr::board::{Frame, Roi};
use isu_ocr::icons::AgentMatcher;
use isu_ocr::spectate::{self as sp, Portrait, PortraitMatcher, Tracker, Winner};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn repo() -> std::path::PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..") }
fn cases() -> Value { serde_json::from_str(include_str!("parity-spectate.json")).unwrap() }
fn n(x: f64) -> Value { isu_core::game_config::jnum(x) }
fn on(x: Option<f64>) -> Value { x.map_or(Value::Null, n) }

struct Img { w: i32, h: i32, rgb: Vec<u8>, ox: i32, oy: i32 }
impl Img {
    fn open(rel: &str, ox: i32, oy: i32) -> Self {
        let mut d = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(repo().join(rel)).unwrap()));
        d.set_transformations(png::Transformations::EXPAND);
        let mut r = d.read_info().unwrap(); let mut buf = vec![0; r.output_buffer_size().unwrap()]; let info = r.next_frame(&mut buf).unwrap(); let ch = info.color_type.samples();
        Self { w: info.width as i32, h: info.height as i32, rgb: buf[..info.buffer_size()].chunks(ch).flat_map(|c| if ch <= 2 { [c[0], c[0], c[0]] } else { [c[0], c[1], c[2]] }).collect(), ox, oy }
    }
}
impl Frame for Img {
    fn rgb(&self, x: i32, y: i32) -> [u8; 3] { let (x, y) = (x - self.ox, y - self.oy); if x < 0 || y < 0 || x >= self.w || y >= self.h { return [0, 0, 0]; } let o = ((y * self.w + x) * 3) as usize; [self.rgb[o], self.rgb[o + 1], self.rgb[o + 2]] }
    fn lum(&self, x: i32, y: i32) -> u8 { let [r, g, b] = self.rgb(x, y); ((f64::from(r) * 0.299 + f64::from(g) * 0.587 + f64::from(b) * 0.114) + 0.5).floor() as u8 }
}
fn roi(v: &Value) -> Roi { Roi { x: v["x"].as_i64().unwrap() as i32, y: v["y"].as_i64().unwrap() as i32, w: v["w"].as_i64().unwrap() as i32, h: v["h"].as_i64().unwrap() as i32 } }
fn bx(v: &Value) -> Portrait { Portrait { x: v["x"].as_f64().unwrap(), y: v["y"].as_f64().unwrap(), s: v["s"].as_f64().unwrap() } }

#[test]
fn name_crops_match_js() {
    let c = cases();
    let mut fails = Vec::new();
    for cr in c["crops"].as_array().unwrap() {
        let img = Img::open(cr["file"].as_str().unwrap(), cr["ox"].as_i64().unwrap() as i32, cr["oy"].as_i64().unwrap() as i32);
        for (v, want) in sp::VARIANTS.iter().zip(cr["variants"].as_array().unwrap()) {
            let (g, share) = sp::clean_crop(&img, roi(&cr["roi"]), *v);
            let hex = Sha256::digest(&g.px).iter().map(|x| format!("{x:02x}")).collect::<String>();
            if n(share) != want["share"] || hex != want["img"] { fails.push(format!("{} {}{}: share rust {share} js {}, image same: {}", cr["file"], v.mode, v.thr, want["share"], hex == want["img"])); }
        }
    }
    assert!(fails.is_empty(), "{} differences:\n{}", fails.len(), fails.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
}

fn pjson(m: &sp::PortraitMatch) -> Value {
    json!({ "agent": m.agent, "color": m.color, "candidate": m.candidate, "candidateColor": m.candidate_color, "score": n(m.score), "runnerUp": m.runner_up, "runnerUpScore": on(m.runner_up_score), "otherColorScore": on(m.other_color_score) })
}

#[test]
fn portraits_match_js() {
    let c = cases();
    let pm = PortraitMatcher::load(&repo().join("electron")).unwrap();
    let am = AgentMatcher::load(&repo().join("electron")).unwrap();
    let only: Vec<String> = ["sova", "gekko", "breach", "jett"].iter().map(|s| s.to_string()).collect();
    for p in c["portraits"].as_array().unwrap() {
        let img = Img::open(p["file"].as_str().unwrap(), p["ox"].as_i64().unwrap() as i32, p["oy"].as_i64().unwrap() as i32);
        let b = bx(&p["box"]);
        assert_eq!(pjson(&pm.match_box(&img, b, &[])), p["all"], "{} all agents", p["file"]);
        assert_eq!(pjson(&pm.match_box(&img, b, &only)), p["only"], "{} only", p["file"]);
        assert_eq!(json!(sp::box_color(&img, b)), p["color"], "{} box colour", p["file"]);
        let m = am.match_box(&img, b.x, b.y, b.s, None);
        assert_eq!(json!({ "agent": m.agent, "candidate": m.candidate, "score": n(m.score), "runnerUp": m.runner_up, "runnerUpScore": n(m.runner_up_score) }), p["agentBox"], "{} agent matchBox", p["file"]);
    }
}

#[test]
fn matching_vote_and_rocket_league_match_js() {
    let c = cases();
    let cands: Vec<sp::Candidate> = ["Sn0wfal", "BaldReaper", "newx", "Eagl3", "Ishnarb", "santi", "LCU glowstick", "nyv", "CWTJ", "Mexican Sova"].iter().map(|s| sp::Candidate { name: s.to_string(), station: None, side: String::new(), team: String::new(), agent: String::new() }).collect();
    for m in c["matches"].as_array().unwrap() {
        let (b, r) = sp::match_candidates(m["text"].as_str().unwrap(), &cands);
        let j = |x: Option<(usize, f64)>| x.map_or(Value::Null, |(i, s)| json!({ "name": cands[i].name, "score": n(s) }));
        assert_eq!(json!({ "best": j(b), "runnerUp": j(r) }), json!({ "best": m["best"], "runnerUp": m["runnerUp"] }), "match {}", m["text"]);
    }
    for s in c["sims"].as_array().unwrap() { assert_eq!(n(sp::similarity(s[0].as_str().unwrap(), s[1].as_str().unwrap())), s[2], "similarity {s}"); }
    let mut t = Tracker::default();
    t.set_candidates(&[json!({ "name": "A", "station": 1, "side": "home", "team": "ISU", "agent": "jett" }), json!({ "name": "B", "station": "2", "side": "away", "team": "LCU" }), json!({ "name": "a" }), json!({ "name": "  " }), json!({ "name": "C" })]);
    for r in c["reports"].as_array().unwrap() {
        let st = &r["step"]; let clock = r["clock"].as_f64().unwrap();
        let (changed, snap) = if st[0].as_str().is_some_and(|s| s.starts_with("setCandidates")) {
            t.set_candidates(&[json!({ "name": "C", "station": 9, "side": "home" })]);
            t.report(None, clock)
        } else {
            let w = st[0].as_str().map(|name| Winner { name: name.into(), n: st[1].as_u64().unwrap() as u32, score: 0.8, via: if st[2] == "portrait" { "portrait" } else { "name" } });
            t.report(w, clock)
        };
        assert_eq!(json!(changed), r["changed"], "step {st} changed");
        assert_eq!(snap, r["spectated"], "step {st} snapshot");
    }
    for r in c["rl"].as_array().unwrap() {
        let mut state = json!({ "games": { "rocketleague": { "teams": [{ "name": "ISU" }, { "name": "OPP" }], "rocketLeague": { "blueTeam": 1, "live": r["live"] },
            "rosters": { "varsity": [{ "handle": "D3RK_99", "stageStation": "3" }, { "handle": "", "name": "Flip F17", "stageStation": 0 }], "jv": [] }, "awayRosters": { "varsity": [{ "handle": "enemy" }], "jv": [] } } } });
        let _ = &mut state;
        assert_eq!(sp::rocket_league_spectated(&state, 1234.0), r["result"], "RL {}", r["live"]);
    }
}
