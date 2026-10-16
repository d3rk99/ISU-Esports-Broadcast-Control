//! isu-core::roster_manager = the real src/roster-manager.js (parity-roster-manager.json from
//! rust/scripts/parity-roster-manager.mjs). Ids are random in the JS, so the Rust side starts from
//! the JS "library built" snapshot and replays the same steps with those ids.
use isu_core::roster_manager::*;
use isu_core::{Value, json};

fn cases() -> Value { serde_json::from_str(include_str!("parity-roster-manager.json")).unwrap() }

#[test]
fn parse_bulk_matches_js() {
    for b in cases()["bulk"].as_array().unwrap() {
        assert_eq!(Value::Array(parse_bulk(b["text"].as_str().unwrap())), b["rows"], "{:?}", b["text"]);
    }
}

#[test]
fn session_matches_js() {
    let c = cases();
    let steps = c["steps"].as_array().unwrap();
    let cfg = isu_core::game_config::config("valorant").unwrap().clone();
    let empty = move |i: usize| isu_core::rocket_league::create_player(&cfg, i);
    let mut game = c["start"].clone();
    for k in ["rosterLibrary", "rosterAssign", "rosters", "awayRosters", "teams", "showAwayRoster"] { game[k] = steps[0]["game"][k].clone(); }
    let isu = game["rosterLibrary"]["teams"][0]["id"].as_str().unwrap().to_string();
    let lcu = game["rosterLibrary"]["teams"][1]["id"].as_str().unwrap().to_string();
    let view = |g: &Value| json!({ "rosterLibrary": g["rosterLibrary"], "rosterAssign": g["rosterAssign"], "rosters": g["rosters"], "awayRosters": g["awayRosters"], "teams": g["teams"], "coaches": g.get("coaches").cloned().unwrap_or(Value::Null), "showAwayRoster": g["showAwayRoster"] });
    let check = |g: &Value, i: usize, r: Value| {
        assert_eq!(r, steps[i]["result"], "step {} result", steps[i]["label"]);
        assert_eq!(view(g), steps[i]["game"], "step {} state", steps[i]["label"]);
    };
    ensure_library(&mut game);
    check(&game, 0, Value::Null);
    let r = load_team_into_match(&mut game, "away", &isu, &empty, 5); check(&game, 1, json!(r));
    let r = load_team_into_match(&mut game, "home", &lcu, &empty, 5); check(&game, 2, json!(r));
    let r = isu_side(&mut game); check(&game, 3, json!(r));
    game["awayRosters"]["varsity"][0]["character"] = json!("Viper");
    game["awayRosters"]["varsity"][0]["stageStation"] = json!("3");
    game["awayRosters"]["varsity"][1]["playerImage"] = json!("/x.png");
    let r = write_back_from_match(&mut game, "away"); check(&game, 4, json!(r));
    let ids: Vec<String> = [0, 3].iter().map(|i| game["rosterLibrary"]["teams"][0]["players"][*i]["id"].as_str().unwrap().to_string()).collect();
    let r = set_for_players(&mut game["rosterLibrary"]["teams"][0], &ids, "status", &json!("starter")); check(&game, 5, json!(r));
    let r = load_team_into_match(&mut game, "away", &isu, &empty, 5); check(&game, 6, json!(r));
    let id1 = game["rosterLibrary"]["teams"][0]["players"][1]["id"].as_str().unwrap().to_string();
    let r = remove_players(&mut game["rosterLibrary"]["teams"][0], &[id1]); check(&game, 7, json!(r));
    let names = |v: Vec<Value>| Value::Array(v.into_iter().map(|p| p["handle"].clone()).collect());
    let t = game["rosterLibrary"]["teams"][0].clone();
    check(&game, 8, names(sorted_players(&t, Some("jv"))));
    check(&game, 9, names(sorted_players(&t, None)));
}

#[test]
fn isu_side_links_and_uid_match_js() {
    let c = cases();
    for x in c["isu"].as_array().unwrap() {
        let mut g = json!({ "teams": x["teams"], "rosterAssign": { "home": "", "away": "" }, "rosterLibrary": { "teams": [] } });
        assert_eq!(json!(isu_side(&mut g)), x["side"], "{}", x["teams"]);
    }
    for l in c["links"].as_array().unwrap() {
        let got: Vec<Value> = live_links(l["roster"].as_array().unwrap(), l["board"].as_array().unwrap(), 0.9).into_iter()
            .map(|(i, k)| { let mut o = json!({ "name": k.name, "row": k.row, "block": k.block, "agent": k.agent, "score": isu_core::game_config::jnum(k.score), "linked": k.linked }); if o["row"].is_null() { o.as_object_mut().unwrap().remove("row"); } json!([i, o]) }).collect();
        assert_eq!(Value::Array(got), l["result"]);
    }
    let u = &c["uid"];
    assert_eq!(json!(uid("t", u["now"].as_u64().unwrap(), u["rand"].as_f64().unwrap())), u["id"]);
}
