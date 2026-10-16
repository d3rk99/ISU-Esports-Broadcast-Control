//! Controller logic, ported 1:1 from the JavaScript controller (src/*.js on main).
//! The controller state stays the same JSON document the Electron app saves and publishes
//! (serde_json::Value), so overlays, Companion and saved state keep working unchanged.
//! Every function names the JS function it copies; tests/parity.rs runs both on the same input.

pub mod actions;
pub mod boards;
pub mod display_presets;
pub mod game_config;
pub mod rocket_league;
pub mod roster_manager;
pub mod tags;
pub mod variables;

pub use serde_json::{Value, json};
