//! ISU Esports Broadcast Control (controller) in Rust + egui.
//! electron/main.cjs: services, then the controller window (src/app.js).
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use std::sync::Arc;

use eframe::egui;
use isu_control::core::Core;
use isu_control::services::Services;
use isu_control::settings::Files;

fn main() -> eframe::Result<()> {
    let files = Files::new(Files::default_dir());
    let core = Core::new(files, isu_server::Store::new());
    let svc = Services::start(Arc::clone(&core));
    let opts = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default().with_title("ISU Esports Broadcast Control").with_inner_size([1480.0, 940.0]).with_min_inner_size([1100.0, 700.0]),
        ..Default::default()
    };
    eframe::run_native("ISU Esports Broadcast Control", opts, Box::new(move |cc| Ok(Box::new(isu_control::ui::App::new(&cc.egui_ctx, svc)))))
}
