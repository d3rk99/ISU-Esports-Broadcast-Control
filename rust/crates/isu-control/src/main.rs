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
    // one controller at a time (ports 3174/3176/3178 can only be opened once)
    let Some(_lock) = isu_ui::single_instance(&files.dir, "controller.lock") else {
        rfd::MessageDialog::new().set_title("ISU Esports Broadcast Control").set_description("Broadcast Control is already running on this PC. Use the open window (check the taskbar).").set_level(rfd::MessageLevel::Info).show();
        return Ok(());
    };
    let core = Core::new(files, isu_server::Store::new());
    let svc = Services::start(Arc::clone(&core));
    // initialize(): open the Program outputs once at start unless turned off (ISU_NO_OUTPUTS=1 for tests)
    if svc.outputs.settings()["autoOpenProgramOutput"] != false && std::env::var_os("ISU_NO_OUTPUTS").is_none() {
        let o = Arc::clone(&svc.outputs);
        let name = core.state()["activeOutputOverlay"].as_str().filter(|n| isu_control::outputs::PROGRAM_OUTPUTS.contains(n)).unwrap_or("scoreboard").to_string();
        std::thread::spawn(move || { o.open_program(&name); });
    }
    let opts = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default().with_title("ISU Esports Broadcast Control").with_inner_size([1480.0, 940.0]).with_min_inner_size([1100.0, 700.0]),
        ..Default::default()
    };
    eframe::run_native("ISU Esports Broadcast Control", opts, Box::new(move |cc| Ok(Box::new(isu_control::ui::App::new(&cc.egui_ctx, svc)))))
}
