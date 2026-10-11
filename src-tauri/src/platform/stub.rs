use super::{Capabilities, Key, Target};

const NO: &str = "native input is not supported on this platform";

pub fn capabilities() -> Capabilities {
    Capabilities { os: "other", session: "none".into(), input_backend: "none", input: false, magnet: false, zoom: false, text_focus: false }
}
pub fn warp(_: f64, _: f64) -> Result<(), String> { Err(NO.into()) }
pub fn click(_: f64, _: f64) -> Result<(), String> { Err(NO.into()) }
pub fn right_click(_: f64, _: f64) -> Result<(), String> { Err(NO.into()) }
pub fn double_click(_: f64, _: f64) -> Result<(), String> { Err(NO.into()) }
pub fn scroll(_: i32) -> Result<(), String> { Err(NO.into()) }
pub fn type_text(_: &str) -> Result<(), String> { Err(NO.into()) }
pub fn key_tap(_: Key) -> Result<(), String> { Err(NO.into()) }
pub fn cursor_location() -> Option<(f64, f64)> { None }
pub fn nearest_target(_: f64, _: f64, _: f64) -> Option<(f64, f64, f64, f64)> { None }
pub fn all_targets(_: f64, _: f64, _: f64) -> Vec<Target> { Vec::new() }
pub fn focused_is_text() -> bool { false }
pub fn zoom_toggle() -> Result<(), String> { Err(NO.into()) }
pub fn zoom_in() -> Result<(), String> { Err(NO.into()) }
pub fn zoom_out() -> Result<(), String> { Err(NO.into()) }
pub fn is_trusted() -> bool { true }
pub fn request_access() -> bool { true }
pub fn init(_app: &tauri::AppHandle) {}
pub fn note_scale(_: f64) {}
