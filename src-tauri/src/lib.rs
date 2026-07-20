// Native session persistence for Gaze.
//
// The frontend (`src/core/session/persistence.ts`) invokes these commands to
// store the user's permission grant, calibration model, and preferences. The
// payload is an opaque JSON string owned by the frontend — Rust only persists
// it to a file under the OS app-data directory and falls back gracefully.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

const SESSION_FILE: &str = "session.json";

// --- Gaze space --------------------------------------------------------------
// The screen-region (physical px + scale) that gaze coordinates are normalized
// against. Captured ONCE when tracking starts — while the main window still
// covers the screen — so the window can then shrink into a compact HUD capsule
// without breaking any gaze→screen math. All cursor/click/snap commands prefer
// this stored space over live window geometry.
#[derive(Clone, Copy)]
struct Space {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    scale: f64,
}

struct GazeSpace(Mutex<Option<Space>>);

/// The effective gaze space: the captured one, else the window's live geometry.
fn space_of(window: &tauri::WebviewWindow, state: &tauri::State<GazeSpace>) -> Result<Space, String> {
    if let Some(s) = *state.0.lock().unwrap() {
        return Ok(s);
    }
    let pos = window.inner_position().map_err(|e| format!("inner_position: {e}"))?;
    let size = window.inner_size().map_err(|e| format!("inner_size: {e}"))?;
    let scale = window.scale_factor().map_err(|e| format!("scale_factor: {e}"))?;
    Ok(Space { x: pos.x as f64, y: pos.y as f64, w: size.width as f64, h: size.height as f64, scale })
}

/// Capture the CURRENT window geometry as the gaze space. Call at the moment
/// tracking starts, while the window still spans the calibrated screen area.
#[tauri::command]
fn capture_gaze_space(window: tauri::WebviewWindow, state: tauri::State<GazeSpace>) -> Result<(), String> {
    let pos = window.inner_position().map_err(|e| format!("inner_position: {e}"))?;
    let size = window.inner_size().map_err(|e| format!("inner_size: {e}"))?;
    let scale = window.scale_factor().map_err(|e| format!("scale_factor: {e}"))?;
    *state.0.lock().unwrap() = Some(Space {
        x: pos.x as f64,
        y: pos.y as f64,
        w: size.width as f64,
        h: size.height as f64,
        scale,
    });
    Ok(())
}

// Compact HUD capsule bounds (logical px). Sized to fit the control capsule
// plus a slim banner row above it; positioned bottom-center of the gaze space.
const CAPSULE_W: f64 = 640.0;
const CAPSULE_H: f64 = 170.0;

/// Morph the main window between its three utility shapes. Done in Rust so it
/// isn't subject to the JS window ACL and happens as one atomic native call.
///  - "full":     maximized (onboarding / calibration / settings scenes)
///  - "capsule":  compact HUD, bottom-center of the gaze space
///  - "expanded": exactly the gaze space (gaze-anchored overlays: wheel,
///                keyboard, tutorial, re-anchor, accuracy test)
#[tauri::command]
fn set_window_mode(window: tauri::WebviewWindow, state: tauri::State<GazeSpace>, mode: String) -> Result<(), String> {
    // The follower ring only exists during active tracking. Hiding its window
    // during calibration/onboarding removes a whole webview from compositing —
    // GPU headroom that MediaPipe needs for a smooth calibration.
    let ring = window.app_handle().get_webview_window("ring");
    match mode.as_str() {
        "full" => {
            if let Some(r) = &ring {
                let _ = r.hide();
            }
            let _ = window.show();
            // Guard: macOS zoom is a toggle — re-maximizing an already-maximized
            // window would restore it instead.
            if !window.is_maximized().unwrap_or(false) {
                window.maximize().map_err(|e| format!("maximize: {e}"))?;
            }
            // Keep the (accessory-policy) app ACTIVE during calibration: WKWebView
            // throttles rAF in inactive apps, which visibly stutters the dot.
            let _ = window.set_focus();
            Ok(())
        }
        "capsule" => {
            if let Some(r) = &ring {
                let _ = r.show();
            }
            let s = space_of(&window, &state)?;
            let _ = window.unmaximize();
            window
                .set_size(tauri::LogicalSize::new(CAPSULE_W, CAPSULE_H))
                .map_err(|e| format!("set_size: {e}"))?;
            let x = (s.x + (s.w - CAPSULE_W * s.scale) / 2.0) / s.scale;
            let y = (s.y + s.h) / s.scale - CAPSULE_H;
            window
                .set_position(tauri::LogicalPosition::new(x, y))
                .map_err(|e| format!("set_position: {e}"))
        }
        "expanded" => {
            if let Some(r) = &ring {
                let _ = r.show();
            }
            let s = space_of(&window, &state)?;
            let _ = window.unmaximize();
            window
                .set_size(tauri::LogicalSize::new(s.w / s.scale, s.h / s.scale))
                .map_err(|e| format!("set_size: {e}"))?;
            window
                .set_position(tauri::LogicalPosition::new(s.x / s.scale, s.y / s.scale))
                .map_err(|e| format!("set_position: {e}"))
        }
        other => Err(format!("unknown window mode: {other}")),
    }
}

#[derive(serde::Serialize)]
struct GazeMapping {
    gsx: f64,
    gsy: f64,
    gsw: f64,
    gsh: f64,
    wx: f64,
    wy: f64,
    scale: f64,
}

/// The gaze space plus the calling window's current position — everything the
/// frontend needs to convert gaze-normalized points to window-local CSS pixels
/// (and back) after the window has morphed into the HUD capsule.
#[tauri::command]
fn gaze_mapping(window: tauri::WebviewWindow, state: tauri::State<GazeSpace>) -> Result<GazeMapping, String> {
    let s = space_of(&window, &state)?;
    let pos = window.inner_position().map_err(|e| format!("inner_position: {e}"))?;
    let scale = window.scale_factor().map_err(|e| format!("scale_factor: {e}"))?;
    Ok(GazeMapping {
        gsx: s.x,
        gsy: s.y,
        gsw: s.w,
        gsh: s.h,
        wx: pos.x as f64,
        wy: pos.y as f64,
        scale,
    })
}

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
        CGEvent, CGEventTapLocation, CGEventType, CGKeyCode, CGMouseButton,
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

    /// Begin a drag: warp to (x,y), then press & hold the left button.
    pub fn drag_start(x: f64, y: f64) -> Result<(), String> {
        unsafe { CGWarpMouseCursorPosition(CGPoint::new(x, y)); }
        event(CGEventType::MouseMoved, CGMouseButton::Left, x, y)?.post(CGEventTapLocation::HID);
        event(CGEventType::LeftMouseDown, CGMouseButton::Left, x, y)?.post(CGEventTapLocation::HID);
        Ok(())
    }

    /// Continue a drag: post a left-button DRAG event to (x,y). Apps need dragged
    /// events (not plain moves) to update a selection/window during the drag.
    pub fn drag_to(x: f64, y: f64) -> Result<(), String> {
        unsafe { CGWarpMouseCursorPosition(CGPoint::new(x, y)); }
        event(CGEventType::LeftMouseDragged, CGMouseButton::Left, x, y)?.post(CGEventTapLocation::HID);
        Ok(())
    }

    /// Finish a drag: final drag event then release the left button at (x,y).
    pub fn drag_end(x: f64, y: f64) -> Result<(), String> {
        unsafe { CGWarpMouseCursorPosition(CGPoint::new(x, y)); }
        event(CGEventType::LeftMouseDragged, CGMouseButton::Left, x, y)?.post(CGEventTapLocation::HID);
        event(CGEventType::LeftMouseUp, CGMouseButton::Left, x, y)?.post(CGEventTapLocation::HID);
        Ok(())
    }

    /// Type a Unicode string into the focused app (on-screen keyboard). Posts a
    /// keyboard event carrying the string, so it lands wherever the caret is.
    pub fn type_text(text: &str) -> Result<(), String> {
        let d = CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| "event source".to_string())?;
        let down = CGEvent::new_keyboard_event(d, 0, true).map_err(|_| "key event".to_string())?;
        down.set_string(text);
        down.post(CGEventTapLocation::HID);
        let u = CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| "event source".to_string())?;
        let up = CGEvent::new_keyboard_event(u, 0, false).map_err(|_| "key event".to_string())?;
        up.set_string(text);
        up.post(CGEventTapLocation::HID);
        Ok(())
    }

    /// Current global cursor position in logical points (top-left origin).
    pub fn cursor_location() -> Option<(f64, f64)> {
        let src = CGEventSource::new(CGEventSourceStateID::HIDSystemState).ok()?;
        let e = CGEvent::new(src).ok()?;
        let p = e.location();
        Some((p.x, p.y))
    }

    /// Tap a virtual key by macOS keycode (e.g. 51 delete, 36 return, 49 space).
    pub fn key_tap(code: u16) -> Result<(), String> {
        let d = CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| "event source".to_string())?;
        CGEvent::new_keyboard_event(d, code as CGKeyCode, true).map_err(|_| "key event".to_string())?.post(CGEventTapLocation::HID);
        let u = CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| "event source".to_string())?;
        CGEvent::new_keyboard_event(u, code as CGKeyCode, false).map_err(|_| "key event".to_string())?.post(CGEventTapLocation::HID);
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
/// the gaze space). Returns (nx, ny, w_norm, h_norm) of the target center, or
/// None. All AX complexity is isolated here; the frontend just gets a point.
#[tauri::command]
fn snap_target(window: tauri::WebviewWindow, state: tauri::State<GazeSpace>, nx: f64, ny: f64, radius: f64) -> Result<Option<(f64, f64, f64, f64)>, String> {
    #[cfg(target_os = "macos")]
    {
        let s = space_of(&window, &state)?;
        let gx = (s.x + nx * s.w) / s.scale;
        let gy = (s.y + ny * s.h) / s.scale;
        let radius_px = radius * s.w / s.scale;
        let my_pid = std::process::id() as i32;
        let res = unsafe { mac_ax::nearest_target(gx, gy, radius_px, my_pid) };
        Ok(res.map(|(cx, cy, tw, th)| {
            let bnx = (cx * s.scale - s.x) / s.w;
            let bny = (cy * s.scale - s.y) / s.h;
            (bnx, bny, tw * s.scale / s.w, th * s.scale / s.h)
        }))
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (window, state, nx, ny, radius); Ok(None) }
}

/// Map a gaze point (normalized to the gaze space) to a global screen point in
/// logical points (top-left origin) — the space CoreGraphics uses. Uses the
/// captured gaze space when present, so the mapping stays correct after the
/// main window shrinks into the HUD capsule.
#[cfg(target_os = "macos")]
fn to_global(window: &tauri::WebviewWindow, state: &tauri::State<GazeSpace>, nx: f64, ny: f64) -> Result<(f64, f64), String> {
    let s = space_of(window, state)?;
    Ok(((s.x + nx * s.w) / s.scale, (s.y + ny * s.h) / s.scale))
}

/// Assert click-through ONLY when this window substantially covers the gaze
/// space (i.e. it's the full-screen overlay that could shield the click). The
/// compact HUD capsule must keep receiving real mouse clicks, so it is never
/// forced click-through by a synthetic click elsewhere on screen.
#[cfg(target_os = "macos")]
fn shield_guard(window: &tauri::WebviewWindow, state: &tauri::State<GazeSpace>) {
    let covering = (|| -> Result<bool, String> {
        let s = space_of(window, state)?;
        let size = window.inner_size().map_err(|e| format!("inner_size: {e}"))?;
        Ok(size.width as f64 >= 0.9 * s.w && size.height as f64 >= 0.9 * s.h)
    })()
    .unwrap_or(true);
    if covering {
        let _ = window.set_ignore_cursor_events(true);
    }
}

const RING_HALF: f64 = 32.0; // ring window is 64×64 logical

/// Follow the REAL OS cursor with the ring window from a dedicated thread —
/// decoupled from the warp path so cursor warps stay dirt-cheap. Polls at
/// ~30Hz and only issues a window move when the cursor actually moved, so a
/// parked (fixation-locked) cursor costs zero window-server traffic.
#[cfg(target_os = "macos")]
fn spawn_ring_follower(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut last = (f64::NAN, f64::NAN);
        loop {
            std::thread::sleep(std::time::Duration::from_millis(33));
            let Some((x, y)) = mac_input::cursor_location() else { continue };
            if (x - last.0).abs() < 1.5 && (y - last.1).abs() < 1.5 {
                continue;
            }
            last = (x, y);
            if let Some(ring) = app.get_webview_window("ring") {
                let _ = ring.set_position(tauri::LogicalPosition::new(x - RING_HALF, y - RING_HALF));
            }
        }
    });
}

/// Move the OS cursor to a gaze point (normalized to the gaze space).
#[tauri::command]
fn warp_cursor(window: tauri::WebviewWindow, state: tauri::State<GazeSpace>, nx: f64, ny: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (x, y) = to_global(&window, &state, nx, ny)?;
        mac_input::warp(x, y)
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (window, state, nx, ny); Err("native cursor control is macOS-only".into()) }
}

/// Left-click at a gaze point (normalized to the gaze space).
#[tauri::command]
fn mouse_click(window: tauri::WebviewWindow, state: tauri::State<GazeSpace>, nx: f64, ny: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (x, y) = to_global(&window, &state, nx, ny)?;
        // If this window is the full-screen overlay, guarantee it's click-through
        // at the instant of the click so the synthetic event passes to the app
        // beneath instead of being caught by our own always-on-top window.
        shield_guard(&window, &state);
        mac_input::click(x, y)
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (window, state, nx, ny); Err("native clicking is macOS-only".into()) }
}

/// Right-click at a gaze point (normalized to gaze space) — context menus.
#[tauri::command]
fn mouse_right_click(window: tauri::WebviewWindow, state: tauri::State<GazeSpace>, nx: f64, ny: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (x, y) = to_global(&window, &state, nx, ny)?;
        shield_guard(&window, &state);
        mac_input::right_click(x, y)
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (window, state, nx, ny); Err("native clicking is macOS-only".into()) }
}

/// Double-click at a gaze point (normalized to gaze space).
#[tauri::command]
fn mouse_double_click(window: tauri::WebviewWindow, state: tauri::State<GazeSpace>, nx: f64, ny: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (x, y) = to_global(&window, &state, nx, ny)?;
        shield_guard(&window, &state);
        mac_input::double_click(x, y)
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (window, state, nx, ny); Err("native clicking is macOS-only".into()) }
}

/// Scroll the app under the cursor vertically by `dy` pixels. Powers edge-gaze
/// scrolling / hands-free reading.
#[tauri::command]
fn mouse_scroll(window: tauri::WebviewWindow, state: tauri::State<GazeSpace>, dy: i32) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        shield_guard(&window, &state);
        mac_input::scroll(dy)
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (window, state, dy); Err("native scrolling is macOS-only".into()) }
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

/// Begin a gaze-driven drag at a normalized point (press & hold left button).
#[tauri::command]
fn mouse_drag_start(window: tauri::WebviewWindow, state: tauri::State<GazeSpace>, nx: f64, ny: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { let (x, y) = to_global(&window, &state, nx, ny)?; shield_guard(&window, &state); mac_input::drag_start(x, y) }
    #[cfg(not(target_os = "macos"))]
    { let _ = (window, state, nx, ny); Err("native dragging is macOS-only".into()) }
}

/// Continue a gaze-driven drag to a normalized point.
#[tauri::command]
fn mouse_drag_to(window: tauri::WebviewWindow, state: tauri::State<GazeSpace>, nx: f64, ny: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (x, y) = to_global(&window, &state, nx, ny)?;
        mac_input::drag_to(x, y)
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (window, state, nx, ny); Err("native dragging is macOS-only".into()) }
}

/// Finish a gaze-driven drag at a normalized point (release left button).
#[tauri::command]
fn mouse_drag_end(window: tauri::WebviewWindow, state: tauri::State<GazeSpace>, nx: f64, ny: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { let (x, y) = to_global(&window, &state, nx, ny)?; shield_guard(&window, &state); mac_input::drag_end(x, y) }
    #[cfg(not(target_os = "macos"))]
    { let _ = (window, state, nx, ny); Err("native dragging is macOS-only".into()) }
}

/// Type a Unicode string into the focused app (on-screen keyboard).
#[tauri::command]
fn type_text(text: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { mac_input::type_text(&text) }
    #[cfg(not(target_os = "macos"))]
    { let _ = text; Err("native typing is macOS-only".into()) }
}

/// Tap a virtual key by macOS keycode (backspace, return, space, …).
#[tauri::command]
fn key_tap(code: u16) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { mac_input::key_tap(code) }
    #[cfg(not(target_os = "macos"))]
    { let _ = code; Err("native typing is macOS-only".into()) }
}

/// List connected displays by name (for the multi-monitor picker).
#[tauri::command]
fn list_monitors(window: tauri::WebviewWindow) -> Result<Vec<String>, String> {
    let mons = window.available_monitors().map_err(|e| format!("monitors: {e}"))?;
    Ok(mons.iter().enumerate()
        .map(|(i, m)| m.name().cloned().unwrap_or_else(|| format!("Display {}", i + 1)))
        .collect())
}

/// Move + size the overlay to cover a chosen display. Because calibration is
/// screen-relative, the frontend should recalibrate after switching displays.
#[tauri::command]
fn move_to_monitor(window: tauri::WebviewWindow, index: usize) -> Result<(), String> {
    let mons = window.available_monitors().map_err(|e| format!("monitors: {e}"))?;
    let m = mons.get(index).ok_or_else(|| "monitor index out of range".to_string())?;
    let pos = m.position();
    let size = m.size();
    window.set_position(tauri::PhysicalPosition::new(pos.x, pos.y)).map_err(|e| format!("set_position: {e}"))?;
    window.set_size(tauri::PhysicalSize::new(size.width, size.height)).map_err(|e| format!("set_size: {e}"))?;
    Ok(())
}

/// Temporary diagnostics tap: prints frontend perf telemetry to the terminal so
/// lag reports come with numbers (webview console isn't visible in `tauri dev`).
#[tauri::command]
fn log_perf(msg: String) {
    println!("[gaze-perf] {msg}");
}

/// Open the macOS Accessibility settings pane directly, so the user can grant
/// (or re-grant, after a rebuild invalidated it) permission in one tap.
#[tauri::command]
fn open_accessibility_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("open settings: {e}"))
    }
    #[cfg(not(target_os = "macos"))]
    { Ok(()) }
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
    // ⌃⌥Return = "switch" click (fires a click at the gaze in switch activation mode).
    let switch_click = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Enter);
    // ⌃⌥K toggles the hands-free on-screen keyboard.
    let keyboard = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyK);
    // ⌃⌥T runs the accuracy test; ⌃⌥Z toggles precision (fine-targeting) mode.
    let accuracy_test = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyT);
    let precision = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyZ);

    tauri::Builder::default()
        .manage(GazeSpace(Mutex::new(None)))
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
                    } else if shortcut == &switch_click {
                        let _ = app.emit("gaze:switch-click", ());
                    } else if shortcut == &keyboard {
                        let _ = app.emit("gaze:toggle-keyboard", ());
                    } else if shortcut == &accuracy_test {
                        let _ = app.emit("gaze:accuracy-test", ());
                    } else if shortcut == &precision {
                        let _ = app.emit("gaze:toggle-precision", ());
                    }
                })
                .build(),
        )
        // Utility behavior: closing the main window HIDES it (tracking state is
        // paused via an event so gaze control never silently stops while the
        // webview is throttled). Quit only via the menu-bar item.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.app_handle().emit("gaze:force-pause", ());
                let _ = window.hide();
            }
        })
        .setup(move |app| {
            app.global_shortcut().register(arm_toggle)?;
            app.global_shortcut().register(pause_toggle)?;
            app.global_shortcut().register(reanchor)?;
            app.global_shortcut().register(switch_click)?;
            app.global_shortcut().register(keyboard)?;
            app.global_shortcut().register(accuracy_test)?;
            app.global_shortcut().register(precision)?;
            // Surface the real Accessibility prompt on launch if we're not yet
            // trusted, so the app gets registered/granted properly.
            #[cfg(target_os = "macos")]
            { let _ = prompt_accessibility(); }

            // Background-utility presence: no Dock icon / app-switcher entry —
            // Gaze lives in the menu bar like a real macOS utility.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Menu-bar (tray) item: the app's persistent, quiet home. Open
            // restores the main window; Pause/Resume and Recalibrate reuse the
            // existing event wiring; Quit is the only way to exit.
            {
                use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
                use tauri::tray::TrayIconBuilder;
                let open = MenuItem::with_id(app, "open", "Open Gaze", true, None::<&str>)?;
                let pause = MenuItem::with_id(app, "pause", "Pause / Resume\t⌃⌥P", true, None::<&str>)?;
                let recal = MenuItem::with_id(app, "recalibrate", "Recalibrate…", true, None::<&str>)?;
                let sep = PredefinedMenuItem::separator(app)?;
                let quit = MenuItem::with_id(app, "quit", "Quit Gaze", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&open, &pause, &recal, &sep, &quit])?;
                let mut tray = TrayIconBuilder::with_id("gaze-tray")
                    .menu(&menu)
                    .show_menu_on_left_click(true)
                    .tooltip("Gaze — eye tracking");
                if let Some(icon) = app.default_window_icon().cloned() {
                    tray = tray.icon(icon);
                }
                tray.on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "open" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "pause" => { let _ = app.emit("gaze:toggle-pause", ()); }
                        "recalibrate" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                            let _ = app.emit("gaze:recalibrate", ());
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .build(app)?;
            }

            // First launch: make sure the (accessory-policy) window is in front.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }

            // Ring follows the real cursor from its own thread — never from the
            // hot warp path. Hidden until tracking starts (set_window_mode shows
            // it for capsule/expanded and hides it for full).
            if let Some(r) = app.get_webview_window("ring") {
                let _ = r.hide();
            }
            #[cfg(target_os = "macos")]
            spawn_ring_follower(app.handle().clone());
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
            request_accessibility,
            open_accessibility_settings,
            mouse_drag_start,
            mouse_drag_to,
            mouse_drag_end,
            type_text,
            key_tap,
            list_monitors,
            move_to_monitor,
            capture_gaze_space,
            gaze_mapping,
            set_window_mode,
            log_perf
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
