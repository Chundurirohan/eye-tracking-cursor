// macOS backend: CoreGraphics input + Accessibility (AX) target scanning.
// `input` and `ax` are the original implementations, moved verbatim.

mod ax;
mod input;

use super::{Capabilities, Key, Target};

pub fn capabilities() -> Capabilities {
    Capabilities { os: "macos", session: "native".into(), input_backend: "coregraphics", input: true, magnet: true, zoom: true, text_focus: true }
}

pub fn warp(x: f64, y: f64) -> Result<(), String> { input::warp(x, y) }
pub fn click(x: f64, y: f64) -> Result<(), String> { input::click(x, y) }
pub fn right_click(x: f64, y: f64) -> Result<(), String> { input::right_click(x, y) }
pub fn double_click(x: f64, y: f64) -> Result<(), String> { input::double_click(x, y) }
pub fn scroll(dy: i32) -> Result<(), String> { input::scroll(dy) }
pub fn type_text(text: &str) -> Result<(), String> { input::type_text(text) }
pub fn cursor_location() -> Option<(f64, f64)> { input::cursor_location() }

pub fn key_tap(key: Key) -> Result<(), String> {
    // macOS virtual keycodes.
    input::key_tap(match key { Key::Backspace => 51, Key::Return => 36, Key::Space => 49 })
}

fn my_pid() -> i32 { std::process::id() as i32 }

pub fn nearest_target(gx: f64, gy: f64, radius: f64) -> Option<(f64, f64, f64, f64)> {
    unsafe { ax::nearest_target(gx, gy, radius, my_pid()) }
}
pub fn all_targets(gx: f64, gy: f64, radius: f64) -> Vec<Target> {
    unsafe { ax::all_targets(gx, gy, radius, my_pid()) }
}
pub fn focused_is_text() -> bool { unsafe { ax::focused_is_text() } }

// macOS built-in Zoom keyboard shortcuts (Command+Option chords). Requires "Use
// keyboard shortcuts to zoom" in System Settings › Accessibility › Zoom.
const CMD_ALT: u64 = 0x0010_0000 | 0x0008_0000; // Command | Alternate(Option)
pub fn zoom_toggle() -> Result<(), String> { input::key_combo(CMD_ALT, 28) } // "8"
pub fn zoom_in() -> Result<(), String> { input::key_combo(CMD_ALT, 24) }     // "="
pub fn zoom_out() -> Result<(), String> { input::key_combo(CMD_ALT, 27) }    // "-"

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: core_foundation::dictionary::CFDictionaryRef) -> bool;
    static kAXTrustedCheckOptionPrompt: core_foundation::string::CFStringRef;
}

/// Whether this app currently has effective Accessibility permission. Synthetic
/// clicks silently no-op when this is false.
pub fn is_trusted() -> bool { unsafe { AXIsProcessTrusted() } }

/// Show the real macOS "grant Accessibility" prompt and register this exact
/// binary in the Accessibility list, if not already trusted.
pub fn request_access() -> bool {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    unsafe {
        let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
        let opts = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), CFBoolean::true_value().as_CFType())]);
        AXIsProcessTrustedWithOptions(opts.as_concrete_TypeRef())
    }
}

/// macOS works in logical points natively; nothing to convert.
pub fn note_scale(_scale: f64) {}

/// Called once from `setup`: surface the Accessibility prompt and log the real state
/// (dev rebuilds get a new signature, so a prior grant may not apply).
pub fn init(_app: &tauri::AppHandle) {
    let _ = request_access();
    let ax = is_trusted();
    println!("[gaze][perms] Accessibility(magnet/clicks/zoom)={ax}");
    if !ax { println!("[gaze][perms] -> OFF: enable this binary in System Settings › Privacy & Security › Accessibility, then relaunch."); }
}
