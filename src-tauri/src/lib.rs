// Native session persistence for Gaze.
//
// The frontend (`src/core/session/persistence.ts`) invokes these commands to
// store the user's permission grant, calibration model, and preferences. The
// payload is an opaque JSON string owned by the frontend — Rust only persists
// it to a file under the OS app-data directory and falls back gracefully.

use std::fs;
use std::path::PathBuf;
use tauri::Manager;

const SESSION_FILE: &str = "session.json";

/// Resolve `<app_data_dir>/session.json`, creating the directory if needed.
fn session_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create app data dir: {e}"))?;
    Ok(dir.join(SESSION_FILE))
}

/// Returns the persisted session JSON, or `None` if nothing has been saved yet.
#[tauri::command]
fn load_session(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = session_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read session: {e}")),
    }
}

/// Persists the session JSON, overwriting any previous value.
#[tauri::command]
fn save_session(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let path = session_path(&app)?;
    fs::write(&path, json).map_err(|e| format!("write session: {e}"))
}

/// Removes the persisted session. Missing file is treated as success.
#[tauri::command]
fn clear_session(app: tauri::AppHandle) -> Result<(), String> {
    let path = session_path(&app)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("clear session: {e}")),
    }
}

// --- Native input: gaze-driven OS cursor + clicks (macOS) -------------------
// Posts CoreGraphics events so the gaze can move the real system cursor and
// click into ANY app (not just this window). Requires the app to be granted
// Accessibility permission in System Settings › Privacy & Security.
#[cfg(target_os = "macos")]
mod mac_input {
    use core_graphics::event::{
        CGEvent, CGEventTapLocation, CGEventType, CGMouseButton,
    };
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use core_graphics::geometry::CGPoint;

    fn event(kind: CGEventType, x: f64, y: f64) -> Result<CGEvent, String> {
        let src = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .map_err(|_| "event source".to_string())?;
        CGEvent::new_mouse_event(src, kind, CGPoint::new(x, y), CGMouseButton::Left)
            .map_err(|_| "mouse event".to_string())
    }

    pub fn warp(x: f64, y: f64) -> Result<(), String> {
        event(CGEventType::MouseMoved, x, y)?.post(CGEventTapLocation::HID);
        Ok(())
    }

    pub fn click(x: f64, y: f64) -> Result<(), String> {
        event(CGEventType::LeftMouseDown, x, y)?.post(CGEventTapLocation::HID);
        event(CGEventType::LeftMouseUp, x, y)?.post(CGEventTapLocation::HID);
        Ok(())
    }
}

/// Map a gaze point normalized to the window's content (0–1) to a global screen
/// point in logical points (top-left origin) — the space CoreGraphics uses.
/// Computed from the real window geometry so the OS cursor lands exactly under
/// the in-app indicator (JS `window.screenX/innerWidth` was unreliable in the
/// WKWebView and left the cursor offset).
#[cfg(target_os = "macos")]
fn to_global(window: &tauri::WebviewWindow, nx: f64, ny: f64) -> Result<(f64, f64), String> {
    let pos = window.inner_position().map_err(|e| format!("inner_position: {e}"))?;
    let size = window.inner_size().map_err(|e| format!("inner_size: {e}"))?;
    let scale = window.scale_factor().map_err(|e| format!("scale_factor: {e}"))?;
    let gx = (pos.x as f64 + nx * size.width as f64) / scale;
    let gy = (pos.y as f64 + ny * size.height as f64) / scale;
    Ok((gx, gy))
}

/// Move the OS cursor to a gaze point (normalized to the window content).
#[tauri::command]
fn warp_cursor(window: tauri::WebviewWindow, nx: f64, ny: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { let (x, y) = to_global(&window, nx, ny)?; mac_input::warp(x, y) }
    #[cfg(not(target_os = "macos"))]
    { let _ = (window, nx, ny); Err("native cursor control is macOS-only".into()) }
}

/// Left-click at a gaze point (normalized to the window content).
#[tauri::command]
fn mouse_click(window: tauri::WebviewWindow, nx: f64, ny: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { let (x, y) = to_global(&window, nx, ny)?; mac_input::click(x, y) }
    #[cfg(not(target_os = "macos"))]
    { let _ = (window, nx, ny); Err("native clicking is macOS-only".into()) }
}

/// Make the overlay window transparent to mouse events (click-through) or not.
/// Done in Rust so it isn't gated by the JS permission ACL (which was silently
/// denying the equivalent JS call and leaving the overlay blocking clicks).
#[tauri::command]
fn set_click_through(window: tauri::WebviewWindow, on: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(on)
        .map_err(|e| format!("set_ignore_cursor_events: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Emitter;
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

    // ⌃⌥Space arms/disarms gaze control of the cursor. Global so it works even
    // when the click-through overlay has no focus.
    let arm_toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &arm_toggle && event.state() == ShortcutState::Pressed {
                        let _ = app.emit("gaze:toggle-armed", ());
                    }
                })
                .build(),
        )
        .setup(move |app| {
            app.global_shortcut().register(arm_toggle)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_session,
            save_session,
            clear_session,
            warp_cursor,
            mouse_click,
            set_click_through
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
