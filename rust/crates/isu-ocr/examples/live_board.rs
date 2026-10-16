//! Live VALORANT board reader on a real window (Windows Graphics Capture), for testing on the
//! broadcast / home PC:   cargo run --release -p isu-ocr --example live_board [window title] [seconds]
//! Prints every sweep: status, ms, the match HUD and the first rows. Needs the window open.
#[cfg(windows)]
fn main() -> anyhow::Result<()> {
    use std::sync::Arc;
    let window = std::env::args().nth(1).unwrap_or_else(|| "VALORANT".into());
    let secs: u64 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(30);
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let models = isu_ocr::service::dev_models(&repo, &repo.join("rust/target/tessdata"))?;
    let svc = isu_ocr::service::BoardService::new(
        Arc::new(isu_ocr::capture::WgcSource::default()),
        models,
        Box::new(|s| {
            let row = |side: &str, i: usize| { let p = &s["teams"][side]["players"][i]; format!("{} {} {}/{}/{} {} {}", p["name"], p["agent"], p["kills"], p["deaths"], p["assists"], p["weapon"], p["shield"]) };
            println!("  match {}  | {} | {}", s["match"], row("home", 0), row("away", 0));
        }),
        Box::new(|st| println!("{} · {} · {} ms", st["state"], st["message"], st["sweepMs"])),
    );
    svc.configure(&serde_json::json!({ "enabled": true, "windowName": window, "intervalMs": 500 }));
    std::thread::sleep(std::time::Duration::from_secs(secs));
    svc.shutdown();
    Ok(())
}
#[cfg(not(windows))]
fn main() { eprintln!("live_board needs Windows (Windows Graphics Capture)"); }
