// WebKitGTK configuration. Out of the box the webview has getUserMedia disabled
// and denies media permission requests, so the camera never starts. We enable
// media streams and auto-grant VIDEO ONLY (never audio, geolocation, etc.).

use tauri::Manager;
use webkit2gtk::glib::object::Cast;
use webkit2gtk::{PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, UserMediaPermissionRequestExt, WebViewExt};

pub fn configure(app: &tauri::AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    let res = win.with_webview(|wv| {
        let view = wv.inner();
        if let Some(settings) = WebViewExt::settings(&view) {
            settings.set_enable_media_stream(true);
            settings.set_enable_mediasource(true);
            settings.set_enable_webgl(true);
            settings.set_media_playback_requires_user_gesture(false);
        }
        view.connect_permission_request(|_, req| {
            if let Some(media) = req.downcast_ref::<UserMediaPermissionRequest>() {
                if media.is_for_video_device() && !media.is_for_audio_device() {
                    req.allow();
                } else {
                    req.deny();
                }
            } else {
                req.deny();
            }
            true
        });
    });
    if let Err(e) = res {
        println!("[gaze][webview] configure failed: {e}");
    }
}
