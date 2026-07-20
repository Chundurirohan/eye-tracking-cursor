# Gaze — Build Prompt (for Fable 5)

You are helping me build a real native desktop eye-tracking app called Gaze.

This is a serious product vision, not a toy demo, not a browser-only experience, and not something that should feel like a webpage in a shell. The app must feel like a real macOS utility that someone can depend on.

## PRODUCT VISION

Gaze is a webcam-only, macOS-first desktop eye-tracking utility designed to let users interact with their computer more naturally and more accessibly through gaze-based control.

The long-term vision is a dependable eye-driven desktop interaction system that feels calm, premium, invisible when active, and trustworthy enough for real daily use.

The app should feel like Apple designed it:
- premium
- sparse
- elegant
- calm
- glass-like but subtle
- lightweight
- soft
- adaptive between light and dark mode
- never visually noisy
- never overly technical by default

The user experience should feel less like "using an eye-tracking app" and more like "my computer understands where I'm trying to look."

## PLATFORM SCOPE

For now, build for macOS only.
Do not dilute the architecture trying to make everything cross-platform immediately.
Design the code cleanly enough that other platforms can be added later, but optimize current implementation and behavior for macOS first.

## CORE PRODUCT PRINCIPLE

This app should behave like a background desktop utility, not a foreground app.

That means:
- the app window is mainly for onboarding, permissions, calibration, settings, and diagnostics
- after calibration succeeds and tracking starts, the main app should disappear
- only a compact floating HUD / status capsule and optional tiny live camera preview should remain visible
- the user should be able to continue using their computer normally
- the app should get out of the way, similar to how polished screen recording or menu bar utilities disappear once active
- the main window should reappear only when needed: settings, recalibration, tracking errors, onboarding, or explicit user action
- closing the main window should hide it, not quit the app
- the utility should be able to pause/resume, recalibrate, and expose status without demanding attention

## PRIMARY GOAL

Build a webcam-only gaze interaction system that is actually usable, stable, and calm.

The highest priorities are:
- reliability
- trust
- stable calibration
- good tracking behavior
- graceful recovery when confidence is weak
- low-friction user experience
- native utility behavior
- maintainable architecture

Do not optimize for novelty over reliability.

## WHAT THIS APP IS NOT

Do not build this like:
- a one-tab browser demo
- a flashy AI landing page
- an academic prototype with ugly calibration flow
- a debug-heavy UI
- a cursor toy with raw landmarks mapped directly to screen coordinates
- a foreground window that remains in the way during active use

The goal is not "show the technology." The goal is "make it actually usable."

## PRODUCT MODES / STATES

The app should have clear user states:
1. First launch
2. Permission setup
3. Camera ready
4. Guided calibration
5. Tracking active
6. Paused
7. Lost tracking / reacquiring
8. Recalibration needed
9. Settings open
10. Advanced diagnostics open
11. Critical error state

Every state should feel deliberate and polished.

## NATIVE APP MODEL

Use a native desktop architecture. Preferred stack:
- Tauri for desktop shell
- React + TypeScript for frontend
- Rust/native bridge where necessary for window lifecycle and OS integration

Do not rely on browser-tab assumptions. Do not structure the product around "one page." This should behave like a desktop utility app.

## WINDOW ARCHITECTURE

Use a multi-surface model if needed:
- Main window: onboarding, permissions, calibration, settings, advanced diagnostics
- Compact floating HUD / capsule: always available during active tracking
- Optional tiny camera preview window or embedded preview inside the capsule

After calibration:
- hide the full main window at the OS level
- keep only the compact HUD visible
- tracking must continue while the main window is hidden
- reopening settings or recalibration should bring back the appropriate UI cleanly

Do this through real native window management, not by merely hiding HTML elements.

## DESIGN LANGUAGE

The visual design should feel Apple-like:
- subtle translucent materials
- premium softness
- restrained typography
- sparse information density
- smooth motion
- high legibility
- minimal visual clutter
- default views should be quiet and confidence-inspiring

The app should be adaptive between light and dark themes. Status and confidence should be communicated elegantly, not loudly. Advanced debug info should be hidden by default and moved into an advanced view.

The compact tracking capsule should stay visible while tracking and include:
- pause/resume
- recalibrate
- settings
- subtle status indicator
- keyboard shortcut hint
- minimal footprint

## CALIBRATION VISION

Calibration is a core product experience, not a technical afterthought.

Calibration should feel: guided, calm, elegant, confidence-aware, fast but not rushed, visually polished.

Calibration requirements:
- permissions happen before calibration
- camera feed remains visible throughout calibration
- structured initial poses are used
- movement prompts appear at every calibration point
- calibration points auto-advance when confidence is high enough
- if calibration quality is weak, only weak points are recalibrated
- over time, the product should collect more real-world posture data passively during use to improve robustness

Calibration visuals should use: dots and rings, soft glow, Apple-like motion and presence.

## TRACKING BEHAVIOR VISION

Tracking should feel: fast, dampened, stable, confidence-aware, resistant to jitter, forgiving of small involuntary motion, calm and not twitchy.

Movement behavior requirements:
- move as quickly as possible without overshooting
- use damping to avoid wild cursor behavior
- support adjustable deadzones
- default deadzone should ignore tiny eye movements

The app should prioritize subjective usability, not just raw numeric output.

## TECHNICAL TRACKING STRATEGY

This is webcam-only. Do not require dedicated eye-tracking hardware. Do not assume hardware eye trackers are available.

However, do not use MediaPipe alone as if it were a complete gaze engine. MediaPipe or similar should be treated as a feature extractor, not the final solution.

Preferred technical direction:
- webcam capture
- face landmarks
- iris/eye-region features
- head pose features
- confidence estimation
- smoothing/filtering
- calibration mapping
- drift handling
- reacquisition logic
- appearance-based gaze estimation where possible

Use facial landmarks, shoulder landmarks, and helpful upper-body/full-body context when beneficial, especially if it allows a more relaxed posture and more stable predictions.

The system should explicitly account for: head movement, posture drift, changing user position, reacquisition after temporary loss, confidence-aware gating, calibration quality variance.

## RELIABILITY STANDARD

The product should feel dependable enough that people can trust it. That means:
- avoid unstable cursor behavior
- avoid fragile calibration
- avoid UI states that strand the user
- fail gracefully when confidence is low
- clearly communicate when the system is reacquiring or needs recalibration
- preserve calm behavior in edge cases

## VERSION 1 FOCUS

Version 1 does not need to optimize for every edge case or every user type. For example, glasses support is not the main priority for V1 if that slows down the core product.

Version 1 should instead focus on:
- a reliable calibration flow
- good active tracking behavior
- hidden-window utility behavior
- pause/resume/recalibrate lifecycle
- strong state management
- a believable premium desktop experience
- architecture that can evolve

## ARCHITECTURE REQUIREMENTS

Structure the app cleanly into layers:

1. UI layer — onboarding, permission flow, calibration scene, floating capsule / HUD, settings, advanced diagnostics
2. Tracking engine layer — camera capture, feature extraction, gaze estimation, confidence scoring, filtering / smoothing, drift correction, reacquisition
3. Native integration layer — macOS permissions, real window hide/show behavior, always-on-top capsule/HUD, background utility behavior, eventual system cursor integration

Keep boundaries clear. Avoid mixing UI logic with tracking math. Avoid hacks unless clearly labeled temporary.

## USER EXPERIENCE PHILOSOPHY

This app should reduce effort, not increase it. The user should not have to think about the software constantly.

Good UX traits: low friction, very few visible controls during active use, graceful prompts, elegant recovery from weak tracking, clear but quiet feedback, minimal interruptions, polished transitions.

The app should feel like a native assistive tool, not like a developer build.

## ENGINEERING PHILOSOPHY

Build carefully and incrementally. Do not rewrite everything blindly.
Before major changes: inspect the current architecture, summarize the existing code structure, identify the smallest useful next milestone, change only what is needed for that milestone.

When implementing: explain the plan briefly, list files you will change, implement in small steps, explain how to test locally, note macOS-specific caveats, preserve architecture cleanliness.

If a tradeoff exists, prefer the option that makes this feel more dependable and native.

## DO NOT

Do not: overbuild decorative frontend before behavior works; keep the full main window visible during active use; flood the UI with technical data; assume raw landmark mapping is sufficient; optimize for demo appeal over actual use; build the app around a browser mental model; add complexity without improving trust or usability.

## CURRENT PRODUCT OBJECTIVE

Starting from the existing codebase, turn the project into a true macOS utility app that has: a robust permission flow; a polished calibration experience; stable tracking lifecycle management; a hidden main window after calibration; a compact floating HUD during active use; clean separation between UI, tracking engine, and native integration; strong foundations for future gaze-driven cursor control and system-wide interaction.

## OUTPUT EXPECTATION

When helping on this project: think like a product engineer, not just a coder; prioritize reliability and architecture; preserve the product vision; keep the experience elegant and minimal; build toward a trustworthy desktop utility, not a prototype.

Always favor decisions that make Gaze feel calm, native, dependable, and real.

---
---

# ADDENDUM (context and hard constraints to honor before building)

The sections above are the vision. The sections below are additional context, ground truth about the existing code, and hard-won constraints. **Read this entire addendum before writing any code.** Where the addendum gives concrete facts about the current codebase or specific engineering constraints, treat them as authoritative.

## A. CURRENT CODEBASE STATE — READ BEFORE BUILDING (do not rewrite from scratch)

This is an existing, working Tauri 2 + React 18 + TypeScript + Vite project. A large amount already works and must be **preserved and refined, not rebuilt.** Inspect it first. Key facts:

**Stack in place:** React 18 + TS + Vite (path alias `@/` → `src/`); Tauri 2 (`src-tauri/`, Rust); MediaPipe FaceLandmarker (iris + head-pose) as the feature extractor; `zustand` (persisted) for settings; a pure reducer state machine for session lifecycle; Vitest (jsdom) for the pure core.

**Layered architecture already exists — keep these boundaries:**
- `src/core/engine/` — vision. `IGazeEngine` is the contract; `MediaPipeGazeEngine` is the impl. `estimate()` returns a `GazeFrame` (feature, confidence, point, head pose). Smoothing is One-Euro / adaptive-predictive (`filters.ts`); confidence is a **geometric mean of per-frame factors** (`confidence.ts`) — any factor near zero collapses it, which is how bad frames are gated. `adaptation.ts` holds pose-keyed self-healing drift correction. There is an `OnnxGazeEngine` stub as the seam for a stronger appearance-based model.
- `src/core/calibration/` — `CalibrationController` walks a grid using a **dwell window per point** then **smooth-pursuit "follow the dot" passes**. `grid.ts` fits **ridge regression + a regularized Gaussian RBF** residual surface (`featureBasis` → `wx`/`wy`). Weak points are re-done in-session. There is a quick (3×3) vs full (5×5) mode.
- `src/core/session/` — `machine.ts` is a **pure reducer** (`boot → permissions → calibrating → tracking ⇄ reacquiring / paused / error`); `persistence.ts` stores an opaque JSON blob (calibration, permission grant, prefs, named profiles) via Rust with a localStorage fallback; reload-on-startup + resume logic exist.
- `src/features/` — UI scenes: permission gate, calibration scene + coaching, tracking capsule/HUD, radial action menu, on-screen keyboard, diagnostics (accuracy test, advanced view). `App.tsx` wires camera → engine → scenes and owns the tracking RAF loop.
- `src-tauri/src/lib.rs` — **the native input layer already exists and works on macOS**: warp the real OS cursor (CoreGraphics `CGWarpMouseCursorPosition`, no Accessibility needed), inject left/right/double **clicks**, **drag** (down/dragged/up), **scroll**, **type text + key taps**, **system-wide magnetic snapping** via the Accessibility API (`AXUIElementCopyElementAtPosition`), click-through toggling (`setIgnoreCursorEvents`), multi-monitor move, session persistence, and global shortcuts. It also checks/prompts Accessibility (`AXIsProcessTrusted`, prompt on launch).

**Implication:** The "future gaze-driven cursor control and system-wide interaction" referenced in the vision is **already substantially built.** Do not discard it. The near-term work is: (1) reorganize into the hidden-main-window + floating-HUD **utility model**, (2) raise **accuracy/stability** to the bar below, (3) refine the magnetic targeting, (4) polish the calibration and onboarding, all while keeping the existing engine/calibration/native layers intact. Before any large change, summarize the current structure and state the smallest useful milestone (as the vision demands).

## B. INTERACTION & CLICKING MODEL (near-term, mostly built)

- **Pointer = the real OS mouse cursor**, warped to the smoothed gaze point. There is **no full-screen drawing canvas** for a reticle. Show dwell feedback as a **small, always-on-top, click-through follower window** that rides at the cursor and draws the dwell-fill ring, color-coded by confidence. It must reposition smoothly (see Performance section) and never steal focus.
- **Activation is user-selectable in Settings: Dwell and Blink (and optional Switch/key).** Neither is forced. Dwell is the universal default (no extra hardware). Blink = a deliberate eyes-closed interval, bounded min/max duration, with a cooldown so a double-blink can't double-fire.
- **Actions:** left / right / double click, **drag** (two-step: dwell to grab, dwell to drop), **scroll** (gaze-rest in top/bottom edge bands). A **radial action wheel** opens on an empty-space dwell to pick the action; a direct-left-click mode is also available.
- **Targeting is magnetic-assist-first** (see Accuracy section).
- **Text entry:** a first-class **hands-free on-screen keyboard** (dwell-typed, types into the focused app) is a headline capability; **word prediction** is a planned enhancement.
- **Precision mode** (fine-targeting): a toggle that steadies the cursor and lengthens dwell for tiny targets.

## C. ACCURACY & TARGETING — THE #1 HARD REQUIREMENT

Accuracy is the top quality bar; every other decision serves it.

- The cursor must be **extremely accurate and consistent, with no perceptible deviation**, and must **stay in the user's primary vision** — it must never drift, jitter, or wander into the periphery, and must **never fly off**. Enforce a **safety clamp / stabilization** so a bad frame can never fling the cursor across the screen.
- Accuracy must hold through **head movement (small and large)** and posture drift. Achieve this with: a **stronger appearance-based gaze model** where possible (the `OnnxGazeEngine` seam exists), **rich calibration**, **head-pose-keyed self-healing correction** that learns from every confirmed click, and **aggressive fixation-locking** so the cursor parks dead-still when the user holds a point.
- **Honest constraint:** webcam gaze fundamentally degrades under *large* head turns (the eye-appearance signal weakens). Spec and implement it as: **near-zero deviation within a normal working range, graceful degradation beyond it, and instant (~1s) re-anchor recovery** — not a false promise of literally zero error at every angle. Communicate reduced confidence rather than emitting a wild cursor.
- **Magnetic targeting (assist-first):** snap the cursor onto real UI elements (buttons/links) in any app and **hold that lock through jitter**, so cluttered spaces and small targets are reliable. Judge "settled/snap-eligible" by **fixation stability over a short window (spread), not instantaneous frame-to-frame speed** — jitter has low net movement, so snapping must engage *through* it. Use hysteresis so clutter can't flip the target or reset the dwell. Fall back to raw position only when nothing is snappable. Snap strength and radius are user-tunable and should scale up with confidence.

## D. PERFORMANCE & SMOOTHNESS — HARD CONSTRAINTS (this is where naive builds fail)

Smoothness of the cursor and calibration is a non-negotiable acceptance criterion. The single biggest failure mode is starving the render/animation loop. Enforce:

- **Throttle inference to the camera's real frame rate.** Do NOT run the gaze model on every `requestAnimationFrame` — on a 120 Hz ProMotion display the RAF fires far faster than a ~30 fps webcam, so re-inferring the same frame is wasted CPU/GPU and causes jank. Gate `estimate()` on the video frame actually advancing (`HTMLVideoElement.currentTime` change or `requestVideoFrameCallback`).
- **Only one inference loop may run at a time.** MediaPipe `detectForVideo` needs monotonically increasing timestamps. The calibration loop, the ready/positioning loop, the tracking loop, and the accuracy-test loop must never run simultaneously against the same video.
- **Decouple animation from inference.** Deterministic visuals (e.g. a moving calibration dot on a time-based path) must animate at display refresh rate independent of inference. Never bind their motion to the inference cadence.
- **Do not re-render the whole app tree every frame.** Per-frame confidence/diagnostics values must NOT drive a top-level React re-render — throttle those state updates (~10 Hz) so a growing UI can't starve the animation/RAF loop on the shared main thread. Keep per-frame work in refs and cheap subtrees.
- **The follower cursor-ring window must reposition at ~60 fps without jank.** If native per-frame window moves are heavy, batch/throttle and measure; treat this as a first-class perf constraint.
- Keep smoothing single-layer (don't double-smooth). Use One-Euro/adaptive-predictive at the data layer; only add render-side easing in precision mode.

## E. NATIVE macOS SPECIFICS (make it a real utility, not a windowed app)

- **Background-utility behavior:** consider making it an **agent app** (`LSUIElement` / accessory activation policy) with a **menu-bar item**, so during active use there is no Dock icon or app-switcher presence — it truly gets out of the way. The main window is shown on demand (onboarding/settings/recalibration).
- **HUD/capsule and cursor-ring windows** should be **non-activating, always-on-top, borderless, transparent panels** (NSPanel `nonactivatingPanel` semantics / Tauri equivalents) that **never steal focus** from the app the user is working in.
- **Closing the main window HIDES it (does not quit).** Quit only via explicit menu-bar action. Tracking continues while the main window is hidden.
- **Click-through:** any transparent always-on-top surface MUST be click-through during active use (`setIgnoreCursorEvents(true)`), re-asserted on an interval and on focus — a transparent window that isn't click-through silently swallows every click and "freezes" the desktop. This is already handled in the codebase; preserve it.
- **Permissions (TCC):** Camera (`NSCameraUsageDescription` in Info.plist) requested before calibration; **Accessibility** required for injecting clicks/drags/keystrokes and for magnetic snapping (cursor *movement* via CGWarp does NOT need it). Provide an in-app banner that shows effective Accessibility status and links straight to the settings pane.
- **Accessibility grant gotcha:** an unsigned/ad-hoc rebuild produces a new binary and macOS **drops the Accessibility grant** for the old one — clicks then silently no-op while cursor movement still works. Detect this (`AXIsProcessTrusted`), surface it clearly, and offer one-tap re-grant. For a shipping build, **code-sign with a stable identity** so the grant persists across updates.
- **Multi-monitor** is out of V1 scope but the geometry math must map gaze → global screen coordinates from real window geometry (already done); keep it correct for the primary display.

## F. SAFEGUARDS & FAIL-SAFES (non-negotiable, always on)

- A **global keyboard shortcut instantly pauses / hands control back to the mouse**, and works even if the HUD is unreachable or click-through has misbehaved. Pausing can never deadlock the app.
- **Clicks auto-freeze when tracking confidence is low.** Never emit a click (or a wild cursor jump) on a low-confidence frame. Freeze cursor updates and clearly show "reacquiring."
- **Accidental-click prevention:** click cooldowns; blink safeguards (bounded duration + cooldown); empty-space dwell requires a longer, deliberate hold than a snapped target.
- **Never strand the user:** the pause/resume/recalibrate controls must always be reachable (the HUD's own controls stay gaze-operable even while the desktop is click-through). Best-effort accept a sub-threshold calibration rather than trapping the user in an endless retry loop.

## G. CALIBRATION & DRIFT (refine what exists)

- Permissions → guided **live positioning** (coach distance/centering/lighting/head-pose with a live face guide, using the camera already open) → **guided calibration** (dwell + smooth-pursuit, dots/rings/soft-glow, auto-advance on confidence, weak-point-only redo) → tracking.
- **Confidence during sample collection must omit the model-fit factor** (otherwise a stale saved model caps the score and stalls calibration — this exact bug exists in the history; preserve the guard).
- **No per-point gate may block advancing** — advance on a hard dwell timer; clean bad samples at fit time (trimmed median), never by withholding advancement, or calibration can deadlock.
- **Drift handling:** one guided calibration up front; **continuous self-healing** pose-keyed correction learned from confirmed clicks; a **~1-second re-anchor** the user can trigger anytime it slips; **passively collect posture data during use** to improve robustness over time. **No periodic "recalibrate now" nags** — surface a gentle, dismissible nudge only when measured drift is high.
- **Accuracy test** (objective error heatmap) exists — keep it as the acceptance/measurement tool for the ≥90%-intended / ≤5%-accidental targets.

## H. PRIVACY & OFFLINE

- All camera capture and gaze inference are **on-device**. No video, landmarks, or gaze data leave the machine. **No telemetry.**
- **Bundle the model + wasm locally** so the app works fully offline after install; a one-time build-time fetch is acceptable, runtime must not require network. (A `setup:assets` vendoring step already exists.)

## I. THE APP'S OWN UI MUST BE ACCESSIBLE

This is an accessibility tool, so its own interface must not exclude the people it serves:
- large, well-spaced, dwell-friendly targets; high-contrast, legible type; adaptive light/dark.
- fully keyboard-operable; VoiceOver-friendly labels; respect **reduce-motion** and **reduce-transparency** system settings.
- every interactive control must be operable hands-free (dwell) as well as by mouse/keyboard.

## J. TESTING & VERIFICATION

- The pure core (calibration controller, grid fit, confidence, state machine) is unit-tested with Vitest and must stay green: `npm test`. Add/adjust tests when changing calibration/confidence/state.
- Typecheck is part of the build (`npm run build` = `tsc && vite build`); `cargo check` in `src-tauri/` for Rust.
- Run the real app with `npm run tauri dev` (needs camera + Accessibility). **Do not accept "it launches" as done** — drive the actual flow: calibrate, watch the moving-dot phase for smoothness, click into another app, verify recovery. **Smoothness and click-landing are the acceptance criteria**, not compilation.

## K. STAGING (build in small, verifiable milestones)

Prefer this order; verify each before the next:
1. **Utility shell:** agent-app/menu-bar behavior, hide-not-quit, main-window ↔ floating-HUD lifecycle via real native windows; tracking continues with the main window hidden.
2. **Follower cursor-ring window** at the OS cursor (smooth, click-through, non-activating).
3. **Accuracy & stability pass:** frame-rate-gated inference, single inference loop, fixation-lock, safety clamp, magnetic assist judged by fixation stability + hysteresis.
4. **Calibration/onboarding polish:** live positioning, guided calibration visuals, weak-point redo, ~1s re-anchor, self-healing correction.
5. **Stronger gaze model** behind the `IGazeEngine` seam (appearance-based) once the pipeline is stable.
6. **On-screen keyboard + word prediction.**

## L. ADDITIONAL DO-NOTs

- Do not run the gaze model on every animation frame, and do not run two inference loops at once.
- Do not lift per-frame tracking state into the top-level component (it re-renders the world and starves the loop).
- Do not ship a transparent full-screen window that isn't click-through (it silently shields the desktop).
- Do not map raw landmarks straight to screen coordinates as a "cursor."
- Do not rebuild the existing engine / calibration / native-input layers from scratch — inspect, preserve, and refine them.
- Do not let advanced/diagnostic data leak into the default, calm UI.
