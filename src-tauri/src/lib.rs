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

/// Shared cache of nearby clickable targets (global logical points), kept fresh
/// by a background scanner thread so the frontend can hit-test locally every
/// frame — instant system-wide magnetism instead of throttled async queries.
#[derive(Default)]
struct TargetCache(std::sync::Arc<std::sync::Mutex<Vec<(f64, f64, f64, f64, f64)>>>);

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

// --- Native input: gaze-driven OS cursor + clicks (macOS) -------------------
// Posts CoreGraphics events so the gaze can move the real system cursor and
// click into ANY app (not just this window). Requires the app to be granted
// Accessibility permission in System Settings › Privacy & Security.
#[cfg(target_os = "macos")]
mod mac_input {
    use core_graphics::event::{
        CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGKeyCode, CGMouseButton,
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

    /// Tap a virtual key by macOS keycode (e.g. 51 delete, 36 return, 49 space).
    pub fn key_tap(code: u16) -> Result<(), String> {
        let d = CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| "event source".to_string())?;
        CGEvent::new_keyboard_event(d, code as CGKeyCode, true).map_err(|_| "key event".to_string())?.post(CGEventTapLocation::HID);
        let u = CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| "event source".to_string())?;
        CGEvent::new_keyboard_event(u, code as CGKeyCode, false).map_err(|_| "key event".to_string())?.post(CGEventTapLocation::HID);
        Ok(())
    }

    /// Post a key chord (modifier flags + keycode) as a real keystroke — used to
    /// drive the macOS built-in Zoom via its keyboard shortcuts (⌥⌘8 toggle, ⌥⌘=
    /// in, ⌥⌘- out). Requires "Use keyboard shortcuts to zoom" enabled in
    /// System Settings › Accessibility › Zoom.
    pub fn key_combo(flags_raw: u64, code: u16) -> Result<(), String> {
        let flags = CGEventFlags::from_bits_truncate(flags_raw);
        let d = CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| "event source".to_string())?;
        let down = CGEvent::new_keyboard_event(d, code as CGKeyCode, true).map_err(|_| "key event".to_string())?;
        down.set_flags(flags);
        down.post(CGEventTapLocation::HID);
        let u = CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| "event source".to_string())?;
        let up = CGEvent::new_keyboard_event(u, code as CGKeyCode, false).map_err(|_| "key event".to_string())?;
        up.set_flags(flags);
        up.post(CGEventTapLocation::HID);
        Ok(())
    }

    /// Current global cursor position in logical points (top-left origin). The
    /// background target scanner scans around this (the cursor tracks the gaze
    /// while armed), so magnetism never waits on a synchronous per-frame query.
    pub fn cursor_location() -> Option<(f64, f64)> {
        let src = CGEventSource::new(CGEventSourceStateID::HIDSystemState).ok()?;
        let e = CGEvent::new(src).ok()?;
        let p = e.location();
        Some((p.x, p.y))
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
    use core_foundation::boolean::CFBoolean;
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
        fn AXUIElementSetAttributeValue(el: AXUIElementRef, attr: CFStringRef, value: CFTypeRef) -> i32;
        fn AXUIElementCopyActionNames(el: AXUIElementRef, names: *mut core_foundation::array::CFArrayRef) -> i32;
        fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(
            option: u32, relative_to: u32,
        ) -> core_foundation::array::CFArrayRef;
        fn CGRectMakeWithDictionaryRepresentation(
            dict: core_foundation::dictionary::CFDictionaryRef,
            rect: *mut core_graphics::geometry::CGRect,
        ) -> bool;
        static kCGWindowOwnerPID: CFStringRef;
        static kCGWindowBounds: CFStringRef;
    }

    extern "C" {
        fn CFArrayGetCount(a: core_foundation::array::CFArrayRef) -> isize;
        fn CFArrayGetValueAtIndex(
            a: core_foundation::array::CFArrayRef, idx: isize,
        ) -> *const c_void;
        fn CFDictionaryGetValue(
            d: core_foundation::dictionary::CFDictionaryRef, key: *const c_void,
        ) -> *const c_void;
        fn CFNumberGetValue(n: *const c_void, the_type: i32, out: *mut c_void) -> bool;
    }

    const K_CG_WINDOW_LIST_ON_SCREEN_ONLY: u32 = 1 << 0;
    const K_CF_NUMBER_SINT32: i32 = 3;

    /// The application owning the frontmost on-screen window under a point,
    /// skipping our own process.
    ///
    /// This is what the magnet must hit-test. Using `AXFocusedApplication` was the
    /// bug behind "the magnet only works on our own HUD": our overlay is
    /// always-on-top and frequently IS the focused app, and the scan then bailed
    /// out via the `same_pid` guard, so no system-wide target was ever found —
    /// everywhere except Gaze's own controls. Window order also can't be derived
    /// from focus, so ask the window server directly.
    ///
    /// `CGWindowListCopyWindowInfo` returns windows front-to-back, and PID/bounds
    /// are readable without Screen Recording permission (only window *titles*
    /// require it), so this needs no permission beyond Accessibility.
    pub unsafe fn app_at_point(gx: f64, gy: f64, my_pid: i32) -> Option<AXUIElementRef> {
        for pid in pids_at_point(gx, gy, my_pid) {
            let app = AXUIElementCreateApplication(pid);
            if app.is_null() { continue; }
            // Commit to the first candidate that actually answers a hit-test here.
            // Picking only the topmost window resolved to phantom/system windows
            // (and to the Dock, whose layer sits above normal windows) which own no
            // AX elements at the gaze — 121 probes returning nothing at all.
            let mut el: AXUIElementRef = std::ptr::null();
            enable_app_a11y(app);
            let err = AXUIElementCopyElementAtPosition(app, gx as f32, gy as f32, &mut el);
            if err == 0 && !el.is_null() {
                CFRelease(el as CFTypeRef);
                return Some(app);
            }
            CFRelease(app as CFTypeRef);
        }
        None
    }

    /// PIDs owning on-screen windows under a point, front-to-back, excluding our
    /// own. Capped — the answer is always within the first few layers.
    unsafe fn pids_at_point(gx: f64, gy: f64, my_pid: i32) -> Vec<i32> {
        let mut found: Vec<i32> = Vec::new();
        let list = CGWindowListCopyWindowInfo(K_CG_WINDOW_LIST_ON_SCREEN_ONLY, 0);
        if list.is_null() { return found; }
        let count = CFArrayGetCount(list);
        for i in 0..count {
            let d = CFArrayGetValueAtIndex(list, i) as core_foundation::dictionary::CFDictionaryRef;
            if d.is_null() { continue; }

            let pid_ref = CFDictionaryGetValue(d, kCGWindowOwnerPID as *const c_void);
            if pid_ref.is_null() { continue; }
            let mut pid: i32 = 0;
            if !CFNumberGetValue(pid_ref, K_CF_NUMBER_SINT32, &mut pid as *mut i32 as *mut c_void) {
                continue;
            }
            if pid == my_pid { continue; } // never snap to ourselves

            let b = CFDictionaryGetValue(d, kCGWindowBounds as *const c_void)
                as core_foundation::dictionary::CFDictionaryRef;
            if b.is_null() { continue; }
            let mut r = core_graphics::geometry::CGRect::new(
                &CGPoint::new(0.0, 0.0), &CGSize::new(0.0, 0.0),
            );
            if !CGRectMakeWithDictionaryRepresentation(b, &mut r) { continue; }
            if r.size.width < 1.0 || r.size.height < 1.0 { continue; }

            if gx >= r.origin.x && gx <= r.origin.x + r.size.width
                && gy >= r.origin.y && gy <= r.origin.y + r.size.height
                && !found.contains(&pid)
            {
                found.push(pid); // front-to-back, so earlier entries are on top
                if found.len() >= 6 { break; }
            }
        }
        CFRelease(list as CFTypeRef);
        found
    }

    /// Whether an element exposes an interactive ACTION (AXPress / AXOpen /
    /// AXConfirm / AXShowMenu). This is the semantic "is this actually clickable"
    /// signal every element that can be pressed advertises — far more universal
    /// than guessing from role names, so the magnet catches buttons, links, icons,
    /// table rows, toolbar items, etc. that role-whitelisting misses.
    unsafe fn has_press_action(el: AXUIElementRef) -> bool {
        use core_foundation::array::{CFArray, CFArrayRef};
        use core_foundation::string::CFString;
        let mut arr: CFArrayRef = std::ptr::null();
        if AXUIElementCopyActionNames(el, &mut arr) != 0 || arr.is_null() { return false; }
        let names: CFArray<CFString> = CFArray::wrap_under_create_rule(arr);
        names.iter().any(|n| {
            let s = n.to_string();
            s == "AXPress" || s == "AXOpen" || s == "AXConfirm" || s == "AXShowMenu" || s == "AXPick"
        })
    }

    /// Force Chromium/Electron apps (Chrome, VS Code, Slack, Electron, …) to build
    /// their accessibility tree so their WEB CONTENT becomes hit-testable — they
    /// lazily skip it until an assistive client asks via `AXManualAccessibility`.
    /// Without this the magnet finds nothing over web/Electron UI. Cheap + idempotent.
    /// When we last switched a11y on for each PID, so we re-assert rarely rather
    /// than never (once-only is fragile: the first attempt can land before the app
    /// is ready to honour it, and Chromium can drop the flag when it thinks no
    /// assistive client is listening — after which the magnet finds nothing there
    /// forever).
    fn a11y_enabled_pids() -> &'static std::sync::Mutex<std::collections::HashMap<i32, std::time::Instant>> {
        static S: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<i32, std::time::Instant>>> =
            std::sync::OnceLock::new();
        S.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
    }

    /// How often the a11y flag may be re-asserted for a given app.
    const A11Y_REASSERT: std::time::Duration = std::time::Duration::from_secs(5);

    /// Setting `AXManualAccessibility` makes Chromium build its ENTIRE accessibility
    /// tree. That is a heavy, app-wide operation — re-asserting it on every 120ms
    /// scan (which is what the old unconditional call did) kept large apps rebuilding
    /// their tree continuously and pushed scans to 180–540ms. v2 never set this at
    /// all, which is a large part of why its magnet stayed responsive.
    ///
    /// Re-asserted at most once per `A11Y_REASSERT` per app — often enough to
    /// recover if the flag is dropped, rare enough to stay off the hot path.
    pub unsafe fn enable_app_a11y(app: AXUIElementRef) {
        let mut pid: i32 = 0;
        if AXUIElementGetPid(app, &mut pid) != 0 { return; }
        {
            let mut seen = match a11y_enabled_pids().lock() { Ok(s) => s, Err(_) => return };
            let now = std::time::Instant::now();
            match seen.get(&pid) {
                Some(&t) if now.duration_since(t) < A11Y_REASSERT => return,
                _ => { seen.insert(pid, now); }
            }
        }
        let attr = CFString::new("AXManualAccessibility");
        AXUIElementSetAttributeValue(app, attr.as_concrete_TypeRef(), CFBoolean::true_value().as_CFTypeRef());
    }

    fn is_clickable(role: &str) -> bool {
        matches!(
            role,
            "AXButton" | "AXLink" | "AXMenuItem" | "AXMenuButton" | "AXPopUpButton"
                | "AXCheckBox" | "AXRadioButton" | "AXTextField" | "AXComboBox"
                | "AXTabButton" | "AXMenuBarItem" | "AXDisclosureTriangle" | "AXSearchField"
                // Text-entry roles (search bars, address bars, editors) that let you
                // click to place the caret but don't advertise a press action.
                | "AXTextArea"
                // Browser tabs. Role varies by app and none of these reliably
                // advertise AXPress, so whitelisting is the only way they get
                // detected: Safari/Firefox use AXRadioButton (above), Chromium
                // uses AXTab, and some toolbars expose AXToolbarButton.
                | "AXTab" | "AXToolbarButton" | "AXSwitch"
                // Dock icons — the role census showed these were being hit and
                // discarded, so the Dock was unreachable by gaze.
                | "AXDockItem"
        )
    }

    /// Generic roles that carry no meaning by themselves but are how web content
    /// exposes most of its clickable UI (a Chromium button is usually a bare
    /// `AXGroup`). A role census over real pages showed ~95% of hits landing here
    /// and producing ZERO targets — the magnet was blind on web pages.
    ///
    /// These are the only roles worth paying an action-check round-trip for.
    /// Snap strength for Dock icons. The Dock is a row of large targets pinned to
    /// a screen edge, so at full strength it captures the cursor any time the gaze
    /// drifts toward the bottom of the screen. Weakened, not removed — it still
    /// magnetises once you are clearly on an icon.
    const DOCK_SNAP_STRENGTH: f64 = 0.45;

    fn is_ambiguous(role: &str) -> bool {
        // AXRow / AXCell are deliberately excluded: they are table structure, and
        // whole rows advertising AXPress made the magnet grab large strips of list
        // UI that do nothing when clicked.
        matches!(role, "AXGroup" | "AXStaticText" | "AXImage" | "AXHeading")
    }

    /// Upper bound on an ambiguous element's size, in logical points.
    ///
    /// A named role (AXButton, AXLink) means the app is telling us it is a control,
    /// whatever its size. A bare AXGroup advertising AXPress means far less — web
    /// pages wrap whole sections in pressable containers, and snapping to the
    /// centre of a page-sized div puts the cursor somewhere the user never looked
    /// and clicks something they never aimed at. Real controls are small; require
    /// that of anything whose role didn't earn it.
    const AMBIGUOUS_MAX_W: f64 = 420.0;
    const AMBIGUOUS_MAX_H: f64 = 160.0;

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

    /// Roles that represent an editable text-entry field. Covers native controls
    /// and how web content (Safari/Chrome) exposes inputs via Accessibility.
    fn is_text_role(role: &str) -> bool {
        matches!(role, "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField")
    }

    /// Whether the system-wide focused UI element is an editable text field — the
    /// trigger for auto-showing the on-screen keyboard. Cheap enough to poll a few
    /// times a second. Requires Accessibility (returns false without it).
    pub unsafe fn focused_is_text() -> bool {
        let sys = AXUIElementCreateSystemWide();
        if sys.is_null() { return false; }
        // Try the system-wide focused element directly; fall back through the
        // focused application (some apps only expose it there).
        let focused = copy_attr(sys, "AXFocusedUIElement").or_else(|| {
            let app = copy_attr(sys, "AXFocusedApplication")?;
            let f = copy_attr(app as AXUIElementRef, "AXFocusedUIElement");
            CFRelease(app);
            f
        });
        CFRelease(sys as CFTypeRef);
        let el = match focused { Some(e) => e as AXUIElementRef, None => return false };
        let is_text = ax_role(el).map(|r| is_text_role(&r)).unwrap_or(false);
        CFRelease(el as CFTypeRef);
        is_text
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
    /// An element counts as actionable if it either has a known interactive role
    /// (covers text fields / search bars, which don't expose a press action) OR
    /// advertises a press action (covers everything else — universal coverage).
    ///
    /// The 5th value is the target's SNAP STRENGTH (1.0 = full). It travels with
    /// the target so the frontend can pull more gently toward things you usually
    /// glance past rather than aim at — the Dock especially, which is a big row of
    /// fat targets along a screen edge that otherwise grabs the cursor whenever
    /// your gaze drifts down.
    unsafe fn actionable_rect(start: AXUIElementRef) -> Option<(f64, f64, f64, f64, f64)> {
        let mut cur = start;
        let mut owned: Option<AXUIElementRef> = None;
        let mut result = None;
        // Role-only detection at depth 4 — exactly what v2 did, and the only
        // version of this whose magnet worked well in practice.
        //
        // `has_press_action` is a cross-process round-trip, so it is gated hard:
        // only at depth 0, and only for AMBIGUOUS roles (`is_ambiguous`) where the
        // role name genuinely tells us nothing. Running it on every element at
        // every level cost 203–540ms per sweep against a 120ms budget and left the
        // cache permanently stale. Confined this way it fires on the generic
        // `AXGroup`s that make up web content — which role matching alone scores as
        // zero targets — while named roles (AXButton, AXLink, …) short-circuit for
        // free via the cheap role read.
        for depth in 0..4 {
            let role = ax_role(cur);
            let ambiguous = role.as_deref().map(is_ambiguous).unwrap_or(false) && depth == 0;
            let clickable = match role.as_deref() {
                Some(r) if is_clickable(r) => true,
                Some(_) if ambiguous => has_press_action(cur),
                _ => false,
            };
            if clickable {
                if let (Some(p), Some(s)) = (ax_point(cur), ax_size(cur)) {
                    // Anything that only qualified via a press action must also be
                    // control-sized — see AMBIGUOUS_MAX_*.
                    let size_ok = !ambiguous
                        || (s.width <= AMBIGUOUS_MAX_W && s.height <= AMBIGUOUS_MAX_H);
                    if s.width > 1.0 && s.height > 1.0 && size_ok {
                        let strength = match role.as_deref() {
                            Some("AXDockItem") => DOCK_SNAP_STRENGTH,
                            _ => 1.0,
                        };
                        result = Some((
                            p.x + s.width / 2.0, p.y + s.height / 2.0, s.width, s.height, strength,
                        ));
                        break;
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
        // Hit-test the app that OWNS THE WINDOW UNDER THE GAZE, not the focused
        // one — our always-on-top overlay is often focused, and the old
        // focused-app path then bailed on `same_pid` and found nothing anywhere
        // but our own HUD. Fall back to the focused app only if the window
        // lookup fails (e.g. gaze over empty desktop).
        let app = match app_at_point(gx, gy, my_pid) {
            Some(a) => a,
            None => {
                let sys = AXUIElementCreateSystemWide();
                if sys.is_null() { return None; }
                let a = copy_attr(sys, "AXFocusedApplication");
                CFRelease(sys as CFTypeRef);
                let a = match a { Some(a) => a as AXUIElementRef, None => return None };
                if same_pid(a, my_pid) { CFRelease(a as CFTypeRef); return None; }
                a
            }
        };
        enable_app_a11y(app); // make Chromium/Electron web content hit-testable

        let mut best: Option<(f64, f64, f64, f64, f64)> = None; // (dist, cx, cy, w, h)
        for (ox, oy) in probe_offsets(radius) {
            let mut el: AXUIElementRef = std::ptr::null();
            let err = AXUIElementCopyElementAtPosition(app, (gx + ox) as f32, (gy + oy) as f32, &mut el);
            if err != 0 || el.is_null() { continue; }
            if let Some((cx, cy, w, h, _)) = actionable_rect(el) {
                let d = ((cx - gx).powi(2) + (cy - gy).powi(2)).sqrt();
                if best.map_or(true, |b| d < b.0) { best = Some((d, cx, cy, w, h)); }
            }
            CFRelease(el as CFTypeRef);
        }
        CFRelease(app as CFTypeRef);
        best.map(|(_, cx, cy, w, h)| (cx, cy, w, h))
    }

    /// ALL clickable targets (from the focused app) within `radius` logical points
    /// of (gx,gy) — a dense grid hit-test, deduped by center. This is what the
    /// background scanner caches so the frontend can hit-test locally every frame
    /// (instant magnetism + boxes) instead of waiting on throttled async queries.
    /// Returns each as (center_x, center_y, w, h) in global logical points.
    /// True at most once every 3s — gates the (otherwise costly) role census below.
    fn role_census_due() -> bool {
        static LAST: std::sync::OnceLock<std::sync::Mutex<std::time::Instant>> =
            std::sync::OnceLock::new();
        let m = LAST.get_or_init(|| {
            std::sync::Mutex::new(std::time::Instant::now() - std::time::Duration::from_secs(60))
        });
        let mut t = match m.lock() { Ok(t) => t, Err(_) => return false };
        if t.elapsed() >= std::time::Duration::from_secs(3) {
            *t = std::time::Instant::now();
            true
        } else {
            false
        }
    }

    pub unsafe fn all_targets(gx: f64, gy: f64, radius: f64, my_pid: i32) -> Vec<(f64, f64, f64, f64, f64)> {
        let mut out: Vec<(f64, f64, f64, f64, f64)> = Vec::new();
        // Periodic census of what the AX tree ACTUALLY exposes under the gaze.
        // "0–4 targets found" can mean either "nothing is there" or "things are
        // there but no role matches" — those need opposite fixes, and only the raw
        // roles distinguish them. Sampled every 3s so it costs ~nothing.
        let census = role_census_due();
        let mut roles: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let mut probes = 0usize;
        let mut hits = 0usize;
        // Same fix as `nearest_target`: probe the app owning the window under the
        // gaze, not the focused app (which is frequently our own overlay).
        let app = match app_at_point(gx, gy, my_pid) {
            Some(a) => a,
            None => {
                let sys = AXUIElementCreateSystemWide();
                if sys.is_null() { return out; }
                let a = copy_attr(sys, "AXFocusedApplication");
                CFRelease(sys as CFTypeRef);
                let a = match a { Some(a) => a as AXUIElementRef, None => return out };
                if same_pid(a, my_pid) { CFRelease(a as CFTypeRef); return out; }
                a
            }
        };
        enable_app_a11y(app); // make Chromium/Electron web content hit-testable

        // Grid step, chosen against the scanner's 120ms budget. 36pt gave 11×11 =
        // 121 probes and measured 105–228ms — already over. 48pt gives 9×9 = 81
        // (a third fewer), which funds the ambiguous-role action check in
        // `actionable_rect` without regressing the budget. Still well under the
        // ~60pt minimum size of real toolbar buttons and tabs, so nothing that was
        // detectable before stops being detectable.
        let step = 48.0_f64;
        let n = ((radius / step) as i32).clamp(1, 6);
        for iy in -n..=n {
            for ix in -n..=n {
                let px = gx + ix as f64 * step;
                let py = gy + iy as f64 * step;
                let mut el: AXUIElementRef = std::ptr::null();
                probes += 1;
                let err = AXUIElementCopyElementAtPosition(app, px as f32, py as f32, &mut el);
                if err != 0 || el.is_null() { continue; }
                hits += 1;
                if census {
                    if let Some(r) = ax_role(el) { *roles.entry(r).or_insert(0) += 1; }
                }
                if let Some((cx, cy, w, h, strength)) = actionable_rect(el) {
                    // Dedup by center proximity (the grid hits the same button many
                    // times) and drop container-sized hits. Filter mainly on HEIGHT:
                    // real clickables (buttons, search bars, menu items) are short but
                    // can be WIDE — a wide Google search bar was being wrongly excluded
                    // by a symmetric 600px cap.
                    if h < 220.0 && w < 1600.0
                        && !out.iter().any(|&(ex, ey, _, _, _)| (ex - cx).abs() < 6.0 && (ey - cy).abs() < 6.0)
                    {
                        out.push((cx, cy, w, h, strength));
                    }
                }
                CFRelease(el as CFTypeRef);
                if out.len() >= 48 { CFRelease(app as CFTypeRef); return out; }
            }
        }
        CFRelease(app as CFTypeRef);
        if census {
            let mut v: Vec<(String, usize)> = roles.into_iter().collect();
            v.sort_by(|a, b| b.1.cmp(&a.1));
            let top: Vec<String> = v.iter().take(10).map(|(r, n)| format!("{r}×{n}")).collect();
            println!(
                "[gaze][roles] {probes} probes, {hits} elements, {} targets | {}",
                out.len(),
                if top.is_empty() { "(AX returned nothing)".to_string() } else { top.join(" ") },
            );
        }
        out
    }
}

/// Snap to the nearest system-wide clickable near a gaze point (normalized to
/// window content). Returns (nx, ny, w_norm, h_norm) of the target center, or
/// None. All AX complexity is isolated here; the frontend just gets a point.
#[tauri::command]
fn snap_target(window: tauri::WebviewWindow, nx: f64, ny: f64, radius: f64) -> Result<Option<(f64, f64, f64, f64)>, String> {
    #[cfg(target_os = "macos")]
    {
        // Display-relative, matching `to_global` — see `display_rect`.
        let (px, py, w, h, _) = display_rect(&window)?;
        let my_pid = std::process::id() as i32;
        let res = unsafe { mac_ax::nearest_target(px + nx * w, py + ny * h, radius * w, my_pid) };
        Ok(res.map(|(cx, cy, tw, th)| {
            (((cx - px) / w), ((cy - py) / h), tw / w, th / h)
        }))
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (window, nx, ny, radius); Ok(None) }
}

/// All nearby clickable targets, from the background scanner's cache, converted
/// to this window's normalized content coords (nx, ny, w_norm, h_norm). The
/// frontend refreshes this a few times a second and hit-tests it locally every
/// frame, so system-wide magnetism (and its highlight box) is instant.
#[tauri::command]
fn nearby_targets(
    window: tauri::WebviewWindow,
    state: tauri::State<TargetCache>,
    center: tauri::State<ScanCenter>,
    nx: f64,
    ny: f64,
) -> Result<Vec<(f64, f64, f64, f64, f64)>, String> {
    #[cfg(target_os = "macos")]
    {
        // Display-relative, matching `to_global` — see `display_rect`.
        let (px, py, w, h, _) = display_rect(&window)?;
        // Publish the RAW gaze as the next scan center (see `ScanCenter`). Done
        // here rather than on a dedicated command so it costs no extra IPC.
        if nx.is_finite() && ny.is_finite() {
            if let Ok(mut c) = center.0.lock() { *c = Some((px + nx * w, py + ny * h)); }
        }
        let list = state.0.lock().map_err(|_| "target cache poisoned".to_string())?.clone();
        Ok(list.into_iter().map(|(cx, cy, tw, th, strength)| {
            (((cx - px) / w), ((cy - py) / h), tw / w, th / h, strength)
        }).collect())
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (window, state, center, nx, ny); Ok(vec![]) }
}

/// Continuously scan around the cursor (which tracks the gaze while armed) for
/// nearby clickables and keep the shared cache fresh, off the render thread.
#[cfg(target_os = "macos")]
fn spawn_target_scanner(
    cache: std::sync::Arc<std::sync::Mutex<Vec<(f64, f64, f64, f64, f64)>>>,
    center: std::sync::Arc<std::sync::Mutex<Option<(f64, f64)>>>,
) {
    let my_pid = std::process::id() as i32;
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(120));
        // Scan around the raw gaze. Falling back to the cursor only when the
        // frontend hasn't published a gaze yet (pre-tracking) keeps the old
        // behavior for the one case where it can't feed back on itself.
        let at = center.lock().ok().and_then(|c| *c).or_else(mac_input::cursor_location);
        if let Some((gx, gy)) = at {
            let t0 = std::time::Instant::now();
            let targets = unsafe { mac_ax::all_targets(gx, gy, 200.0, my_pid) };
            let ms = t0.elapsed().as_millis();
            // The scanner budget is the 120ms sleep above. A scan that overruns it
            // means the magnet is running on a stale cache — the exact failure mode
            // the per-ancestor action check caused. Log only overruns, not spam.
            if ms > 100 {
                println!("[gaze][scan] SLOW {ms}ms for {} targets — magnet will lag", targets.len());
            }
            if let Ok(mut c) = cache.lock() { *c = targets; }
        }
    });
}

/// Map a gaze point normalized to the window's content (0–1) to a global screen
/// point in logical points (top-left origin) — the space CoreGraphics uses.
/// Computed from the real window geometry so the OS cursor lands exactly under
/// the in-app indicator (JS `window.screenX/innerWidth` was unreliable in the
/// WKWebView and left the cursor offset).
/// The full bounds of the display the window is on, in GLOBAL LOGICAL POINTS,
/// as `(x, y, w, h, scale)`.
///
/// Every gaze↔screen mapping goes through this rather than the window rect. A
/// `maximized` window deliberately excludes the menu bar and the Dock, so mapping
/// normalized [0,1] onto the WINDOW made those regions unreachable: the reticle
/// stopped short of the screen edges and the cursor could never be warped onto a
/// menu or a Dock icon at all. Mapping onto the display makes 0 and 1 mean the
/// true screen edges, so gaze can reach corner to corner.
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

#[cfg(target_os = "macos")]
fn to_global(window: &tauri::WebviewWindow, nx: f64, ny: f64) -> Result<(f64, f64), String> {
    let (px, py, w, h, _) = display_rect(window)?;
    Ok((px + nx * w, py + ny * h))
}

// macOS built-in Zoom keyboard shortcuts (Command+Option chords). The magnifier
// follows the system pointer, which the app drives to the gaze reticle — so this
// gives a live, GPU-accelerated magnifier around where you're looking. Requires
// "Use keyboard shortcuts to zoom" enabled in System Settings › Accessibility › Zoom.
#[cfg(target_os = "macos")]
const CMD_ALT: u64 = 0x0010_0000 | 0x0008_0000; // Command | Alternate(Option)

/// Toggle the macOS Zoom magnifier on/off (⌥⌘8).
#[tauri::command]
fn zoom_toggle() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { mac_input::key_combo(CMD_ALT, 28) } // 28 = key "8"
    #[cfg(not(target_os = "macos"))]
    { Err("macOS Zoom is macOS-only".into()) }
}

/// Zoom in one step (⌥⌘=).
#[tauri::command]
fn zoom_in() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { mac_input::key_combo(CMD_ALT, 24) } // 24 = key "="
    #[cfg(not(target_os = "macos"))]
    { Err("macOS Zoom is macOS-only".into()) }
}

/// Zoom out one step (⌥⌘-).
#[tauri::command]
fn zoom_out() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { mac_input::key_combo(CMD_ALT, 27) } // 27 = key "-"
    #[cfg(not(target_os = "macos"))]
    { Err("macOS Zoom is macOS-only".into()) }
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
/// Physical characteristics of the display the app is on, so the UI can size
/// itself to the actual device instead of assuming one screen.
///
/// `(width_pt, height_pt, scale, monitor_count, is_external)`. A 13" laptop panel
/// and a 27" external differ enormously in both point size and viewing distance,
/// and UI sized for one is wrong on the other.
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

/// Print a diagnostic line from the UI to the app's stdout.
///
/// The webview console isn't reachable in a release build, and the calibration
/// problems we're chasing happen while the user's eyes must stay on a moving dot
/// — so an on-screen readout can't be read either. stdout is the only channel
/// that can be captured and inspected afterwards.
#[tauri::command]
fn dev_log(line: String) {
    println!("[gaze][ui] {line}");
}

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

/// Watch the system-wide focused element from a dedicated thread and emit
/// `gaze:text-focus` (bool) whenever it changes between an editable text field
/// and not — the signal the frontend uses to auto-show/hide the keyboard.
#[cfg(target_os = "macos")]
fn spawn_text_focus_watcher(app: tauri::AppHandle) {
    use tauri::Emitter;
    std::thread::spawn(move || {
        let mut last = false;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(300));
            let now = unsafe { mac_ax::focused_is_text() };
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

    tauri::Builder::default()
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
            app.global_shortcut().register(arm_toggle)?;
            app.global_shortcut().register(pause_toggle)?;
            app.global_shortcut().register(reanchor)?;
            // Surface the real Accessibility prompt on launch if we're not yet
            // trusted, so the app gets registered/granted properly.
            #[cfg(target_os = "macos")]
            { let _ = prompt_accessibility(); }
            // Log the ACTUAL Accessibility state so we can see, not guess, whether
            // this binary is trusted (dev rebuilds get a new signature, so a prior
            // grant may not apply). Look for this line at startup.
            #[cfg(target_os = "macos")]
            unsafe {
                let ax = AXIsProcessTrusted();
                println!("[gaze][perms] Accessibility(magnet/clicks/zoom)={ax}");
                if !ax { println!("[gaze][perms] -> OFF: enable this binary in System Settings › Privacy & Security › Accessibility, then relaunch."); }
            }
            // Cover the ENTIRE display, menu bar and Dock included. `maximized`
            // leaves those strips outside the window, and since the gaze reticle is
            // drawn in the DOM it then physically cannot be shown over them — the
            // cursor could be warped there (mapping is display-relative) but the
            // reticle would stop short, so the two disagreed at the screen edges.
            // An explicit frame is used rather than maximize/zoom, which animate.
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(Some(mon)) = win.current_monitor() {
                    let p = *mon.position();
                    let s = *mon.size();
                    let _ = win.set_position(tauri::PhysicalPosition::new(p.x, p.y));
                    let _ = win.set_size(tauri::PhysicalSize::new(s.width, s.height));
                }
            }

            // Auto-show the on-screen keyboard when a text field takes focus.
            #[cfg(target_os = "macos")]
            spawn_text_focus_watcher(app.handle().clone());
            // Keep the nearby-clickable cache warm for instant magnetism.
            #[cfg(target_os = "macos")]
            spawn_target_scanner(target_cache.clone(), scan_center.clone());
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
            dev_log,
            screen_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
