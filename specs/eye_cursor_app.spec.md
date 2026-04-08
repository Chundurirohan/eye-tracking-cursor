# Eye Cursor App — Product & Engineering Spec

**Title**: Alternative Device Control Application (Eye Cursor App)  
**Repo**: `spec-test`  
**Status**: Draft (implementation-ready)  
**Primary libraries**: MediaPipe (landmarks), PyTorch + L2CS-Net (gaze), Kalman smoothing, OS cursor control  
**Platforms**: Windows, macOS, Linux  

---

## Overview

This project is a Python-based assistive technology application that enables full computer cursor
control using **eye movement** captured by a standard built-in or external webcam. It requires no
mouse, trackpad, touch input, or hand gestures.

The pipeline:

- Webcam frames → MediaPipe face/iris landmarks
- Landmarks → L2CS-Net gaze estimation (PyTorch)
- Raw gaze → user-specific 9-point calibration mapping → screen coordinates
- Screen coordinates → Kalman filter smoothing → stable cursor movement
- Clicking via hands-free **dwell** or **intentional blink** (EAR-based)

This is designed to be low-cost, accessible, and cross-device.

---

## Constitution Alignment (repo governance)

Derived from `.specify/memory/constitution.md`:

- **Spec-first, testable requirements**: All requirements and success metrics below are measurable.
- **Small, composable changes**: Modules are explicitly separated with clear I/O contracts.
- **Explicit quality gates**: FPS/latency budgets, click safety thresholds, and persistence guarantees
  are defined.
- **Observability**: A performance telemetry interface is part of the runtime loop.
- **No hidden coupling**: Modules communicate via typed data structures; OS cursor injection is
  isolated behind a backend interface.

---

## Goals

- Provide reliable cursor control using only eye movement on commodity webcams.
- Provide at least one hands-free clicking method that is accurate and safe.
- Persist calibration so users rarely need to recalibrate.
- Run on Windows/macOS/Linux at **20+ FPS** with smooth motion.

## Non-Goals (v1)

- Multi-monitor support (v1 targets primary display only; multi-monitor can be added later).
- Full UI/installer polish (v1 can use a minimal calibration UI and CLI entrypoint).
- Cloud services / remote processing (all inference is local).
- “Voice Interpretation” feature is **out of scope until clarified**.

---

## Primary Features

### Cursor control by gaze
- Cursor follows gaze across the full screen, including corners and edges.
- Cursor does not drift or jitter when gaze is held steady.

### Calibration
- One-time **9-point** calibration mapping user gaze to screen coordinates.
- Calibration completes in **< 60 seconds** on first attempt.
- Calibration is stored and automatically reloaded on launch.

### Clicking (hands-free)
- **Dwell click**: click when holding gaze over a target for a configured dwell time.
- **Blink click**: click when an intentional blink pattern is detected via EAR (with safeguards).

### Observability & diagnostics
- Built-in FPS and per-module latency reporting.
- Ability to enable a debug overlay (optional) for landmarks/gaze point/cursor target.

---

## Success Metrics (measurable)

1. **Gaze accuracy**: after calibration, cursor lands within **40 px** of intended target at least
   **80%** of the time in a test harness.
2. **Cursor stability**: when gaze is held on a fixed point, cursor jitter stays within a small
   radius and does not visibly shake or drift (quantified below).
3. **Calibration time**: 9-point calibration completes in **≤ 60 seconds** on first attempt.
4. **Click reliability**:
   - Dwell and blink clicks trigger correctly **≥ 90%** when user intends.
   - Fewer than **1 in 20** clicks are accidental (**≤ 5%** false positives).
5. **Full screen coverage**: user can reliably move to any corner and edge (no dead zones).
6. **Cross-device functionality**: runs without unhandled errors on Windows/macOS/Linux with webcam.
7. **Smooth motion**: cursor movement feels fluid and continuous at **≥ 20 FPS**.
8. **Session persistence**: calibration is saved and reloaded on subsequent launches.
9. **Voice interpretation**: **NEEDS CLARIFICATION** — define scope or remove from v1 metrics.

---

## User Scenarios

### Scenario 1: Student with a motor disability (P1)
User completes calibration and controls cursor for browsing and document use with dwell click only.

**Independent Test**: Install, calibrate, open browser, click links/icons using dwell click.

### Scenario 2: User recovering from wrist surgery (P1)
User uses eye cursor to navigate while typing with one hand; smoothing removes jitter.

**Independent Test**: Run app, type in editor, navigate UI elements without touching trackpad.

### Scenario 3: Accessibility researcher testing system (P2)
Researcher runs repeated calibration + accuracy tests across multiple users/devices.

**Independent Test**: Repeat calibration for 3 participants; export accuracy metrics summary.

### Scenario 4: First-time non-technical user (P1)
User follows guided 9-dot UI, then uses app without reading docs.

**Independent Test**: Observe first-run success without intervention.

### Scenario 5: Power user multitasking hands-free (P2)
Developer keeps hands on keyboard and navigates secondary windows.

**Independent Test**: Use blink-click mode with safeguards (no accidental clicks during normal blinking).

---

## Requirements

### Functional requirements

- **FR-001**: System MUST capture frames from a webcam and process them in real time.
- **FR-002**: System MUST detect facial/eye/iris landmarks from frames (MediaPipe).
- **FR-003**: System MUST estimate raw gaze direction from landmarks (L2CS-Net).
- **FR-004**: System MUST provide a 9-point calibration that produces a per-user mapping from raw
  gaze to screen coordinates.
- **FR-005**: System MUST smooth mapped coordinates to reduce jitter while preserving responsiveness.
- **FR-006**: System MUST move the OS cursor to the smoothed coordinates.
- **FR-007**: System MUST support hands-free clicking via dwell time and/or blink pattern.
- **FR-008**: System MUST persist calibration and reload it automatically on startup.
- **FR-009**: System MUST expose basic observability (FPS and per-module latency) in logs or on-screen.
- **FR-010**: System MUST fail safely if face tracking quality is low (no clicks; cursor freeze or
  gentle decay to last stable point).

### Non-functional requirements

- **NFR-001**: Maintain **≥ 20 FPS** end-to-end on supported baseline hardware (CPU-only acceptable).
- **NFR-002**: Minimize perceived latency; avoid cursor “lag” feeling.
- **NFR-003**: Cross-platform: Windows/macOS/Linux.
- **NFR-004**: Operate offline after first-time model download.
- **NFR-005**: Privacy: all camera processing stays local; do not store raw frames by default.

---

## System Architecture

### Module list (explicit I/O contracts)

The runtime pipeline is a single-process loop with explicit modules:

1. `video_capture`
2. `face_landmark_detection` (MediaPipe)
3. `gaze_estimation` (L2CS-Net)
4. `calibration_system`
5. `kalman_filter`
6. `click_detection` (dwell + blink)
7. `cursor_controller`
8. `persistence_layer`

### Step-by-step data flow (webcam frame → cursor movement)

**Notation**: Budgets are targets to maintain 20+ FPS. Actual times must be measured and tuned.

1) **Capture frame** (`video_capture`)
- **Data format**: `Frame(data=np.ndarray[H,W,3] uint8 BGR, t_capture=monotonic_sec)`
- **Latency**: 20–30 ms (budget varies by camera/driver)

2) **Landmarks** (`face_landmark_detection`)
- **Input**: `Frame`
- **Output**: `FaceLandmarks(landmarks[N,3], eye_pts_left[M,3], eye_pts_right[M,3], confidence, status)`
- **Latency**: 15–25 ms
- **Failure handling**: if `status != OK` → freeze cursor updates and suppress click triggers

3) **Raw gaze inference** (`gaze_estimation`)
- **Input**: `Frame` + `FaceLandmarks` (and derived eye crops)
- **Output**: `RawGaze(yaw_deg, pitch_deg, confidence)`
- **Latency**: 15–20 ms (CPU), lower with GPU

4) **Map gaze to screen** (`calibration_system`)
- **Input**: `RawGaze` + `CalibrationModel`
- **Output**: `ScreenPointRaw(x_float_px, y_float_px)`
- **Latency**: < 1 ms

5) **Smoothing** (`kalman_filter`) — **primary smoothing location**
- **Input**: `ScreenPointRaw` + `dt`
- **Output**: `ScreenPointSmooth(x_float_px, y_float_px)`
- **Latency**: < 1 ms

6) **Click intent** (`click_detection`)
- **Input**:
  - Dwell: `ScreenPointSmooth` + timestamps
  - Blink: EAR computed from eye landmarks + timestamps
- **Output**: optional `ClickEvent(button, source, t_event, position)`
- **Latency**: < 2 ms

7) **OS cursor injection** (`cursor_controller`)
- **Input**: `ScreenPointSmooth` (+ optional `ClickEvent`)
- **Output**: OS side effects (move pointer, click)
- **Latency**: < 10–15 ms target (avoid blocking loop)

---

## Implementation Details

### Data formats (canonical)

- **Frames**: BGR `uint8` `np.ndarray` (OpenCV default), resized (e.g., 640×480) for performance.
- **Landmarks**: normalized float arrays in \([0,1]\) image coordinates, plus z if available.
- **Raw gaze**: yaw/pitch in degrees (from L2CS-Net decoding), plus a confidence value.
- **Screen coordinates**: pixel coordinates in primary display space.

### Gaze → screen mapping (interpolation + nonlinear distortion handling)

#### Inputs
Raw gaze \(g = (\text{yaw}, \text{pitch})\) and calibration samples \( (g_i, s_i) \) where
\(s_i = (x_i, y_i)\) are known screen points from the 9-point calibration.

#### Baseline method: 2D polynomial regression (order 2–3)

This provides a simple nonlinear mapping that can correct lens/head-pose distortion without a heavy
model:

For order 2:
\[
\phi(y,p) = [1, y, p, y^2, y p, p^2]
\]
\[
x = w_x^\top \phi(y,p), \quad y_{scr} = w_y^\top \phi(y,p)
\]

Fit \(w_x, w_y\) via least squares using collected calibration samples.

#### Nonlinear distortion handling (when 9-point fit is insufficient)

If RMS calibration error is above threshold (e.g., > 40 px), apply one of:

- **Higher-order polynomial (order 3)**: adds cubic terms for curvature at edges.
- **Piecewise interpolation**: fit separate local models per screen region (e.g., quadrants) and
  blend outputs to reduce edge distortion.
- **Regularization**: ridge regression to avoid unstable coefficients (reduces overshoot).

Outputs MUST be clamped to screen bounds.

#### Calibration quality
- Compute and store RMS error (px) for calibration session.
- If error is too high, prompt user to redo unstable points.

### Cursor smoothing (Kalman filter)

#### State definition

Constant-velocity state:
\[
\mathbf{x} = [x, y, v_x, v_y]^T
\]

Transition (with timestep \(\Delta t\)):
\[
F =
\begin{bmatrix}
1 & 0 & \Delta t & 0 \\
0 & 1 & 0 & \Delta t \\
0 & 0 & 1 & 0 \\
0 & 0 & 0 & 1
\end{bmatrix}
\]

Measurement (position only):
\[
H =
\begin{bmatrix}
1 & 0 & 0 & 0 \\
0 & 1 & 0 & 0
\end{bmatrix}
\]

#### Noise matrices (tuning parameters)

- \(R\): measurement noise (cursor measurement variance). Start with
  \(R = \sigma_m^2 I\) where \(\sigma_m\) ~ 15–30 px depending on jitter.
- \(Q\): process noise. Start simple with diagonal:
  \(Q = \mathrm{diag}(\sigma_p^2, \sigma_p^2, \sigma_v^2, \sigma_v^2)\).

#### Update frequency
- Update on each processed frame. Target loop: **20–30 Hz**.

#### Stability targets
- When gaze is steady: jitter radius ideally < 20 px over 2–3 seconds.
- When gaze shifts quickly: perceived lag should be low (target < 100 ms).

### Click detection safeguards (avoid accidental natural blinks)

#### Dwell click
- Trigger only if cursor remains within radius \(R\) (e.g., 40 px) for time \(T\) (e.g., 0.5 s).
- Enforce a post-click cooldown to avoid repeated firing when user holds gaze (e.g., 300–500 ms).

#### Blink click (EAR-based)
Natural blinks are common and short; intentional clicks must be harder to trigger:

- Compute EAR from eye landmarks each frame.
- A blink candidate occurs when EAR < threshold for at least `min_duration_ms`.
- Default pattern (recommended): **double blink**:
  - Require two qualifying blinks within `double_blink_window_ms` (e.g., 500 ms) to click.
- Reject if face tracking confidence is low.
- Optional: require “stable gaze” for blink-click (cursor speed below threshold) to reduce accidental
  click when scanning.

### Performance budgets (must maintain 20+ FPS)

Budgets are per-frame targets; sum should be comfortably below 50 ms on baseline hardware:

- `video_capture`: 20–30 ms
- `face_landmark_detection`: 15–25 ms
- `gaze_estimation`: 15–20 ms
- `calibration_system` mapping: < 1 ms
- `kalman_filter`: < 1 ms
- `click_detection`: < 2 ms
- `cursor_controller`: < 10–15 ms

If budgets are not met:
- Reduce frame resolution
- Skip gaze inference every other frame (hold last gaze; still smooth and move cursor every frame)
- Consider GPU inference where available

---

## Cross-platform cursor movement (Windows/macOS/Linux)

### Backend interface
Cursor injection MUST be isolated behind a backend interface to avoid OS-specific coupling.

### Libraries and tradeoffs

- **`pyautogui`**
  - **Pros**: easiest to use; cross-platform; good for MVP.
  - **Cons**: may be slower; can be blocked by OS permissions; less fine-grained control.
  - **Notes**:
    - macOS requires Accessibility permissions for cursor control.
    - Linux may depend on X11; Wayland environments can be problematic.

- **`pynput`**
  - **Pros**: lower-level event control; good for keyboard/mouse hooking too.
  - **Cons**: platform backends vary; may have permissions/security friction.

**Recommendation (v1)**: start with `pyautogui` behind an interface; add a `pynput` backend if
needed for reliability or performance.

### OS-specific considerations

- **Windows**: typically works well with `pyautogui`; ensure DPI scaling is handled (screen coords).
- **macOS**: must request Accessibility permission; handle Retina scaling carefully.
- **Linux**: X11 is easiest; Wayland may require alternative approaches or explicit documentation.

---

## Persistence

### What to persist
- Per-user `CalibrationModel` (including screen resolution and RMS error).
- App config (camera index, click settings, thresholds, mode).

### Format and safety
- Prefer JSON (or msgpack) for config; calibration may use JSON + numpy lists.
- Must handle missing/corrupt calibration by prompting recalibration.
- Do not persist raw video frames by default.

---

## Constraints & Assumptions

### User and environment constraints
- Adequate lighting and steady webcam.
- Webcam positioned near eye level, facing user.
- User can hold head relatively still for calibration.

### System constraints
- Python 3.8+ (recommend 3.10+ for ecosystem stability).
- ≥ 4 GB RAM; ≥ 1 GB free disk.
- Internet only needed for initial download of model weights.

---

## Edge Cases

- Low light / glare / occlusions (glasses reflections) → landmark loss: freeze cursor and suppress clicks.
- Rapid head movement after calibration: detect degradation and prompt recalibration.
- Camera permissions denied: fail fast with actionable message.
- FPS drops below target: automatically degrade resolution or inference frequency; always maintain safe click behavior.
- Single-monitor limitation: document; optionally add “primary monitor only” check.
- Calibration invalid after screen resolution change: detect mismatch and force recalibration.

---

## Open Questions

- **Voice interpretation**: define feature scope or remove from v1. What does “Model interpretation”
  mean in success metrics?
- **Multi-monitor support**: in/out of scope for initial milestone?
- **Preferred click mode default**: dwell only vs blink only vs both.

