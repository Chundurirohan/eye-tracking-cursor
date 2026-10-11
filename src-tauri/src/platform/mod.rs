// Platform layer. Each OS backend exposes the same free functions (checked at
// compile time by the glob re-export below); `lib.rs` only talks to this module,
// so command handlers contain no `cfg(target_os)` branching.

use serde::{Deserialize, Serialize};

/// Keys the on-screen keyboard can tap. Each backend maps these to native codes.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Key {
    Backspace,
    Return,
    Space,
}

/// One scanned target: (center_x, center_y, w, h, snap_strength), global logical points.
pub type Target = (f64, f64, f64, f64, f64);

/// What this platform/session can actually do, so the UI can hide dead controls.
#[derive(Clone, Debug, Serialize)]
pub struct Capabilities {
    pub os: &'static str,
    /// "native" | "x11" | "wayland" | "none"
    pub session: String,
    /// Which mechanism injects input: "coregraphics" | "xtest" | "portal" | "none".
    pub input_backend: &'static str,
    pub input: bool,
    pub magnet: bool,
    pub zoom: bool,
    pub text_focus: bool,
}

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod stub;
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub use stub::*;
