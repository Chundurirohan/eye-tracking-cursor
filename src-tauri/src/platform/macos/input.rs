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
