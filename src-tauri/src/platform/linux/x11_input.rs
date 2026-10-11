// X11 input injection via the XTest extension. Used on real X11 sessions. On a
// Wayland session the app's windows run under XWayland, but XTest there only
// reaches XWayland clients — so Wayland sessions use `portal_input` instead.

use super::super::Key;
use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::ConnectionExt as _;
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;

const KEY_PRESS: u8 = 2;
const KEY_RELEASE: u8 = 3;
const BUTTON_PRESS: u8 = 4;
const BUTTON_RELEASE: u8 = 5;

struct Conn {
    c: RustConnection,
    root: u32,
    min_kc: u8,
    max_kc: u8,
}

fn conn() -> Result<&'static Mutex<Conn>, String> {
    static C: OnceLock<Result<Mutex<Conn>, String>> = OnceLock::new();
    C.get_or_init(|| {
        let (c, screen) = RustConnection::connect(None).map_err(|e| format!("X11 connect: {e}"))?;
        let setup = c.setup();
        let root = setup.roots[screen].root;
        let (min_kc, max_kc) = (setup.min_keycode, setup.max_keycode);
        c.xtest_get_version(2, 2)
            .map_err(|e| format!("XTest: {e}"))?
            .reply()
            .map_err(|e| format!("XTest unavailable: {e}"))?;
        Ok(Mutex::new(Conn { c, root, min_kc, max_kc }))
    })
    .as_ref()
    .map_err(|e| e.clone())
}

fn with<T>(f: impl FnOnce(&Conn) -> Result<T, String>) -> Result<T, String> {
    let g = conn()?.lock().map_err(|_| "x11 lock poisoned".to_string())?;
    f(&g)
}

/// True when an X server accepted us and XTest is present.
pub fn available() -> bool {
    conn().is_ok()
}

/// Block until the server has processed everything sent so far (a cheap request
/// with a reply acts as a barrier).
fn roundtrip(c: &Conn) -> Result<(), String> {
    c.c.get_input_focus().map_err(|e| format!("sync: {e}"))?.reply().map_err(|e| format!("sync: {e}"))?;
    Ok(())
}

fn flush(c: &Conn) -> Result<(), String> {
    c.c.flush().map_err(|e| format!("x11 flush: {e}"))
}

fn fake(c: &Conn, kind: u8, detail: u8, x: i16, y: i16) -> Result<(), String> {
    c.c.xtest_fake_input(kind, detail, 0, c.root, x, y, 0)
        .map_err(|e| format!("xtest: {e}"))?;
    Ok(())
}

/// Monitor scale (physical px per logical point). Callers pass LOGICAL points
/// (the same contract as macOS); XTest wants physical root pixels.
static SCALE_BITS: AtomicU64 = AtomicU64::new(0x3FF0_0000_0000_0000); // 1.0

pub fn set_scale(scale: f64) {
    if scale.is_finite() && scale > 0.0 { SCALE_BITS.store(scale.to_bits(), Ordering::Relaxed); }
}

fn scale() -> f64 { f64::from_bits(SCALE_BITS.load(Ordering::Relaxed)) }

pub fn warp(x: f64, y: f64) -> Result<(), String> {
    with(|c| {
        // MotionNotify (6) with root-relative absolute coordinates.
        let k = scale();
        fake(c, 6, 0, (x * k).round() as i16, (y * k).round() as i16)?;
        flush(c)
    })
}

fn button(c: &Conn, n: u8) -> Result<(), String> {
    fake(c, BUTTON_PRESS, n, 0, 0)?;
    flush(c)?;
    std::thread::sleep(std::time::Duration::from_millis(12));
    fake(c, BUTTON_RELEASE, n, 0, 0)?;
    flush(c)
}

pub fn click(x: f64, y: f64) -> Result<(), String> {
    warp(x, y)?;
    with(|c| button(c, 1))
}

pub fn right_click(x: f64, y: f64) -> Result<(), String> {
    warp(x, y)?;
    with(|c| button(c, 3))
}

pub fn double_click(x: f64, y: f64) -> Result<(), String> {
    warp(x, y)?;
    with(|c| {
        for _ in 0..2 {
            fake(c, BUTTON_PRESS, 1, 0, 0)?;
            fake(c, BUTTON_RELEASE, 1, 0, 0)?;
        }
        flush(c)
    })
}

/// Pixels of requested scroll per wheel notch.
const PX_PER_NOTCH: i32 = 40;

/// Sub-notch remainder carried between calls. Edge-gaze scrolling calls this every
/// ~40ms with ~34px; rounding each call up to a full notch scrolled far too fast.
static SCROLL_ACC: AtomicI32 = AtomicI32::new(0);

/// Wheel buttons: 4 = up, 5 = down. Positive `dy` scrolls up (matches CGEvent).
pub fn scroll(dy: i32) -> Result<(), String> {
    let mut acc = SCROLL_ACC.load(Ordering::Relaxed);
    // A direction change discards stale remainder instead of cancelling real input.
    if acc != 0 && (acc > 0) != (dy > 0) { acc = 0; }
    acc += dy;
    let notches = acc / PX_PER_NOTCH;
    SCROLL_ACC.store(acc - notches * PX_PER_NOTCH, Ordering::Relaxed);
    if notches == 0 { return Ok(()); }
    let b = if notches > 0 { 4 } else { 5 };
    with(|c| {
        for _ in 0..notches.abs().min(20) {
            fake(c, BUTTON_PRESS, b, 0, 0)?;
            fake(c, BUTTON_RELEASE, b, 0, 0)?;
        }
        flush(c)
    })
}

/// Keycode whose UNSHIFTED keysym is `keysym`, if any. Matching only column 0 is
/// deliberate: a shifted-column match (`A` on the `a` key) would be tapped without
/// Shift and type the wrong character; those fall through to the remap path.
fn keycode_for(c: &Conn, keysym: u32) -> Result<Option<u8>, String> {
    let count = c.max_kc - c.min_kc + 1;
    let m = c.c.get_keyboard_mapping(c.min_kc, count)
        .map_err(|e| format!("keymap: {e}"))?
        .reply()
        .map_err(|e| format!("keymap: {e}"))?;
    let per = m.keysyms_per_keycode as usize;
    for (i, chunk) in m.keysyms.chunks(per).enumerate() {
        if chunk.first() == Some(&keysym) {
            return Ok(Some(c.min_kc + i as u8));
        }
    }
    Ok(None)
}

fn tap_keycode(c: &Conn, kc: u8) -> Result<(), String> {
    fake(c, KEY_PRESS, kc, 0, 0)?;
    fake(c, KEY_RELEASE, kc, 0, 0)?;
    flush(c)
}

pub fn key_tap(key: Key) -> Result<(), String> {
    let sym = match key { Key::Backspace => 0xff08, Key::Return => 0xff0d, Key::Space => 0x20 };
    with(|c| match keycode_for(c, sym)? {
        Some(kc) => tap_keycode(c, kc),
        None => Err(format!("no keycode for keysym {sym:#x}")),
    })
}

/// Keysym for a Unicode scalar (Latin-1 maps to itself; the rest use the
/// 0x01000000 Unicode keysym range).
fn keysym_for(ch: char) -> u32 {
    let cp = ch as u32;
    if (0x20..=0x7e).contains(&cp) || (0xa0..=0xff).contains(&cp) { cp } else { 0x0100_0000 | cp }
}

/// Type text by temporarily binding each character's keysym to a spare keycode
/// (the same trick xdotool uses) — works for any Unicode, independent of layout.
pub fn type_text(text: &str) -> Result<(), String> {
    with(|c| {
        let spare = c.max_kc; // highest keycode is almost never bound
        for ch in text.chars() {
            let sym = keysym_for(ch);
            let kc = match keycode_for(c, sym)? {
                Some(kc) => { tap_keycode(c, kc)?; continue; }
                None => spare,
            };
            c.c.change_keyboard_mapping(1, kc, 1, &[sym])
                .map_err(|e| format!("remap: {e}"))?;
            roundtrip(c)?;
            tap_keycode(c, kc)?;
            roundtrip(c)?;
            // Let slow clients resolve the key before the mapping reverts.
            std::thread::sleep(std::time::Duration::from_millis(8));
            // Release the temporary binding.
            c.c.change_keyboard_mapping(1, kc, 1, &[0]).map_err(|e| format!("unmap: {e}"))?;
            roundtrip(c)?;
        }
        Ok(())
    })
}

/// Current pointer position in root coordinates.
pub fn cursor_location() -> Option<(f64, f64)> {
    with(|c| {
        let p = c.c.query_pointer(c.root).map_err(|e| e.to_string())?.reply().map_err(|e| e.to_string())?;
        let k = scale();
        Ok((p.root_x as f64 / k, p.root_y as f64 / k))
    })
    .ok()
}
