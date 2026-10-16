//! Dev helper: a Display Manager on 3178 that prints status and runs a short script
//! (ndi -> mirror -> noise on 40 -> off), to check the real Display Client against it.
use std::sync::Arc;
#[tokio::main]
async fn main() {
    let port: u16 = std::env::args().nth(1).and_then(|p| p.parse().ok()).unwrap_or(3178);
    let dm = isu_net::displays::DisplayManager::new(port, "127.0.0.1", "", Arc::new(|s| {
        let st = &s["stations"][2];
        println!("STATUS online={} st3: online={} host={} state={} mode={} noise={} noiseState={} error={}", s["onlineCount"], st["online"], st["hostname"], st["state"], st["mode"], st["noise"], st["noiseState"], st["error"]);
    }));
    dm.start().await;
    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
    println!("SET mirror"); dm.set_mode("3", "mirror", "");
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    println!("SET noise on 40"); dm.set_noise("3", &serde_json::json!(true), Some(&serde_json::json!(40)));
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    println!("SET ndi + noise off"); dm.set_mode("3", "ndi", ""); dm.set_noise("3", &serde_json::json!(false), None);
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    let st = &dm.status()["stations"][2];
    println!("FINAL st3 mode={} noise={} noiseState={} state={}", st["mode"], st["noise"], st["noiseState"], st["state"]);
}
