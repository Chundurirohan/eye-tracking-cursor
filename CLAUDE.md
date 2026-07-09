# Gaze — repo guide for Claude

Native macOS webcam **eye-tracking** app. Estimates where the user is looking,
calibrates that signal to the screen, and (eventually) drives system-wide cursor
control. Accessibility product, not a gimmick — favor reliability and clarity.

## Stack
- **Frontend:** React 18 + TypeScript + Vite. Path alias `@/` → `src/`.
- **Desktop shell:** Tauri 2 (`src-tauri/`, Rust).
- **Vision:** MediaPipe FaceLandmarker (iris + head pose), loaded from CDN.
- **State:** local `zustand` settings store + a hand-rolled reducer state machine.

## Commands
- `npm run dev` — Vite dev server (browser; camera + MediaPipe work here).
- `npm run tauri dev` — full desktop app (needed for native session persistence).
- `npm run build` — `tsc && vite build` (typecheck is part of the build).
- `npm test` — Vitest (jsdom). `npm run test:watch` to iterate.
- Rust: `cargo check` / `cargo build` inside `src-tauri/` (cargo may be at
  `~/.cargo/bin/cargo` if not on PATH).

## Architecture (keep these layers separate)
- `src/core/engine/` — vision. `IGazeEngine` is the contract; `MediaPipeGazeEngine`
  is the impl. `estimate()` returns a `GazeFrame` (feature, confidence, point,
  head pose). Smoothing is One-Euro (`filters.ts`); scoring is `confidence.ts`.
- `src/core/calibration/` — `CalibrationController` walks a 5×5 grid using a
  **dwell window** per point then **3 smooth-pursuit moving passes** (see
  "Calibration method" below). `grid.ts` fits the ridge-regression model
  (`featureBasis` → `wx`/`wy`); `CalibrationModel` maps features → screen.
- `src/core/session/` — `machine.ts` is a **pure** reducer
  (`boot → permissions → calibrating → tracking ⇄ reacquiring / paused / error`).
  `persistence.ts` invokes Tauri commands, falling back to `localStorage`.
- `src/features/` — UI scenes (calibration, tracking capsule, permissions,
  diagnostics). `src/App.tsx` wires camera → engine → scenes and owns the
  tracking RAF loop and the calibration accept/retry policy.
- `src-tauri/src/lib.rs` — `load_session` / `save_session` / `clear_session`
  store an opaque JSON string under the OS app-data dir.

## Critical invariants (learned the hard way)
- **Confidence is a geometric mean of factors — any factor near 0 collapses it.**
  The reprojection ("fit") factor only exists once calibrated, so during
  calibration `reprojectionError` MUST be `null` (factor omitted), not a default.
  Passing a default here is what stalled calibration on point one.
- **The fit factor must be suppressed while collecting calibration samples, even
  if a model is already loaded.** On resume the app loads a *saved* model into
  the engine; without `engine.setCollecting(true)` (set by `CalibrationController`)
  every calibration frame is scored against that stale model's residual, capping
  confidence (~18% with a bad saved model) while face/eyes/head all read fine —
  the "everything's green but it won't advance" bug.
- **Sample acceptance gates on *actionable* factors, not the composite score.**
  `sampleBlockers()` (face/eyes/head only — never `fit`) is the single source of
  truth shared by the controller and the coaching UI: no blockers ⇒ the frame is
  collected AND no advice is shown. So the user is never told to fix something
  while also being stuck, and a frame the user can't improve is always accepted.
- **The accept-vs-retry decision lives in `App.tsx`, not the reducer.**
  `CALIBRATION_COMPLETE` is a pure transition to `tracking`. App caps attempts
  (`MAX_CALIBRATION_ATTEMPTS`) and accepts a best-effort calibration rather than
  looping forever.
- `QUALITY_THRESHOLD` must stay reachable on the actual confidence scale
  (~0.65–0.8 for a good calibration). It gates resume, RESUME, and accept.
- **No per-point gate may block advancing.** Static points advance on a hard
  dwell timer (`POINT_MS`); a live variance/outlier gate that can reject every
  frame deadlocks the calibration (it did). Clean bad samples at FIT time
  (`trimmedSamples`), never by withholding advancement.
- MediaPipe `detectForVideo` needs **monotonically increasing** timestamps; only
  one estimate loop runs at a time (tracking loop is cancelled during calibration).

## When changing calibration / confidence / state
Add or update tests — the core is pure and well-covered:
`controller.test.ts` (must advance past point 0 and complete),
`confidence.test.ts` (uncalibrated good face must clear the sampling gate),
`machine.test.ts`, `grid.test.ts`.

## Direction
Backend/core correctness first, visual polish last. Keep it local-only and
privacy-friendly. Next milestone: native system-wide cursor movement + clicks on
macOS (will need Accessibility permission and a Rust-side input layer).

## Calibration method (current)
Static **dwell + robust fit** per grid point: show the dot, skip ~400ms saccade
latency, collect frames for ~1.1s, then ALWAYS advance on the timer (no live
variance/outlier gate — those could deadlock). Bad frames are cleaned at fit
time by per-point trimmed-median (`grid.ts` `trimmedSamples`). Moving phase is
**smooth pursuit gated by velocity correlation** (`isFollowing`): collect only
when eye displacement is cosine-aligned with target displacement — model-free,
robust to absolute-accuracy error. One bounded in-session **weak-point re-do**
(`pointResidual > WEAK_RESIDUAL`) before finishing; the controller reports an
empty weak list so the app never launches its own refit-from-subset pass.

## Widget mode + dwell-click
After calibration the app is a **transparent, borderless, always-on-top overlay**
(Tauri `transparent`/`decorations:false`/`alwaysOnTop`/`macOSPrivateApi`; `body.widget`
makes the web bg transparent). Only the camera feed, control bar, confidence bar,
and gaze cursor paint. `DwellCursor` does dwell-to-click: resting gaze on a spot
fills a ring and dispatches a real DOM click on the element under it (overlays it
needs to click past must be `pointer-events:none`). Live confidence MUST exclude
the `fit` factor (constant per frame) or tracking sticks on "reacquiring".
System-wide clicking of OTHER apps still needs the native input layer
(Accessibility + CGEvent) — not yet built.

## Native input layer (gaze controls the OS)
The widget overlay is **click-through** in tracking mode (`setClickThrough` →
Tauri `setIgnoreCursorEvents(true)`), so the desktop is fully usable — a
transparent window still captures clicks otherwise, which "freezes" the screen.
Gaze drives the **real OS cursor** via CoreGraphics (`src-tauri` `warp_cursor`)
and dwell injects **real clicks** (`mouse_click`) into any app. `DwellCursor`
picks DOM `.click()` when a widget control is under the gaze, else a native OS
click at the gaze point. **Requires macOS Accessibility permission** (System
Settings › Privacy & Security › Accessibility) or synthetic clicks are ignored.
