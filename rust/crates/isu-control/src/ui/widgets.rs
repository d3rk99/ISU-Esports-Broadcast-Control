//! Small widgets that behave like the app.js inputs: a text box commits on change (focus lost /
//! Enter) like the DOM 'change' event, not on every key.
use eframe::egui::{self, RichText};

use super::c;

/// A labelled text input that returns Some(new text) when the user finishes editing it.
pub fn text_field(ui: &mut egui::Ui, id: &str, label: &str, value: &str, max: usize, width: f32) -> Option<String> {
    let key = egui::Id::new(("draft", id));
    let mut out = None;
    ui.vertical(|ui| {
        ui.label(RichText::new(label).small().color(c::MUTED));
        let mut draft: String = ui.data(|d| d.get_temp::<String>(key)).unwrap_or_else(|| value.to_string());
        let r = ui.add(egui::TextEdit::singleline(&mut draft).char_limit(max).desired_width(width));
        if r.has_focus() || r.changed() {
            ui.data_mut(|d| d.insert_temp(key, draft.clone()));
        }
        if r.lost_focus() {
            ui.data_mut(|d| d.remove::<String>(key));
            if draft != value {
                out = Some(draft);
            }
        } else if !r.has_focus() {
            // not being edited: always show the live value
            ui.data_mut(|d| d.remove::<String>(key));
        }
    });
    out
}

/// <input type="color"> on a "#rrggbb" string.
pub fn color_field(ui: &mut egui::Ui, label: &str, value: &str, enabled: bool) -> Option<String> {
    let mut out = None;
    ui.vertical(|ui| {
        ui.label(RichText::new(label).small().color(c::MUTED));
        let mut col = super::hex(value);
        let r = ui.add_enabled_ui(enabled, |ui| egui::color_picker::color_edit_button_srgba(ui, &mut col, egui::color_picker::Alpha::Opaque)).inner;
        if r.changed() {
            out = Some(format!("#{:02x}{:02x}{:02x}", col.r(), col.g(), col.b()));
        }
    });
    out
}

/// A panel like styles.css .panel (dark card with a thin border).
pub fn panel<R>(ui: &mut egui::Ui, add: impl FnOnce(&mut egui::Ui) -> R) -> R {
    egui::Frame::NONE.fill(c::PANEL).stroke(egui::Stroke::new(1.0, c::LINE)).corner_radius(8.0).inner_margin(16.0).show(ui, |ui| {
        ui.set_width(ui.available_width());
        add(ui)
    }).inner
}

/// .panel-title: "02  Title / subtitle".
pub fn title(ui: &mut egui::Ui, num: &str, title: &str, sub: &str) {
    ui.horizontal(|ui| {
        if !num.is_empty() {
            ui.label(RichText::new(num).color(c::ORANGE).strong());
        }
        ui.vertical(|ui| {
            ui.label(RichText::new(title).strong().size(16.0).color(c::TEXT));
            if !sub.is_empty() {
                ui.label(RichText::new(sub).small().color(c::MUTED));
            }
        });
    });
    ui.add_space(6.0);
}
