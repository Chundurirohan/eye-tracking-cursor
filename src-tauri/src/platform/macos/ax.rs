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

        // Two-tier probe grid — the outer tier from this branch, the fine inner
        // tier merged in from tracker/main.
        //
        // A COARSE outer grid covers the whole magnet radius for normal buttons and
        // search bars. A FINE inner grid sweeps the small region right around the
        // gaze so TINY controls — the close-tab ×, small toolbar icons — are landed
        // on at all: a 44pt step steps clean over a 16pt button, which is exactly
        // why the × was never detected.
        //
        // Probe count IS the scan cost (each probe is a cross-process AX call), and
        // 81 probes already measured 105–228ms against a 120ms budget. So both
        // tiers are sized for that budget rather than for coverage alone: ~49 inner
        // + ~81 outer. `[gaze][scan] SLOW` reports overruns so this stays tunable
        // from measurements instead of guesswork.
        let passes: [(f64, f64); 2] = [(40.0, 13.0), (radius, 44.0)];
        for (reach, step) in passes {
            let n = ((reach / step) as i32).clamp(1, 8);
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
                        // Dedup by center proximity (the grid hits the same button
                        // many times) and drop container-sized hits. Filter mainly on
                        // HEIGHT: real clickables are short but can be WIDE — a wide
                        // search bar was wrongly excluded by a symmetric cap.
                        if h < 220.0 && w < 1600.0
                            && !out.iter().any(|&(ex, ey, _, _, _)| (ex - cx).abs() < 6.0 && (ey - cy).abs() < 6.0)
                        {
                            out.push((cx, cy, w, h, strength));
                        }
                    }
                    CFRelease(el as CFTypeRef);
                    if out.len() >= 80 { CFRelease(app as CFTypeRef); return out; }
                }
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
