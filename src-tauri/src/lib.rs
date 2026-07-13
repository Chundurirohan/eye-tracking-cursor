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
    use std::os::raw::c_void;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWarpMouseCursorPosition(new_position: CGPoint) -> i32;
        fn CGAssociateMouseAndMouseCursorPosition(connected: bool) -> i32;
        // Variadic in C — declared with `...` so the wheel deltas use the
        // correct variadic ABI (critical on Apple Silicon).
        fn CGEventCreateScrollWheelEvent(
            source: *const c_void, units: u32, wheel_count: u32, ...
        ) -> *const c_void;
        fn CGEventPost(tap: u32, event: *const c_void);
    }

    fn event(kind: CGEventType, btn: CGMouseButton, x: f64, y: f64) -> Result<CGEvent, String> {
        let src = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .map_err(|_| "event source".to_string())?;
        CGEvent::new_mouse_event(src, kind, CGPoint::new(x, y), btn)
            .map_err(|_| "mouse event".to_string())
    }

    /// Move the OS cursor. Uses CGWarp, which does NOT require Accessibility, so
    /// the cursor locks to the gaze reticle even before click permission is
    /// granted. (Synthetic-event movement needed Accessibility and silently
    /// no-op'd without it — the "reticle moves but cursor doesn't" bug.)
    pub fn warp(x: f64, y: f64) -> Result<(), String> {
        unsafe {
            CGWarpMouseCursorPosition(CGPoint::new(x, y));
            // Re-link pointer input so it stays responsive (CGWarp otherwise
            // briefly suppresses movement).
            CGAssociateMouseAndMouseCursorPosition(true);
        }
        Ok(())
    }

    /// Click at (x,y): warp there, then post a realistic move → down → up. The
    /// button events DO require Accessibility permission (unavoidable for
    /// injecting clicks into other apps). A move event (so the target registers
    /// the pointer) plus a short gap between down and up makes it read as a
    /// genuine click — an instantaneous down/up is dropped by some apps.
    pub fn click(x: f64, y: f64) -> Result<(), String> {
        unsafe { CGWarpMouseCursorPosition(CGPoint::new(x, y)); }
        event(CGEventType::MouseMoved, CGMouseButton::Left, x, y)?.post(CGEventTapLocation::HID);
        event(CGEventType::LeftMouseDown, CGMouseButton::Left, x, y)?.post(CGEventTapLocation::HID);
        std::thread::sleep(std::time::Duration::from_millis(12));
        event(CGEventType::LeftMouseUp, CGMouseButton::Left, x, y)?.post(CGEventTapLocation::HID);
        Ok(())
    }

    /// Right-click at (x,y) — opens context menus.
    pub fn right_click(x: f64, y: f64) -> Result<(), String> {
        unsafe { CGWarpMouseCursorPosition(CGPoint::new(x, y)); }
        event(CGEventType::MouseMoved, CGMouseButton::Left, x, y)?.post(CGEventTapLocation::HID);
        event(CGEventType::RightMouseDown, CGMouseButton::Right, x, y)?.post(CGEventTapLocation::HID);
        std::thread::sleep(std::time::Duration::from_millis(12));
        event(CGEventType::RightMouseUp, CGMouseButton::Right, x, y)?.post(CGEventTapLocation::HID);
        Ok(())
    }

    /// Double-click at (x,y) — two rapid left clicks (system coalesces by timing).
    pub fn double_click(x: f64, y: f64) -> Result<(), String> {
        unsafe { CGWarpMouseCursorPosition(CGPoint::new(x, y)); }
        event(CGEventType::MouseMoved, CGMouseButton::Left, x, y)?.post(CGEventTapLocation::HID);
        for _ in 0..2 {
            event(CGEventType::LeftMouseDown, CGMouseButton::Left, x, y)?.post(CGEventTapLocation::HID);
            event(CGEventType::LeftMouseUp, CGMouseButton::Left, x, y)?.post(CGEventTapLocation::HID);
        }
        Ok(())
    }

    /// Scroll vertically by `dy` pixels (sign = direction). Posted as a scroll-
    /// wheel event so it works in any app.
    pub fn scroll(dy: i32) -> Result<(), String> {
        unsafe {
            // units=0 (pixel), wheelCount=1, wheel1=dy (variadic).
            let e = CGEventCreateScrollWheelEvent(std::ptr::null(), 0, 1, dy);
            if e.is_null() { return Err("scroll event".into()); }
            CGEventPost(0, e); // 0 = HID event tap
            core_foundation::base::CFRelease(e);
        }
        Ok(())
    }
}

// --- System-wide target snapping via the macOS Accessibility API ------------
// Enumerates clickable UI elements from OTHER apps near the gaze point so the
// cursor can magnetically snap onto small buttons anywhere on screen (not just
// this app's own controls). Uses position hit-tests (AXUIElementCopyElementAt-
// Position), which are cheap and independent of the target app's UI-tree size.
// Requires macOS Accessibility permission (already needed for cursor control).
#[cfg(target_os = "macos")]
mod mac_ax {
    use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
    use core_foundation::string::{CFString, CFStringRef};
    use core_graphics::geometry::{CGPoint, CGSize};
    use std::os::raw::c_void;

    pub type AXUIElementRef = *const c_void;
    const K_AX_VALUE_CGPOINT: u32 = 1;
    const K_AX_VALUE_CGSIZE: u32 = 2;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateSystemWide() -> AXUIElementRef;
        fn AXUIElementCopyElementAtPosition(
            app: AXUIElementRef, x: f32, y: f32, out: *mut AXUIElementRef,
        ) -> i32;
        fn AXUIElementCopyAttributeValue(
            el: AXUIElementRef, attr: CFStringRef, out: *mut CFTypeRef,
        ) -> i32;
        fn AXUIElementGetPid(el: AXUIElementRef, pid: *mut i32) -> i32;
        fn AXValueGetValue(value: CFTypeRef, the_type: u32, out: *mut c_void) -> bool;
    }

    fn is_clickable(role: &str) -> bool {
        matches!(
            role,
            "AXButton" | "AXLink" | "AXMenuItem" | "AXMenuButton" | "AXPopUpButton"
                | "AXCheckBox" | "AXRadioButton" | "AXTextField" | "AXComboBox"
                | "AXTabButton" | "AXMenuBarItem" | "AXDisclosureTriangle" | "AXSearchField"
        )
    }

    /// Copy an attribute value (+1 retained; caller must CFRelease).
    unsafe fn copy_attr(el: AXUIElementRef, attr: &str) -> Option<CFTypeRef> {
        let key = CFString::new(attr);
        let mut out: CFTypeRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(el, key.as_concrete_TypeRef(), &mut out);
        if err == 0 && !out.is_null() { Some(out) } else { None }
    }

    unsafe fn ax_role(el: AXUIElementRef) -> Option<String> {
        let v = copy_attr(el, "AXRole")?;
        // Owned via create rule -> auto-released on drop.
        let s = CFString::wrap_under_create_rule(v as CFStringRef).to_string();
        Some(s)
    }

    unsafe fn ax_point(el: AXUIElementRef) -> Option<CGPoint> {
        let v = copy_attr(el, "AXPosition")?;
        let mut p = CGPoint { x: 0.0, y: 0.0 };
        let ok = AXValueGetValue(v, K_AX_VALUE_CGPOINT, &mut p as *mut _ as *mut c_void);
        CFRelease(v);
        if ok { Some(p) } else { None }
    }

    unsafe fn ax_size(el: AXUIElementRef) -> Option<CGSize> {
        let v = copy_attr(el, "AXSize")?;
        let mut s = CGSize { width: 0.0, height: 0.0 };
        let ok = AXValueGetValue(v, K_AX_VALUE_CGSIZE, &mut s as *mut _ as *mut c_void);
        CFRelease(v);
        if ok { Some(s) } else { None }
    }

    unsafe fn same_pid(el: AXUIElementRef, mine: i32) -> bool {
        let mut pid: i32 = 0;
        AXUIElementGetPid(el, &mut pid);
        pid == mine
    }

    /// Walk from `start` up to a nearby actionable ancestor; return its global
    /// rect center + size in logical points. `start` is owned by the caller.
    unsafe fn actionable_rect(start: AXUIElementRef) -> Option<(f64, f64, f64, f64)> {
        let mut cur = start;
        let mut owned: Option<AXUIElementRef> = None;
        let mut result = None;
        for _ in 0..4 {
            if let Some(role) = ax_role(cur) {
                if is_clickable(&role) {
                    if let (Some(p), Some(s)) = (ax_point(cur), ax_size(cur)) {
                        if s.width > 1.0 && s.height > 1.0 {
                            result = Some((p.x + s.width / 2.0, p.y + s.height / 2.0, s.width, s.height));
                            break;
                        }
                    }
                }
            }
            let parent = copy_attr(cur, "AXParent");
            if let Some(prev) = owned.take() { CFRelease(prev); }
            match parent {
                Some(p) => { owned = Some(p); cur = p as AXUIElementRef; }
                None => break,
            }
        }
        if let Some(prev) = owned.take() { CFRelease(prev); }
        result
    }

    fn probe_offsets(r: f64) -> Vec<(f64, f64)> {
        let mut v = vec![(0.0, 0.0)];
        for ring in [0.5f64, 1.0] {
            let rr = r * ring;
            for k in 0..8 {
                let a = std::f64::consts::PI * (k as f64) / 4.0;
                v.push((rr * a.cos(), rr * a.sin()));
            }
        }
        v
    }

    /// Nearest clickable target (from another app) within `radius` logical
    /// points of the gaze point. Returns (center_x, center_y, w, h) or None.
    pub unsafe fn nearest_target(gx: f64, gy: f64, radius: f64, my_pid: i32) -> Option<(f64, f64, f64, f64)> {
        let sys = AXUIElementCreateSystemWide();
        if sys.is_null() { return None; }
        // A position hit-test on the SYSTEM-WIDE element returns our own
        // always-on-top transparent overlay, never the app beneath it. So hit-
        // test the FOCUSED APPLICATION's element instead: that resolves inside
        // the real app the user is working in, regardless of our overlay's
        // z-order. (If our overlay is itself focused, there's nothing to snap.)
        let app = copy_attr(sys, "AXFocusedApplication");
        CFRelease(sys as CFTypeRef);
        let app = match app { Some(a) => a as AXUIElementRef, None => return None };
        if same_pid(app, my_pid) { CFRelease(app as CFTypeRef); return None; }

        let mut best: Option<(f64, f64, f64, f64, f64)> = None; // (dist, cx, cy, w, h)
        for (ox, oy) in probe_offsets(radius) {
            let mut el: AXUIElementRef = std::ptr::null();
            let err = AXUIElementCopyElementAtPosition(app, (gx + ox) as f32, (gy + oy) as f32, &mut el);
            if err != 0 || el.is_null() { continue; }
            if let Some((cx, cy, w, h)) = actionable_rect(el) {
                let d = ((cx - gx).powi(2) + (cy - gy).powi(2)).sqrt();
                if best.map_or(true, |b| d < b.0) { best = Some((d, cx, cy, w, h)); }
            }
            CFRelease(el as CFTypeRef);
        }
        CFRelease(app as CFTypeRef);
        best.map(|(_, cx, cy, w, h)| (cx, cy, w, h))
    }
}

/// Snap to the nearest system-wide clickable near a gaze point (normalized to
/// window content). Returns (nx, ny, w_norm, h_norm) of the target center, or
/// None. All AX complexity is isolated here; the frontend just gets a point.
#[tauri::command]
fn snap_target(window: tauri::WebviewWindow, nx: f64, ny: f64, radius: f64) -> Result<Option<(f64, f64, f64, f64)>, String> {
    #[cfg(target_os = "macos")]
    {
        let pos = window.inner_position().map_err(|e| format!("inner_position: {e}"))?;
        let size = window.inner_size().map_err(|e| format!("inner_size: {e}"))?;
        let scale = window.scale_factor().map_err(|e| format!("scale_factor: {e}"))?;
        let (w, h) = (size.width as f64, size.height as f64);
        let gx = (pos.x as f64 + nx * w) / scale;
        let gy = (pos.y as f64 + ny * h) / scale;
        let radius_px = radius * w / scale;
        let my_pid = std::process::id() as i32;
        let res = unsafe { mac_ax::nearest_target(gx, gy, radius_px, my_pid) };
        Ok(res.map(|(cx, cy, tw, th)| {
            let bnx = (cx * scale - pos.x as f64) / w;
            let bny = (cy * scale - pos.y as f64) / h;
            (bnx, bny, tw * scale / w, th * scale / h)
        }))
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (window, nx, ny, radius); Ok(None) }
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
    {
        let (x, y) = to_global(&window, nx, ny)?;
        // Guarantee the overlay is click-through at the instant of the click so
        // the synthetic event passes to the app beneath instead of being caught
        // by our own always-on-top window (the "shield"). Don't rely on the
        // frontend having already asserted it.
        let _ = window.set_ignore_cursor_events(true);
        mac_input::click(x, y)
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (window, nx, ny); Err("native clicking is macOS-only".into()) }
}

/// Right-click at a gaze point (normalized to window content) — context menus.
#[tauri::command]
fn mouse_right_click(window: tauri::WebviewWindow, nx: f64, ny: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (x, y) = to_global(&window, nx, ny)?;
        let _ = window.set_ignore_cursor_events(true);
        mac_input::right_click(x, y)
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (window, nx, ny); Err("native clicking is macOS-only".into()) }
}

/// Double-click at a gaze point (normalized to window content).
#[tauri::command]
fn mouse_double_click(window: tauri::WebviewWindow, nx: f64, ny: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (x, y) = to_global(&window, nx, ny)?;
        let _ = window.set_ignore_cursor_events(true);
        mac_input::double_click(x, y)
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (window, nx, ny); Err("native clicking is macOS-only".into()) }
}

/// Scroll the app under the cursor vertically by `dy` pixels. Powers edge-gaze
/// scrolling / hands-free reading.
#[tauri::command]
fn mouse_scroll(window: tauri::WebviewWindow, dy: i32) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = window.set_ignore_cursor_events(true);
        mac_input::scroll(dy)
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (window, dy); Err("native scrolling is macOS-only".into()) }
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

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: core_foundation::dictionary::CFDictionaryRef) -> bool;
    static kAXTrustedCheckOptionPrompt: core_foundation::string::CFStringRef;
}

/// Whether this app currently has effective macOS Accessibility permission.
/// Synthetic clicks (`mouse_click` etc.) silently no-op when this is false —
/// this is the definitive check for "is the permission actually working", vs a
/// stale toggle in System Settings.
#[tauri::command]
fn is_trusted() -> bool {
    #[cfg(target_os = "macos")]
    { unsafe { AXIsProcessTrusted() } }
    #[cfg(not(target_os = "macos"))]
    { true }
}

/// Show the real macOS "grant Accessibility" prompt and register this exact
/// binary in the Accessibility list, if not already trusted. This is the
/// reliable way to get the app added/granted — manually hunting for it in
/// System Settings is what left it stuck at "not trusted".
#[cfg(target_os = "macos")]
fn prompt_accessibility() -> bool {
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

/// Frontend-callable version of the prompt (e.g. from a "Grant access" button).
#[tauri::command]
fn request_accessibility() -> bool {
    #[cfg(target_os = "macos")]
    { prompt_accessibility() }
    #[cfg(not(target_os = "macos"))]
    { true }
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

    tauri::Builder::default()
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
            app.global_shortcut().register(arm_toggle)?;
            app.global_shortcut().register(pause_toggle)?;
            app.global_shortcut().register(reanchor)?;
            // Surface the real Accessibility prompt on launch if we're not yet
            // trusted, so the app gets registered/granted properly.
            #[cfg(target_os = "macos")]
            { let _ = prompt_accessibility(); }
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
            is_trusted,
            request_accessibility
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
