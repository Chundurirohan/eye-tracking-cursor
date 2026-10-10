// Native layer for Gaze: session persistence + a thin command layer over
// `platform::*` (OS-specific input injection, target scanning, zoom).
//
// The frontend (`src/core/session/persistence.ts`, `src/core/system/nativeInput.ts`)
// invokes these commands. All OS differences live in `platform/`; nothing here
// branches on `target_os`.

mod platform;

use platform::{Capabilities, Key};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

const SESSION_FILE: &str = "session.json";

/// Shared cache of nearby clickable targets (global logical points), kept fresh
/// by a background scanner thread so the frontend can hit-test locally every
/// frame — instant system-wide magnetism instead of throttled async queries.
#[derive(Default)]
struct TargetCache(std::sync::Arc<std::sync::Mutex<Vec<platform::Target>>>);

/// Where the scanner should look (global logical points) — the user's RAW gaze,
/// published by the frontend on every `nearby_targets` poll.
///
/// This MUST NOT be the OS cursor position. The cursor is warped to the
/// *magnet-snapped* reticle, so scanning around it feeds the magnet's own output
/// back into its input: snap to a target → cursor warps there → the next scan
/// re-centers on it → a different neighborhood of targets → snap somewhere else.
/// That loop is what made the reticle judder between unrelated points.
#[derive(Default)]
struct ScanCenter(std::sync::Arc<std::sync::Mutex<Option<(f64, f64)>>>);

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

/// The full bounds of the display the window is on, in GLOBAL LOGICAL POINTS,
/// as `(x, y, w, h, scale)`.
///
/// Every gaze↔screen mapping goes through this rather than the window rect. A
/// `maximized` window deliberately excludes the menu bar and the Dock, so mapping
/// normalized [0,1] onto the WINDOW made those regions unreachable. Mapping onto
/// the display makes 0 and 1 mean the true screen edges.
///
/// Falls back to the window rect only if the monitor can't be resolved.
fn display_rect(window: &tauri::WebviewWindow) -> Result<(f64, f64, f64, f64, f64), String> {
    let scale = window.scale_factor().map_err(|e| format!("scale_factor: {e}"))?;
    if let Ok(Some(m)) = window.current_monitor() {
        let p = m.position();
        let s = m.size();
        let ms = m.scale_factor();
        return Ok((
            p.x as f64 / ms,
            p.y as f64 / ms,
            s.width as f64 / ms,
            s.height as f64 / ms,
            ms,
        ));
    }
    let pos = window.inner_position().map_err(|e| format!("inner_position: {e}"))?;
    let size = window.inner_size().map_err(|e| format!("inner_size: {e}"))?;
    Ok((
        pos.x as f64 / scale,
        pos.y as f64 / scale,
        size.width as f64 / scale,
        size.height as f64 / scale,
        scale,
    ))
}

/// Map a gaze point normalized to the display (0–1) to a global screen point in
/// logical points (top-left origin).
fn to_global(window: &tauri::WebviewWindow, nx: f64, ny: f64) -> Result<(f64, f64), String> {
    let (px, py, w, h, scale) = display_rect(window)?;
    platform::note_scale(scale);
    Ok((px + nx * w, py + ny * h))
}

/// What this platform/session supports, so the UI can hide controls that can't work.
#[tauri::command]
fn platform_info() -> Capabilities {
    platform::capabilities()
}

/// Snap to the nearest system-wide clickable near a gaze point (normalized to
/// the display). Returns (nx, ny, w_norm, h_norm) of the target center, or None.
#[tauri::command]
fn snap_target(window: tauri::WebviewWindow, nx: f64, ny: f64, radius: f64) -> Result<Option<(f64, f64, f64, f64)>, String> {
    if !platform::capabilities().magnet { return Ok(None); }
    let (px, py, w, h, _) = display_rect(&window)?;
    let res = platform::nearest_target(px + nx * w, py + ny * h, radius * w);
    Ok(res.map(|(cx, cy, tw, th)| (((cx - px) / w), ((cy - py) / h), tw / w, th / h)))
}

/// All nearby clickable targets, from the background scanner's cache, converted
/// to normalized display coords (nx, ny, w_norm, h_norm, strength). The frontend
/// refreshes this a few times a second and hit-tests it locally every frame.
#[tauri::command]
fn nearby_targets(
    window: tauri::WebviewWindow,
    state: tauri::State<TargetCache>,
    center: tauri::State<ScanCenter>,
    nx: f64,
    ny: f64,
) -> Result<Vec<platform::Target>, String> {
    let (px, py, w, h, _) = display_rect(&window)?;
    // Publish the RAW gaze as the next scan center (see `ScanCenter`).
    if nx.is_finite() && ny.is_finite() {
        if let Ok(mut c) = center.0.lock() { *c = Some((px + nx * w, py + ny * h)); }
    }
    let list = state.0.lock().map_err(|_| "target cache poisoned".to_string())?.clone();
    Ok(list.into_iter().map(|(cx, cy, tw, th, strength)| {
        (((cx - px) / w), ((cy - py) / h), tw / w, th / h, strength)
    }).collect())
}

/// Continuously scan around the gaze for nearby clickables and keep the shared
/// cache fresh, off the render thread.
fn spawn_target_scanner(
    cache: std::sync::Arc<std::sync::Mutex<Vec<platform::Target>>>,
    center: std::sync::Arc<std::sync::Mutex<Option<(f64, f64)>>>,
) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(120));
        // Scan around the raw gaze. Falling back to the cursor only when the
        // frontend hasn't published a gaze yet (pre-tracking) keeps that case
        // from feeding back on itself.
        let at = center.lock().ok().and_then(|c| *c).or_else(platform::cursor_location);
        if let Some((gx, gy)) = at {
            let t0 = std::time::Instant::now();
            let targets = platform::all_targets(gx, gy, 200.0);
            let ms = t0.elapsed().as_millis();
            // The budget is the 120ms sleep above; an overrun means a stale cache.
            if ms > 100 {
                println!("[gaze][scan] SLOW {ms}ms for {} targets — magnet will lag", targets.len());
            }
            if let Ok(mut c) = cache.lock() { *c = targets; }
        }
    });
}

/// Move the OS cursor to a gaze point (normalized to the display).
#[tauri::command]
fn warp_cursor(window: tauri::WebviewWindow, nx: f64, ny: f64) -> Result<(), String> {
    let (x, y) = to_global(&window, nx, ny)?;
    platform::warp(x, y)
}

/// Left-click at a gaze point (normalized to the display).
#[tauri::command]
fn mouse_click(window: tauri::WebviewWindow, nx: f64, ny: f64) -> Result<(), String> {
    let (x, y) = to_global(&window, nx, ny)?;
    // Guarantee the overlay is click-through at the instant of the click so the
    // synthetic event passes to the app beneath instead of being caught by our own
    // always-on-top window. Don't rely on the frontend having already asserted it.
    let _ = window.set_ignore_cursor_events(true);
    platform::click(x, y)
}

/// Right-click at a gaze point — context menus.
#[tauri::command]
fn mouse_right_click(window: tauri::WebviewWindow, nx: f64, ny: f64) -> Result<(), String> {
    let (x, y) = to_global(&window, nx, ny)?;
    let _ = window.set_ignore_cursor_events(true);
    platform::right_click(x, y)
}

/// Double-click at a gaze point.
#[tauri::command]
fn mouse_double_click(window: tauri::WebviewWindow, nx: f64, ny: f64) -> Result<(), String> {
    let (x, y) = to_global(&window, nx, ny)?;
    let _ = window.set_ignore_cursor_events(true);
    platform::double_click(x, y)
}

/// Scroll the app under the cursor vertically by `dy` pixels (edge-gaze scrolling).
#[tauri::command]
fn mouse_scroll(window: tauri::WebviewWindow, dy: i32) -> Result<(), String> {
    let _ = window.set_ignore_cursor_events(true);
    platform::scroll(dy)
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

/// Toggle the system screen magnifier.
#[tauri::command]
fn zoom_toggle() -> Result<(), String> { platform::zoom_toggle() }

/// Zoom in one step.
#[tauri::command]
fn zoom_in() -> Result<(), String> { platform::zoom_in() }

/// Zoom out one step.
#[tauri::command]
fn zoom_out() -> Result<(), String> { platform::zoom_out() }

/// Keep the overlay pinned to whichever display it is currently on.
///
/// The window is framed to its monitor once at startup, but the answer changes:
/// the user moves the app to the other screen, unplugs the external, or the OS
/// rearranges displays. Gaze is mapped across the DISPLAY rect, so a stale frame
/// misplaces every click, not just the visuals.
///
/// Polling is the pragmatic mechanism: there is no cross-platform display-change
/// event in Tauri. Emits `gaze:display-changed` so the UI can re-read `screen_info`.
fn spawn_display_watcher(app: tauri::AppHandle) {
    use tauri::Emitter;
    std::thread::spawn(move || {
        let mut last: Option<(i32, i32, u32, u32)> = None;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(700));
            let Some(win) = app.get_webview_window("main") else { continue };
            let Ok(Some(mon)) = win.current_monitor() else { continue };
            let p = *mon.position();
            let s = *mon.size();
            let now = (p.x, p.y, s.width, s.height);
            if last == Some(now) { continue; }
            let first = last.is_none();
            last = Some(now);
            // Re-frame to fill the new display, so normalized [0,1] keeps meaning
            // "this screen's edges" (see `display_rect`).
            let _ = win.set_position(tauri::PhysicalPosition::new(p.x, p.y));
            let _ = win.set_size(tauri::PhysicalSize::new(s.width, s.height));
            if !first {
                println!("[gaze][display] changed -> {}x{} at ({},{})", s.width, s.height, p.x, p.y);
                let _ = app.emit("gaze:display-changed", ());
            }
        }
    });
}

/// Physical characteristics of the display the app is on, so the UI can size
/// itself to the actual device instead of assuming one screen.
///
/// `(width_pt, height_pt, scale, monitor_count, is_external)`.
#[tauri::command]
fn screen_info(window: tauri::WebviewWindow) -> Result<(f64, f64, f64, usize, bool), String> {
    let (_, _, w, h, scale) = display_rect(&window)?;
    let count = window.available_monitors().map(|m| m.len()).unwrap_or(1);
    // The built-in panel is the one at the global origin; anything else is external.
    let is_external = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.position().x != 0 || m.position().y != 0)
        .unwrap_or(false);
    Ok((w, h, scale, count, is_external))
}


/// Where the OS cursor is, as `(nx, ny, display_w, display_h)` (normalized to the
/// display, plus its size in logical points). X11 reads the real pointer; Wayland
/// has no global pointer query, so it reports the last position this app moved it to.
#[tauri::command]
fn cursor_norm(window: tauri::WebviewWindow) -> Result<Option<(f64, f64, f64, f64)>, String> {
    let (px, py, w, h, _) = display_rect(&window)?;
    Ok(platform::cursor_location().map(|(x, y)| ((x - px) / w, (y - py) / h, w, h)))
}

/// `<app_data_dir>/logs`, where the accuracy test and pixel-error logger write in
/// the compiled app (the dev server's `public/` is not there).
fn log_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = session_path(app)?.with_file_name("logs");
    fs::create_dir_all(&dir).map_err(|e| format!("create log dir: {e}"))?;
    Ok(dir)
}

/// Only plain `*.log` names, so the frontend can't write outside the log dir.
fn safe_log_name(name: &str) -> bool {
    name.ends_with(".log") && name.len() < 96
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        && !name.contains("..")
}

/// Create a fresh timestamped accuracy-test log. Returns its full path.
#[tauri::command]
fn diag_log_start(app: tauri::AppHandle) -> Result<String, String> {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let path = log_dir(&app)?.join(format!("pixel_error_{secs}.log"));
    fs::write(&path, "").map_err(|e| format!("create log: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Append one line to a log in the log dir (`file` is a bare name or a path returned
/// by `diag_log_start`; only its file name is used).
#[tauri::command]
fn diag_log_append(app: tauri::AppHandle, file: String, line: String) -> Result<(), String> {
    use std::io::Write;
    let name = std::path::Path::new(&file).file_name().and_then(|n| n.to_str()).unwrap_or("");
    if !safe_log_name(name) { return Err("invalid log name".into()); }
    if line.len() > 4096 { return Err("log line too long".into()); }
    let mut f = fs::OpenOptions::new().create(true).append(true).open(log_dir(&app)?.join(name))
        .map_err(|e| format!("open log: {e}"))?;
    f.write_all(line.trim_end().as_bytes()).and_then(|_| f.write_all(b"\n")).map_err(|e| format!("write log: {e}"))
}

/// Print a diagnostic line from the UI to the app's stdout.
///
/// The webview console isn't reachable in a release build, and the calibration
/// problems we chase happen while the user's eyes must stay on a moving dot — so
/// stdout is the only channel that can be captured and inspected afterwards.
#[tauri::command]
fn dev_log(line: String) {
    println!("[gaze][ui] {line}");
}

/// Whether the platform's input-injection permission is effective (macOS
/// Accessibility; on Linux, a ready input backend).
#[tauri::command]
fn is_trusted() -> bool {
    platform::is_trusted()
}

/// Prompt for / start the platform's input permission flow (macOS Accessibility
/// prompt; on Linux the RemoteDesktop portal consent).
#[tauri::command]
fn request_accessibility() -> bool {
    platform::request_access()
}

/// Type a Unicode string into the focused app (on-screen keyboard).
#[tauri::command]
fn type_text(text: String) -> Result<(), String> {
    platform::type_text(&text)
}

/// Tap a key by name (backspace, return, space).
#[tauri::command]
fn key_tap(key: Key) -> Result<(), String> {
    platform::key_tap(key)
}

/// Watch the focused element from a dedicated thread and emit `gaze:text-focus`
/// (bool) whenever it changes between an editable text field and not — the signal
/// the frontend uses to auto-show/hide the keyboard.
fn spawn_text_focus_watcher(app: tauri::AppHandle) {
    use tauri::Emitter;
    std::thread::spawn(move || {
        let mut last = false;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(300));
            let now = platform::focused_is_text();
            if now != last {
                last = now;
                let _ = app.emit("gaze:text-focus", now);
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Emitter;
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

    // ⌃⌥Space arms/disarms gaze control of the cursor. ⌃⌥P pauses/resumes.
    // Global so they work even when the click-through overlay has no focus — and
    // so pause can always be escaped by keyboard even if the control bar isn't
    // reachable.
    let arm_toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);
    let pause_toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyP);
    let reanchor = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyR);

    // Shared nearby-target cache, kept fresh by the background scanner thread.
    let target_cache = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    // Where that scanner looks — the raw gaze, published by the frontend.
    let scan_center = std::sync::Arc::new(std::sync::Mutex::new(None));

    let builder = tauri::Builder::default();

    // Linux: Wayland compositors (GNOME < 48) offer no global-key grab to apps, so
    // the hotkeys can also be driven from the command line — bind
    // `gaze --toggle-armed` etc. as desktop custom shortcuts. A second invocation
    // forwards its args to the running instance, which emits the same events.
    // Must be the first plugin registered.
    #[cfg(target_os = "linux")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        for arg in argv.iter().skip(1) {
            let event = match arg.as_str() {
                "--toggle-armed" => "gaze:toggle-armed",
                "--toggle-pause" => "gaze:toggle-pause",
                "--reanchor" => "gaze:reanchor",
                _ => continue,
            };
            let _ = app.emit(event, ());
        }
    }));

    builder
        .manage(TargetCache(target_cache.clone()))
        .manage(ScanCenter(scan_center.clone()))
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed { return; }
                    if shortcut == &arm_toggle {
                        let _ = app.emit("gaze:toggle-armed", ());
                    } else if shortcut == &pause_toggle {
                        let _ = app.emit("gaze:toggle-pause", ());
                    } else if shortcut == &reanchor {
                        let _ = app.emit("gaze:reanchor", ());
                    }
                })
                .build(),
        )
        .setup(move |app| {
            // Shortcut registration can fail (e.g. a Wayland session without
            // X11 key grabs); that must not stop the app — the UI stays usable.
            for s in [arm_toggle, pause_toggle, reanchor] {
                if let Err(e) = app.global_shortcut().register(s) {
                    println!("[gaze][shortcut] could not register {s:?}: {e}");
                }
            }
            // Platform bring-up: macOS surfaces the Accessibility prompt; Linux
            // starts its input session and webview camera permissions.
            platform::init(app.handle());

            let caps = platform::capabilities();
            println!("[gaze][platform] {caps:?}");
            // The overlay must cover the ENTIRE display; the watcher performs the
            // initial framing and keeps it correct as displays change. An explicit
            // frame is used rather than maximize/zoom, which animate.
            spawn_display_watcher(app.handle().clone());
            // Auto-show the on-screen keyboard when a text field takes focus.
            if caps.text_focus { spawn_text_focus_watcher(app.handle().clone()); }
            // Keep the nearby-clickable cache warm for instant magnetism.
            if caps.magnet { spawn_target_scanner(target_cache.clone(), scan_center.clone()); }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_session,
            save_session,
            clear_session,
            warp_cursor,
            mouse_click,
            mouse_right_click,
            mouse_double_click,
            mouse_scroll,
            set_click_through,
            snap_target,
            nearby_targets,
            zoom_toggle,
            zoom_in,
            zoom_out,
            type_text,
            key_tap,
            is_trusted,
            request_accessibility,
            platform_info,
            dev_log,
            cursor_norm,
            diag_log_start,
            diag_log_append,
            screen_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
