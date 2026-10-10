// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Linux: pick the windowing backend BEFORE GTK initializes.
///
/// Wayland compositors don't let clients stay always-on-top, position themselves
/// or (reliably) go click-through, all of which the gaze overlay needs. So on a
/// Wayland session the windows run under XWayland (`GDK_BACKEND=x11`), while the
/// REAL session type is recorded in `GAZE_REAL_SESSION` so input injection can
/// still use the Wayland-native RemoteDesktop portal. `GAZE_NATIVE_WAYLAND=1`
/// opts out of the XWayland override.
#[cfg(target_os = "linux")]
fn linux_env() {
    let real = if std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE").map_or(false, |v| v == "wayland")
    {
        "wayland"
    } else if std::env::var_os("DISPLAY").is_some() {
        "x11"
    } else {
        "none"
    };
    if std::env::var_os("GAZE_REAL_SESSION").is_none() {
        std::env::set_var("GAZE_REAL_SESSION", real);
    }
    if real == "wayland"
        && std::env::var_os("GDK_BACKEND").is_none()
        && std::env::var_os("GAZE_NATIVE_WAYLAND").is_none()
        && std::env::var_os("DISPLAY").is_some()
    {
        std::env::set_var("GDK_BACKEND", "x11");
    }
    // WebKitGTK's DMABUF renderer renders a blank window on some Nvidia setups.
    if std::path::Path::new("/proc/driver/nvidia").exists()
        && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    linux_env();
    gaze_lib::run()
}
