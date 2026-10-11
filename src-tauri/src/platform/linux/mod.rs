// Linux backend.
//
// Windows: on a Wayland session the app is forced onto XWayland (see `main.rs`)
// so always-on-top / positioning / click-through work. Input injection depends on
// the REAL session type: X11 → XTest; Wayland → RemoteDesktop portal (libei).

mod webview;
mod zoom;
mod x11_input;
mod portal_input;

use super::{Capabilities, Key, Target};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Session {
    X11,
    Wayland,
    None,
}

/// The session the user is actually logged into — NOT the GDK backend we forced.
/// `main.rs` records it in `GAZE_REAL_SESSION` before overriding `GDK_BACKEND`.
pub fn session() -> Session {
    static S: std::sync::OnceLock<Session> = std::sync::OnceLock::new();
    *S.get_or_init(|| {
        let v = std::env::var("GAZE_REAL_SESSION")
            .or_else(|_| std::env::var("XDG_SESSION_TYPE"))
            .unwrap_or_default();
        match v.as_str() {
            "wayland" => Session::Wayland,
            "x11" => Session::X11,
            _ if std::env::var_os("WAYLAND_DISPLAY").is_some() => Session::Wayland,
            _ if std::env::var_os("DISPLAY").is_some() => Session::X11,
            _ => Session::None,
        }
    })
}

fn x11_ok() -> bool { session() == Session::X11 && x11_input::available() }
fn wayland() -> bool { session() == Session::Wayland }

pub fn capabilities() -> Capabilities {
    let s = session();
    let backend = if x11_ok() { "xtest" } else if wayland() { "portal" } else { "none" };
    Capabilities {
        os: "linux",
        session: format!("{s:?}").to_lowercase(),
        input_backend: backend,
        input: x11_ok() || wayland(),
        magnet: false,
        zoom: zoom::supported(),
        text_focus: false,
    }
}

const NO: &str = "no input backend available in this session";

macro_rules! route {
    ($name:ident($($a:ident: $t:ty),*) -> $r:ty) => {
        pub fn $name($($a: $t),*) -> Result<$r, String> {
            if x11_ok() { x11_input::$name($($a),*) }
            else if wayland() { portal_input::$name($($a),*) }
            else { Err(NO.into()) }
        }
    };
}
route!(warp(x: f64, y: f64) -> ());
route!(click(x: f64, y: f64) -> ());
route!(right_click(x: f64, y: f64) -> ());
route!(double_click(x: f64, y: f64) -> ());
route!(scroll(dy: i32) -> ());
route!(key_tap(key: Key) -> ());
pub fn type_text(text: &str) -> Result<(), String> {
    if x11_ok() { x11_input::type_text(text) }
    else if wayland() { portal_input::type_text(text) }
    else { Err(NO.into()) }
}
/// Where the cursor is. X11 can ask the server; Wayland can't, so it reports the
/// last position this app put it at (the app is the only thing steering it).
pub fn cursor_location() -> Option<(f64, f64)> {
    if x11_ok() { x11_input::cursor_location() } else if wayland() { portal_input::cursor_location() } else { None }
}

pub fn nearest_target(_: f64, _: f64, _: f64) -> Option<(f64, f64, f64, f64)> { None }
pub fn all_targets(_: f64, _: f64, _: f64) -> Vec<Target> { Vec::new() }
pub fn focused_is_text() -> bool { false }

pub fn zoom_toggle() -> Result<(), String> { zoom::run(zoom::Op::Toggle) }
pub fn zoom_in() -> Result<(), String> { zoom::run(zoom::Op::In) }
pub fn zoom_out() -> Result<(), String> { zoom::run(zoom::Op::Out) }

pub fn is_trusted() -> bool { x11_ok() || (wayland() && portal_input::is_ready()) }
/// X11 needs no consent. On Wayland this starts the RemoteDesktop portal flow (the
/// compositor shows its prompt); poll `is_trusted` for the outcome.
pub fn request_access() -> bool {
    if wayland() { portal_input::request_access(); }
    is_trusted()
}

/// Per-display scale for logical→physical conversion (see `x11_input::set_scale`).
pub fn note_scale(scale: f64) { x11_input::set_scale(scale); }

pub fn init(app: &tauri::AppHandle) {
    webview::configure(app);
    if wayland() {
        use tauri::Manager;
        if let Ok(dir) = app.path().app_data_dir() {
            portal_input::set_token_path(dir.join("portal_token"));
            // A saved token means the compositor won't prompt again — connect right away.
            if portal_input::has_saved_token() { portal_input::request_access(); }
        }
    }
}
