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
privacy-friendly. Native system-wide cursor movement + clicks are **built**
(CoreGraphics + Accessibility, see "HUD mode + separate windows"). Current
milestone: the separate-windows HUD architecture (opaque HUD w/ live camera,
ring/wheel/keyboard as their own windows) replacing the old transparent overlay.

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

## HUD mode + separate windows (NOT a full-screen overlay)
After calibration the app is NOT a transparent full-screen shield. It is a set of
**small opaque native windows**, so the desktop is never covered and a click never
resizes anything (the old full-screen overlay's per-click `maximize`/`zoom` was the
"everything slides to the corner" warp — never reintroduce a window resize on the
click path):
- **main** → shrinks to a small **opaque HUD** (`setWindowMode("hud")`, explicit
  physical frame in `lib.rs` — never `maximize`/`zoom`, which *animate* the frame).
  The HUD shows the **live camera feed**, control capsule, and confidence bar.
  `body.hud` + a rounded, opaque `#root` give it its capsule look. Deliberate
  panels (settings/help/tutorial/accuracy/re-anchor = `bigPanel`) briefly go
  `setWindowMode("full")`; the action wheel and keyboard are **not** panels.
- **ring** → the dwell cursor ring, a tiny always-on-top window a Rust thread
  (`spawn_ring_follower`) parks on the real OS cursor.
- **wheel** → the action menu, its own window shown at the gaze point
  (`show_overlay_at`). **keyboard** → the on-screen keyboard, docked bottom
  (`show_overlay_bottom`).

`DwellCursor` (main) drives the **real OS cursor** via CoreGraphics
(`src-tauri` `warp_cursor`) and dwell injects **real clicks** (`mouse_click`) into
any app. Overlay windows can't see each other's DOM, so each runs its own local
dwell (`useWindowDwell`) fed by gaze the main window broadcasts (`gaze:global` via
`overlayBus`), and reports results back (`wheel:select` / `keyboard:close`). Live
confidence MUST exclude the `fit` factor (constant per frame) or tracking sticks
on "reacquiring". **Requires macOS Accessibility permission** (System Settings ›
Privacy & Security › Accessibility) or synthetic clicks are ignored.
