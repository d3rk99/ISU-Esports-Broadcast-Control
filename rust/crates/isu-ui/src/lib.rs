//! Shared look of the ISU egui apps (controller, Game Bridge, Display Client): the styles.css theme
//! and the layout widgets. Call `apply_theme(ctx)` once at start, then use the widgets.
#![allow(clippy::too_many_arguments)]
use egui::{Color32, RichText};

/// styles.css :root colours.
pub mod c {
    use egui::Color32;
    pub const ORANGE: Color32 = Color32::from_rgb(0xf4, 0x79, 0x20);
    pub const BLACK: Color32 = Color32::from_rgb(0x09, 0x09, 0x0a);
    pub const PANEL: Color32 = Color32::from_rgb(0x15, 0x15, 0x17);
    pub const PANEL_LIGHT: Color32 = Color32::from_rgb(0x1c, 0x1c, 0x1f);
    pub const LINE: Color32 = Color32::from_rgb(0x2a, 0x2a, 0x2e);
    pub const MUTED: Color32 = Color32::from_rgb(0x8d, 0x8d, 0x96);
    pub const TEXT: Color32 = Color32::from_rgb(0xf7, 0xf7, 0xf8);
    pub const RED: Color32 = Color32::from_rgb(0xe5, 0x48, 0x4d);
    pub const INPUT: Color32 = Color32::from_rgb(0x10, 0x10, 0x12);
    pub const BORDER: Color32 = Color32::from_rgb(0x3a, 0x3a, 0x40);
    pub const BUTTON: Color32 = Color32::from_rgb(0x1b, 0x1b, 0x1e);
    pub const BUTTON_HOVER: Color32 = Color32::from_rgb(0x24, 0x24, 0x28);
    pub const LABEL: Color32 = Color32::from_rgb(0x8a, 0x8a, 0x93);
    pub const DIM: Color32 = Color32::from_rgb(0x6f, 0x6f, 0x77);
}

/// styles.css base look on every egui widget: inputs/selects (#101012, 1px #35353a, 2 px radius,
/// 35 px tall, orange focus), buttons (#1b1b1e, #3a3a40, 37 px), 11 px text, 10 px gaps.
pub fn apply_theme(ctx: &egui::Context) {
    use egui::{CornerRadius, FontFamily, FontId, Stroke, TextStyle};
    ctx.all_styles_mut(|st| {
        st.visuals = egui::Visuals::dark();
        let v = &mut st.visuals;
        v.panel_fill = c::BLACK;
        v.window_fill = c::PANEL;
        v.window_stroke = Stroke::new(1.0, c::LINE);
        v.extreme_bg_color = c::INPUT;
        v.faint_bg_color = c::PANEL_LIGHT;
        v.selection.bg_fill = c::ORANGE.gamma_multiply(0.45);
        v.selection.stroke = Stroke::new(1.0, c::ORANGE);
        v.hyperlink_color = c::ORANGE;
        let r = CornerRadius::same(2);
        let w = &mut v.widgets;
        w.noninteractive.bg_stroke = Stroke::new(1.0, c::LINE);
        w.noninteractive.fg_stroke = Stroke::new(1.0, c::TEXT);
        w.noninteractive.corner_radius = r;
        w.inactive.bg_fill = c::BUTTON;
        w.inactive.weak_bg_fill = c::BUTTON;
        w.inactive.bg_stroke = Stroke::new(1.0, c::BORDER);
        w.inactive.fg_stroke = Stroke::new(1.0, Color32::from_rgb(0xe8, 0xe8, 0xeb));
        w.inactive.corner_radius = r;
        w.hovered.bg_fill = c::BUTTON_HOVER;
        w.hovered.weak_bg_fill = c::BUTTON_HOVER;
        w.hovered.bg_stroke = Stroke::new(1.0, Color32::from_rgb(0x55, 0x55, 0x5d));
        w.hovered.fg_stroke = Stroke::new(1.0, Color32::WHITE);
        w.hovered.corner_radius = r;
        w.hovered.expansion = 0.0;
        w.active.bg_fill = c::BUTTON_HOVER;
        w.active.weak_bg_fill = c::BUTTON_HOVER;
        w.active.bg_stroke = Stroke::new(1.0, c::ORANGE);
        w.active.fg_stroke = Stroke::new(1.0, Color32::WHITE);
        w.active.corner_radius = r;
        w.active.expansion = 0.0;
        w.open = w.active;
        let sp = &mut st.spacing;
        sp.item_spacing = egui::vec2(10.0, 8.0);
        sp.button_padding = egui::vec2(14.0, 6.0);
        sp.interact_size = egui::vec2(36.0, 32.0);
        sp.combo_width = 180.0;
        sp.text_edit_width = 180.0;
        sp.indent = 14.0;
        st.text_styles = [
            (TextStyle::Small, FontId::new(10.0, FontFamily::Proportional)),
            (TextStyle::Body, FontId::new(13.0, FontFamily::Proportional)),
            (TextStyle::Button, FontId::new(12.0, FontFamily::Proportional)),
            (TextStyle::Monospace, FontId::new(12.0, FontFamily::Monospace)),
            (TextStyle::Heading, FontId::new(22.0, FontFamily::Proportional)),
        ].into();
    });
}

pub fn hex(s: &str) -> Color32 {
    let h = s.trim_start_matches('#');
    if h.len() == 6 {
        if let Ok(v) = u32::from_str_radix(h, 16) {
            return Color32::from_rgb((v >> 16) as u8, (v >> 8) as u8, v as u8);
        }
    }
    c::ORANGE
}



/// A labelled text input that returns Some(new text) when the user finishes editing it.
pub fn text_field(ui: &mut egui::Ui, id: &str, label: &str, value: &str, max: usize, width: f32) -> Option<String> {
    let key = egui::Id::new(("draft", id));
    let mut out = None;
    ui.vertical(|ui| {
        field_label(ui, label);
        let mut draft: String = ui.data(|d| d.get_temp::<String>(key)).unwrap_or_else(|| value.to_string());
        let w = if width <= 0.0 { ui.available_width() } else { width.min(ui.available_width()) };
        let r = ui.add(egui::TextEdit::singleline(&mut draft).char_limit(max).desired_width(w).margin(egui::vec2(10.0, 9.0)));
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
        field_label(ui, label);
        let mut col = hex(value);
        let r = ui.add_enabled_ui(enabled, |ui| egui::color_picker::color_edit_button_srgba(ui, &mut col, egui::color_picker::Alpha::Opaque)).inner;
        if r.changed() {
            out = Some(format!("#{:02x}{:02x}{:02x}", col.r(), col.g(), col.b()));
        }
    });
    out
}

/// .field > span: 9 px bold, letter-spaced, #8a8a93, 5 px under it.
pub fn field_label(ui: &mut egui::Ui, label: &str) {
    ui.add(egui::Label::new(RichText::new(label.to_uppercase()).size(9.5).strong().color(c::LABEL).extra_letter_spacing(0.9)).truncate());
    ui.add_space(-3.0);
}

/// A panel like styles.css .panel: #151517, 1px #2d2d31, 3 px radius, 17 px padding, full width.
pub fn panel<R>(ui: &mut egui::Ui, add: impl FnOnce(&mut egui::Ui) -> R) -> R {
    egui::Frame::NONE.fill(c::PANEL).stroke(egui::Stroke::new(1.0, egui::Color32::from_rgb(0x2d, 0x2d, 0x31))).corner_radius(3.0).inner_margin(17.0).show(ui, |ui| {
        ui.set_width(ui.available_width());
        add(ui)
    }).inner
}

/// Inset box (.score-control > div, .disp-station...): #101012 with a 1px border.
pub fn inset<R>(ui: &mut egui::Ui, add: impl FnOnce(&mut egui::Ui) -> R) -> R {
    egui::Frame::NONE.fill(c::INPUT).stroke(egui::Stroke::new(1.0, egui::Color32::from_rgb(0x2f, 0x2f, 0x34))).corner_radius(2.0).inner_margin(10.0).show(ui, |ui| add(ui)).inner
}

/// .section-number: the orange number in a 29 px bordered square.
fn number_box(ui: &mut egui::Ui, num: &str) {
    let (r, _) = ui.allocate_exact_size(egui::vec2(29.0, 29.0), egui::Sense::hover());
    let p = ui.painter();
    p.rect_filled(r, 0.0, c::PANEL);
    p.rect_stroke(r, 0.0, egui::Stroke::new(1.0, egui::Color32::from_rgb(0x39, 0x39, 0x3e)), egui::StrokeKind::Inside);
    p.text(r.center(), egui::Align2::CENTER_CENTER, num, egui::FontId::proportional(10.0), c::ORANGE);
}

/// .section-heading / .panel-title: [number] Title + subtitle, with optional right-side buttons.
pub fn heading(ui: &mut egui::Ui, num: &str, title: &str, sub: &str, right: impl FnOnce(&mut egui::Ui)) {
    ui.horizontal(|ui| {
        if !num.is_empty() {
            number_box(ui, num);
        }
        let right_w = 360.0_f32.min(ui.available_width() * 0.45);
        ui.allocate_ui_with_layout(egui::vec2(ui.available_width() - right_w, 34.0), egui::Layout::top_down(egui::Align::Min), |ui| {
            ui.label(RichText::new(title).strong().size(14.5).color(c::TEXT));
            if !sub.is_empty() {
                ui.add(egui::Label::new(RichText::new(sub).size(10.5).color(c::DIM)).wrap());
            }
        });
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), right);
    });
    ui.add_space(10.0);
}

/// Title without buttons.
pub fn title(ui: &mut egui::Ui, num: &str, title: &str, sub: &str) {
    heading(ui, num, title, sub, |_| {});
}

/// N equal columns (CSS grid repeat(n, 1fr)), each fills its column width.
pub fn grid<R>(ui: &mut egui::Ui, n: usize, add: impl FnOnce(&mut [egui::Ui]) -> R) -> R {
    let r = ui.columns(n, |cols| {
        for c in cols.iter_mut() {
            c.spacing_mut().item_spacing.y = 6.0;
        }
        add(cols)
    });
    ui.add_space(4.0);
    r
}

/// A labelled combo box that fills its width; returns the picked value when it changes.
pub fn select<T: PartialEq + Clone>(ui: &mut egui::Ui, id: &str, label: &str, current: &T, options: &[(T, String)]) -> Option<T> {
    let mut out = None;
    ui.vertical(|ui| {
        if !label.is_empty() {
            field_label(ui, label);
        }
        let shown = options.iter().find(|(v, _)| v == current).map(|(_, l)| l.clone()).unwrap_or_default();
        let mut pick = current.clone();
        egui::ComboBox::from_id_salt(id).width(ui.available_width()).selected_text(shown).show_ui(ui, |ui| {
            for (v, l) in options {
                ui.selectable_value(&mut pick, v.clone(), l);
            }
        });
        if &pick != current {
            out = Some(pick);
        }
    });
    out
}

/// Big button styles from styles.css.
pub fn primary_button(text: &str) -> egui::Button<'static> {
    egui::Button::new(RichText::new(text.to_string()).strong().color(egui::Color32::from_rgb(9, 9, 9))).fill(c::ORANGE).stroke(egui::Stroke::new(1.0, egui::Color32::from_rgb(0xdc, 0x68, 0x18))).min_size(egui::vec2(0.0, 37.0))
}
pub fn secondary_button(text: &str) -> egui::Button<'static> {
    egui::Button::new(RichText::new(text.to_string()).strong()).min_size(egui::vec2(0.0, 37.0))
}

/// A CSS-grid-like row: `cols` are fixed widths (>= 1.0 px) or fractions (< 0: -1.0 = 1fr, -1.7 = 1.7fr).
/// Every cell gets exactly its width, so text boxes and selects line up from row to row.
pub fn cols(ui: &mut egui::Ui, cols: &[f32], gap: f32, mut add: impl FnMut(usize, &mut egui::Ui)) {
    let total = ui.available_width();
    let fixed: f32 = cols.iter().filter(|w| **w > 0.0).sum();
    let fr: f32 = cols.iter().filter(|w| **w < 0.0).map(|w| -w).sum();
    let free = (total - fixed - gap * (cols.len().saturating_sub(1)) as f32).max(0.0);
    let widths: Vec<f32> = cols.iter().map(|w| if *w > 0.0 { *w } else if fr > 0.0 { free * -w / fr } else { 0.0 }).collect();
    ui.horizontal_top(|ui| {
        ui.spacing_mut().item_spacing.x = gap;
        for (i, w) in widths.iter().enumerate() {
            ui.allocate_ui_with_layout(egui::vec2(*w, 0.0), egui::Layout::top_down(egui::Align::Min), |ui| {
                ui.set_width(*w);
                add(i, ui);
            });
        }
    });
}

/// Toggle switch with a bold title + small grey note (.rl-enable-toggle / .away-roster-toggle).
/// The whole thing (switch + text) is one click target.
pub fn toggle(ui: &mut egui::Ui, on: &mut bool, title: &str, note: &str) -> bool {
    let w = ui.available_width();
    let text_w = (w - 46.0).max(40.0);
    let tg = ui.painter().layout(title.to_string(), egui::FontId::proportional(11.5), c::TEXT, text_w);
    let ng = (!note.is_empty()).then(|| ui.painter().layout(note.to_string(), egui::FontId::proportional(10.0), c::DIM, text_w));
    let h = (tg.size().y + ng.as_ref().map_or(0.0, |g| g.size().y + 2.0)).max(20.0);
    let (r, resp) = ui.allocate_exact_size(egui::vec2(w, h), egui::Sense::click());
    let mut changed = false;
    if resp.clicked() {
        *on = !*on;
        changed = true;
    }
    let p = ui.painter();
    let sw = egui::Rect::from_min_size(egui::pos2(r.left(), r.top() + 1.0), egui::vec2(34.0, 18.0));
    let (bg, bd, knob) = if *on { (c::ORANGE.gamma_multiply(0.15), c::ORANGE.gamma_multiply(0.7), c::ORANGE) } else { (egui::Color32::from_rgb(0x18, 0x18, 0x1b), if resp.hovered() { egui::Color32::from_rgb(0x55, 0x55, 0x5d) } else { c::BORDER }, egui::Color32::from_rgb(0x69, 0x69, 0x70)) };
    p.rect(sw, 9.0, bg, egui::Stroke::new(1.0, bd), egui::StrokeKind::Inside);
    let x = if *on { sw.right() - 9.0 } else { sw.left() + 9.0 };
    p.circle_filled(egui::pos2(x, sw.center().y), 5.5, knob);
    let tx = r.left() + 46.0;
    let th = tg.size().y;
    p.galley(egui::pos2(tx, r.top()), tg, c::TEXT);
    if let Some(g) = ng {
        p.galley(egui::pos2(tx, r.top() + th + 2.0), g, c::DIM);
    }
    resp.widget_info(|| egui::WidgetInfo::selected(egui::WidgetType::Checkbox, true, *on, title));
    changed
}

/// A tab button like .roster-tabs / .roster-subtabs / .team-side-tabs: title + note, active marker.
/// `marker`: "bottom" (orange underline) or "left" (orange left edge). Returns true when clicked.
pub fn tab(ui: &mut egui::Ui, title: &str, note: &str, active: bool, min_w: f32, marker: &str) -> bool {
    let h = if note.is_empty() { 38.0 } else { 52.0 };
    let w = min_w.min(ui.available_width());
    let (r, resp) = ui.allocate_exact_size(egui::vec2(w, h), egui::Sense::click());
    let p = ui.painter();
    let bg = if active { egui::Color32::from_rgb(0x1b, 0x1b, 0x1e) } else if resp.hovered() { egui::Color32::from_rgb(0x18, 0x18, 0x1b) } else { egui::Color32::from_rgb(0x14, 0x14, 0x16) };
    p.rect(r, 2.0, bg, egui::Stroke::new(1.0, egui::Color32::from_rgb(0x30, 0x30, 0x35)), egui::StrokeKind::Inside);
    if active {
        let m = if marker == "left" { egui::Rect::from_min_size(r.min, egui::vec2(3.0, r.height())) } else { egui::Rect::from_min_size(egui::pos2(r.left(), r.bottom() - 2.0), egui::vec2(r.width(), 2.0)) };
        p.rect_filled(m, 0.0, c::ORANGE);
    }
    let x = r.left() + 14.0;
    if note.is_empty() {
        p.text(egui::pos2(x, r.center().y), egui::Align2::LEFT_CENTER, title, egui::FontId::proportional(11.5), if active { egui::Color32::WHITE } else { egui::Color32::from_rgb(0xb5, 0xb5, 0xbb) });
    } else {
        p.text(egui::pos2(x, r.top() + 17.0), egui::Align2::LEFT_CENTER, title, egui::FontId::proportional(11.5), if active { egui::Color32::WHITE } else { egui::Color32::from_rgb(0xd5, 0xd5, 0xd9) });
        let galley = p.layout(note.to_string(), egui::FontId::proportional(10.0), if active && marker == "left" { c::ORANGE } else { egui::Color32::from_rgb(0x66, 0x66, 0x6d) }, r.width() - 24.0);
        p.galley(egui::pos2(x, r.top() + 27.0), galley, egui::Color32::WHITE);
    }
    resp.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Button, true, title));
    resp.clicked()
}

/// .asset-thumb + .roster-asset-tile: 56x55 thumbnail (dashed when empty), title, file name, buttons.
/// Returns (choose clicked, clear clicked).
pub fn asset_tile(ui: &mut egui::Ui, title: &str, url: &str, file: &str, placeholder: &str, choose_label: &str, can_choose: bool, show_clear: bool) -> (bool, bool) {
    let mut out = (false, false);
    egui::Frame::NONE.fill(c::INPUT).stroke(egui::Stroke::new(1.0, egui::Color32::from_rgb(0x30, 0x30, 0x35))).inner_margin(7.0).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal_top(|ui| {
            thumb(ui, url, placeholder);
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = 3.0;
                ui.add(egui::Label::new(RichText::new(title).size(10.5).strong().color(c::TEXT)).truncate());
                ui.add(egui::Label::new(RichText::new(file).size(9.5).color(egui::Color32::from_rgb(0x60, 0x60, 0x67))).truncate());
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 4.0;
                    if !choose_label.is_empty() {
                        let b = egui::Button::new(RichText::new(choose_label).size(9.0).strong().color(c::ORANGE)).fill(c::ORANGE.gamma_multiply(0.06)).stroke(egui::Stroke::new(1.0, egui::Color32::from_rgb(0x4a, 0x3b, 0x31))).min_size(egui::vec2(0.0, 22.0));
                        out.0 = ui.add_enabled(can_choose, b).clicked();
                    }
                    if show_clear {
                        let b = egui::Button::new(RichText::new("CLEAR").size(9.0).strong().color(egui::Color32::from_rgb(0xba, 0x6b, 0x65))).fill(egui::Color32::TRANSPARENT).stroke(egui::Stroke::new(1.0, egui::Color32::from_rgb(0x49, 0x32, 0x32))).min_size(egui::vec2(0.0, 22.0));
                        out.1 = ui.add(b).clicked();
                    }
                });
            });
        });
    });
    out
}

/// 56x55 image box; images from /assets/ go through the overlay server.
pub fn thumb(ui: &mut egui::Ui, url: &str, placeholder: &str) {
    let (r, _) = ui.allocate_exact_size(egui::vec2(56.0, 55.0), egui::Sense::hover());
    let p = ui.painter();
    p.rect_filled(r, 0.0, egui::Color32::from_rgb(0x17, 0x17, 0x1a));
    if url.is_empty() {
        let dash = egui::Stroke::new(1.0, egui::Color32::from_rgb(0x44, 0x44, 0x4a));
        for (a, b) in [(r.left_top(), r.right_top()), (r.right_top(), r.right_bottom()), (r.right_bottom(), r.left_bottom()), (r.left_bottom(), r.left_top())] {
            p.add(egui::Shape::dashed_line(&[a, b], dash, 4.0, 3.0));
        }
        p.text(r.center(), egui::Align2::CENTER_CENTER, placeholder, egui::FontId::proportional(8.5), egui::Color32::from_rgb(0x5e, 0x5e, 0x65));
    } else {
        p.rect_stroke(r, 0.0, egui::Stroke::new(1.0, c::ORANGE.gamma_multiply(0.45)), egui::StrokeKind::Inside);
        let full = if url.starts_with("/assets/") { format!("http://127.0.0.1:3174{url}") } else { url.to_string() };
        egui::Image::new(full).fit_to_exact_size(r.size() - egui::vec2(2.0, 2.0)).paint_at(ui, r.shrink(1.0));
    }
}

/// .reader-link / .starter-state style chip.
pub fn chip(ui: &mut egui::Ui, text: &str, fg: egui::Color32, bg: egui::Color32) -> egui::Response {
    egui::Frame::NONE.fill(bg).corner_radius(2.0).inner_margin(egui::Margin::symmetric(7, 3)).show(ui, |ui| {
        ui.add(egui::Label::new(RichText::new(text).size(9.5).strong().color(fg)).truncate());
    }).response
}
