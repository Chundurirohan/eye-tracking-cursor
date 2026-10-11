// Wayland input injection: RemoteDesktop portal → EIS (libei) socket.
//
// One dedicated thread owns a current-thread tokio runtime and the whole portal
// session. The rest of the app talks to it through a channel (`send`), so the
// command handlers stay synchronous and never block on D-Bus.
//
// Lifecycle: `request_access()` starts the session (the compositor shows its
// consent dialog once; the restore token is saved so later launches are silent).
// `is_ready()` turns true when the compositor has handed us a resumed pointer.

use super::super::Key;
use ashpd::desktop::{
    remote_desktop::{ConnectToEISOptions, DeviceType, RemoteDesktop, SelectDevicesOptions, StartOptions},
    CreateSessionOptions, PersistMode,
};
use futures_util::StreamExt;
use reis::{
    ei,
    event::{Device, DeviceCapability, EiEvent},
};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

const IDLE: u8 = 0;
const CONNECTING: u8 = 1;
const READY: u8 = 2;
const FAILED: u8 = 3;

static STATE: AtomicU8 = AtomicU8::new(IDLE);
static LAST_ERROR: Mutex<String> = Mutex::new(String::new());
/// Where we last put the cursor. Wayland offers no global pointer query, but since
/// we are the only thing driving the cursor this is the "actual cursor" position.
static LAST_POS: Mutex<Option<(f64, f64)>> = Mutex::new(None);
static TOKEN_PATH: OnceLock<PathBuf> = OnceLock::new();

const BTN_LEFT: u32 = 0x110;
const BTN_RIGHT: u32 = 0x111;
const KEY_LEFTSHIFT: u32 = 42;

enum Cmd {
    Move(f64, f64),
    Button(u32, bool),
    Scroll(f32),
    Key(u32, bool),
}

pub fn set_token_path(p: PathBuf) {
    let _ = TOKEN_PATH.set(p);
}

pub fn has_saved_token() -> bool {
    TOKEN_PATH.get().map_or(false, |p| p.exists())
}

pub fn is_ready() -> bool {
    STATE.load(Ordering::Relaxed) == READY
}

pub fn last_error() -> String {
    LAST_ERROR.lock().map(|e| e.clone()).unwrap_or_default()
}

pub fn cursor_location() -> Option<(f64, f64)> {
    LAST_POS.lock().ok().and_then(|p| *p)
}

/// Start (or retry) the portal session. Returns immediately; poll `is_ready`.
pub fn request_access() {
    let cur = STATE.load(Ordering::Relaxed);
    if cur == CONNECTING || cur == READY {
        return;
    }
    STATE.store(CONNECTING, Ordering::Relaxed);
    let (tx, rx) = unbounded_channel();
    SENDER.lock().map(|mut s| *s = Some(tx)).ok();
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(rt) => rt,
            Err(e) => return fail(format!("tokio runtime: {e}")),
        };
        if let Err(e) = rt.block_on(session(rx)) {
            fail(e);
        }
    });
}

static SENDER: Mutex<Option<UnboundedSender<Cmd>>> = Mutex::new(None);

fn fail(msg: String) {
    println!("[gaze][portal] {msg}");
    if let Ok(mut e) = LAST_ERROR.lock() {
        *e = msg;
    }
    STATE.store(FAILED, Ordering::Relaxed);
}

fn send(c: Cmd) -> Result<(), String> {
    if !is_ready() {
        return Err(if STATE.load(Ordering::Relaxed) == FAILED {
            format!("Wayland input unavailable: {}", last_error())
        } else {
            "Wayland input not authorised yet — approve the screen-control prompt".into()
        });
    }
    SENDER
        .lock()
        .map_err(|_| "portal lock poisoned".to_string())?
        .as_ref()
        .ok_or_else(|| "portal session not running".to_string())?
        .send(c)
        .map_err(|_| "portal session closed".to_string())
}

fn now_us() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0)
}

struct Dev {
    dev: Device,
    resumed: bool,
}

async fn session(mut rx: tokio::sync::mpsc::UnboundedReceiver<Cmd>) -> Result<(), String> {
    let e = |what: &'static str| move |err: ashpd::Error| format!("{what}: {err}");
    let rd = RemoteDesktop::new().await.map_err(e("RemoteDesktop portal"))?;
    let session = rd.create_session(CreateSessionOptions::default()).await.map_err(e("create_session"))?;
    let token = TOKEN_PATH.get().and_then(|p| std::fs::read_to_string(p).ok());
    rd.select_devices(
        &session,
        SelectDevicesOptions::default()
            .set_devices(DeviceType::Keyboard | DeviceType::Pointer)
            .set_persist_mode(PersistMode::ExplicitlyRevoked)
            .set_restore_token(token.as_deref().map(str::trim)),
    )
    .await
    .map_err(e("select_devices"))?;
    let started = rd
        .start(&session, None, StartOptions::default())
        .await
        .map_err(e("start"))?
        .response()
        .map_err(|_| "screen-control permission was declined".to_string())?;
    if let (Some(t), Some(path)) = (started.restore_token(), TOKEN_PATH.get()) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, t);
    }
    let fd = rd.connect_to_eis(&session, ConnectToEISOptions::default()).await.map_err(e("connect_to_eis"))?;
    let ctx = ei::Context::new(UnixStream::from(fd)).map_err(|e| format!("ei context: {e}"))?;
    let (conn, mut events) = ctx
        .handshake_tokio("gaze", ei::handshake::ContextType::Sender)
        .await
        .map_err(|e| format!("ei handshake: {e}"))?;

    let mut devs: Vec<Dev> = Vec::new();
    let mut seq: u32 = 0;
    loop {
        tokio::select! {
            ev = events.next() => {
                let ev = match ev {
                    Some(Ok(ev)) => ev,
                    Some(Err(err)) => return Err(format!("ei stream: {err}")),
                    None => return Err("compositor closed the input connection".into()),
                };
                match ev {
                    EiEvent::SeatAdded(s) => {
                        s.seat.bind_capabilities(
                            DeviceCapability::PointerAbsolute | DeviceCapability::Pointer
                                | DeviceCapability::Button | DeviceCapability::Scroll
                                | DeviceCapability::Keyboard,
                        );
                    }
                    EiEvent::DeviceAdded(d) => devs.push(Dev { dev: d.device, resumed: false }),
                    EiEvent::DeviceRemoved(d) => devs.retain(|x| x.dev.device() != d.device.device()),
                    EiEvent::DevicePaused(d) => {
                        for x in devs.iter_mut().filter(|x| x.dev.device() == d.device.device()) { x.resumed = false; }
                    }
                    EiEvent::DeviceResumed(d) => {
                        seq = seq.wrapping_add(1);
                        d.device.device().start_emulating(d.serial, seq);
                        for x in devs.iter_mut().filter(|x| x.dev.device() == d.device.device()) { x.resumed = true; }
                        if devs.iter().any(|x| x.resumed && x.dev.interface::<ei::PointerAbsolute>().is_some()) {
                            STATE.store(READY, Ordering::Relaxed);
                            println!("[gaze][portal] ready (absolute pointer)");
                        }
                    }
                    EiEvent::Disconnected(_) => return Err("compositor disconnected the input session".into()),
                    _ => {}
                }
                let _ = conn.flush();
            }
            cmd = rx.recv() => {
                let Some(cmd) = cmd else { return Ok(()) };
                let serial = conn.serial();
                let t = now_us();
                match cmd {
                    Cmd::Move(x, y) => {
                        if let Some(d) = devs.iter().find(|d| d.resumed && d.dev.interface::<ei::PointerAbsolute>().is_some()) {
                            // Clamp into the union of the device's regions so an edge gaze can't miss the screen.
                            let (mut x, mut y) = (x, y);
                            let r = d.dev.regions();
                            if !r.is_empty() {
                                let minx = r.iter().map(|r| r.x as f64).fold(f64::MAX, f64::min);
                                let miny = r.iter().map(|r| r.y as f64).fold(f64::MAX, f64::min);
                                let maxx = r.iter().map(|r| (r.x + r.width) as f64).fold(0.0, f64::max);
                                let maxy = r.iter().map(|r| (r.y + r.height) as f64).fold(0.0, f64::max);
                                x = x.clamp(minx, maxx - 1.0);
                                y = y.clamp(miny, maxy - 1.0);
                            }
                            d.dev.interface::<ei::PointerAbsolute>().unwrap().motion_absolute(x as f32, y as f32);
                            d.dev.device().frame(serial, t);
                            if let Ok(mut p) = LAST_POS.lock() { *p = Some((x, y)); }
                        }
                    }
                    Cmd::Button(code, down) => {
                        if let Some(d) = devs.iter().find(|d| d.resumed && d.dev.interface::<ei::Button>().is_some()) {
                            let st = if down { ei::button::ButtonState::Press } else { ei::button::ButtonState::Released };
                            d.dev.interface::<ei::Button>().unwrap().button(code, st);
                            d.dev.device().frame(serial, t);
                        }
                    }
                    Cmd::Scroll(dy) => {
                        if let Some(d) = devs.iter().find(|d| d.resumed && d.dev.interface::<ei::Scroll>().is_some()) {
                            d.dev.interface::<ei::Scroll>().unwrap().scroll(0.0, dy);
                            d.dev.device().frame(serial, t);
                        }
                    }
                    Cmd::Key(code, down) => {
                        if let Some(d) = devs.iter().find(|d| d.resumed && d.dev.interface::<ei::Keyboard>().is_some()) {
                            let st = if down { ei::keyboard::KeyState::Press } else { ei::keyboard::KeyState::Released };
                            d.dev.interface::<ei::Keyboard>().unwrap().key(code, st);
                            d.dev.device().frame(serial, t);
                        }
                    }
                }
                let _ = conn.flush();
            }
        }
    }
}

// ---- public API mirrored by `linux/mod.rs` ------------------------------------

pub fn warp(x: f64, y: f64) -> Result<(), String> {
    send(Cmd::Move(x, y))
}

fn press(code: u32) -> Result<(), String> {
    send(Cmd::Button(code, true))?;
    std::thread::sleep(std::time::Duration::from_millis(12));
    send(Cmd::Button(code, false))
}

pub fn click(x: f64, y: f64) -> Result<(), String> {
    warp(x, y)?;
    // Let the compositor land the pointer before the button, or the click goes to the old spot.
    std::thread::sleep(std::time::Duration::from_millis(8));
    press(BTN_LEFT)
}

pub fn right_click(x: f64, y: f64) -> Result<(), String> {
    warp(x, y)?;
    std::thread::sleep(std::time::Duration::from_millis(8));
    press(BTN_RIGHT)
}

pub fn double_click(x: f64, y: f64) -> Result<(), String> {
    click(x, y)?;
    std::thread::sleep(std::time::Duration::from_millis(40));
    press(BTN_LEFT)
}

/// Positive `dy` scrolls up (matches the other backends); EI's y grows downward.
pub fn scroll(dy: i32) -> Result<(), String> {
    send(Cmd::Scroll(-(dy as f32)))
}

fn tap(code: u32, shift: bool) -> Result<(), String> {
    if shift {
        send(Cmd::Key(KEY_LEFTSHIFT, true))?;
    }
    send(Cmd::Key(code, true))?;
    send(Cmd::Key(code, false))?;
    if shift {
        send(Cmd::Key(KEY_LEFTSHIFT, false))?;
    }
    Ok(())
}

pub fn key_tap(key: Key) -> Result<(), String> {
    tap(
        match key {
            Key::Backspace => 14,
            Key::Return => 28,
            Key::Space => 57,
        },
        false,
    )
}

/// (evdev code, needs shift) for a US-layout character.
fn evdev_for(ch: char) -> Option<(u32, bool)> {
    const ROW_Q: [u32; 10] = [16, 17, 18, 19, 20, 21, 22, 23, 24, 25];
    const ROW_A: [u32; 9] = [30, 31, 32, 33, 34, 35, 36, 37, 38];
    const ROW_Z: [u32; 7] = [44, 45, 46, 47, 48, 49, 50];
    const Q: &str = "qwertyuiop";
    const A: &str = "asdfghjkl";
    const Z: &str = "zxcvbnm";
    let lower = ch.to_ascii_lowercase();
    let shift = ch.is_ascii_uppercase();
    if let Some(i) = Q.find(lower) { return Some((ROW_Q[i], shift)); }
    if let Some(i) = A.find(lower) { return Some((ROW_A[i], shift)); }
    if let Some(i) = Z.find(lower) { return Some((ROW_Z[i], shift)); }
    Some(match ch {
        '1'..='9' => (2 + (ch as u32 - '1' as u32), false),
        '0' => (11, false),
        '!' => (2, true), '@' => (3, true), '#' => (4, true), '$' => (5, true), '%' => (6, true),
        '^' => (7, true), '&' => (8, true), '*' => (9, true), '(' => (10, true), ')' => (11, true),
        '-' => (12, false), '_' => (12, true), '=' => (13, false), '+' => (13, true),
        '[' => (26, false), '{' => (26, true), ']' => (27, false), '}' => (27, true),
        ';' => (39, false), ':' => (39, true), '\'' => (40, false), '"' => (40, true),
        '`' => (41, false), '~' => (41, true), '\\' => (43, false), '|' => (43, true),
        ',' => (51, false), '<' => (51, true), '.' => (52, false), '>' => (52, true),
        '/' => (53, false), '?' => (53, true),
        ' ' => (57, false), '\n' => (28, false), '\t' => (15, false),
        _ => return None,
    })
}

/// Types via evdev keycodes, so it assumes a US-QWERTY compositor layout. Characters
/// with no key (accents, emoji) are skipped rather than mistyped.
pub fn type_text(text: &str) -> Result<(), String> {
    for ch in text.chars() {
        if let Some((code, shift)) = evdev_for(ch) {
            tap(code, shift)?;
            std::thread::sleep(std::time::Duration::from_millis(4));
        }
    }
    Ok(())
}
