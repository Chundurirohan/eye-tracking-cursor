// Screen magnifier control. There is no cross-desktop API, so this drives the
// desktop's own magnifier: GNOME via its a11y GSettings, KDE via KWin's zoom
// effect shortcuts over D-Bus. Anything else reports "unsupported" and the UI
// hides the control (`Capabilities::zoom`).

use gio::prelude::*;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Desktop {
    Gnome,
    Kde,
    Other,
}

fn desktop() -> Desktop {
    let d = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default().to_uppercase();
    if d.split(':').any(|p| p == "KDE") { Desktop::Kde }
    else if d.split(':').any(|p| p == "GNOME" || p == "UNITY" || p == "X-CINNAMON") && gnome_schema_present() { Desktop::Gnome }
    else { Desktop::Other }
}

const APPS: &str = "org.gnome.desktop.a11y.applications";
const MAG: &str = "org.gnome.desktop.a11y.magnifier";

fn schema_present(id: &str) -> bool {
    gio::SettingsSchemaSource::default().and_then(|s| s.lookup(id, true)).is_some()
}

fn gnome_schema_present() -> bool { schema_present(APPS) && schema_present(MAG) }

pub fn supported() -> bool { desktop() != Desktop::Other }

const STEP: f64 = 0.5;

fn gnome(op: Op) -> Result<(), String> {
    let apps = gio::Settings::new(APPS);
    let mag = gio::Settings::new(MAG);
    let on = apps.boolean("screen-magnifier-enabled");
    let set = |s: &gio::Settings, k: &str, v: f64| s.set_double(k, v).map_err(|e| format!("{k}: {e}"));
    match op {
        Op::Toggle => apps.set_boolean("screen-magnifier-enabled", !on).map_err(|e| e.to_string())?,
        Op::In => {
            if !on { apps.set_boolean("screen-magnifier-enabled", true).map_err(|e| e.to_string())?; }
            set(&mag, "mag-factor", (mag.double("mag-factor") + STEP).min(32.0))?;
        }
        Op::Out => {
            let f = (mag.double("mag-factor") - STEP).max(1.0);
            set(&mag, "mag-factor", f)?;
        }
    }
    gio::Settings::sync(); // flush to dconf now; the magnifier reacts to the change
    Ok(())
}

/// KWin runs its zoom effect through global shortcuts, which are invokable by name.
fn kde_invoke(name: &str) -> Result<(), String> {
    let conn = zbus::blocking::Connection::session().map_err(|e| format!("session bus: {e}"))?;
    conn.call_method(
        Some("org.kde.kglobalaccel"),
        "/component/kwin",
        Some("org.kde.kglobalaccel.Component"),
        "invokeShortcut",
        &(name,),
    )
    .map_err(|e| format!("kwin {name}: {e}"))?;
    Ok(())
}

fn kde(op: Op) -> Result<(), String> {
    // KWin has no "is zoomed" query, so remember what we last did.
    static ZOOMED: AtomicBool = AtomicBool::new(false);
    match op {
        Op::Toggle => {
            let was = ZOOMED.fetch_xor(true, Ordering::Relaxed);
            kde_invoke(if was { "view_actual_size" } else { "view_zoom_in" })
        }
        Op::In => { ZOOMED.store(true, Ordering::Relaxed); kde_invoke("view_zoom_in") }
        Op::Out => kde_invoke("view_zoom_out"),
    }
}

#[derive(Clone, Copy)]
pub enum Op { Toggle, In, Out }

pub fn run(op: Op) -> Result<(), String> {
    match desktop() {
        Desktop::Gnome => gnome(op),
        Desktop::Kde => kde(op),
        Desktop::Other => Err("screen magnifier not supported on this desktop".into()),
    }
}
