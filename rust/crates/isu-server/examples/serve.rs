//! Dev helper: overlay server on 3174 with ../public as the static root and a sample state, for
//! checking the real overlay pages against the Rust server.  cargo run -p isu-server --example serve
use std::sync::Arc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let store = isu_server::Store::new();
    let mut state = isu_core::game_config::initial_state();
    state["updatedAt"] = isu_core::json!("2026-10-15T00:00:00.000Z");
    state["selectedGame"] = isu_core::json!("valorant");
    state["games"]["valorant"]["teams"][0]["score"] = isu_core::json!(1);
    store.publish(state.clone());
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../public");
    let cfg = isu_server::overlay::Config { static_root: root.canonicalize()?, asset_root: std::env::temp_dir().join("isu-assets"), rl_pack: None, rl_backup: Arc::new(|| serde_json::Value::Null) };
    let port: u16 = std::env::args().nth(1).and_then(|p| p.parse().ok()).unwrap_or(3174);
    let addr = isu_server::overlay::start(Arc::clone(&store), cfg, port).await?;
    eprintln!("overlay server on {addr}");
    // after 3 s: home scores again (a live publish the open page must pick up)
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    state["games"]["valorant"]["teams"][0]["score"] = isu_core::json!(2);
    state["games"]["valorant"]["teams"][0]["name"] = isu_core::json!("RUST TEST");
    store.publish(state);
    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
    Ok(())
}
