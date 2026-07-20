import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SessionProvider, useSession } from "@/core/session/SessionContext";
import { CameraManager, describeCameraError } from "@/core/camera/CameraManager";
import { MediaPipeGazeEngine } from "@/core/engine/MediaPipeGazeEngine";
import type { IGazeEngine } from "@/core/engine/IGazeEngine";
import { PermissionGate } from "@/features/permissions/PermissionGate";
import { CalibrationScene } from "@/features/calibration/CalibrationScene";
import { Capsule } from "@/features/tracking/Capsule";
import { DwellCursor } from "@/features/tracking/DwellCursor";
import { OnScreenKeyboard } from "@/features/tracking/OnScreenKeyboard";
import { Tutorial } from "@/features/tracking/Tutorial";
import { ReacquiringPill } from "@/features/tracking/ReacquiringPill";
import { AdvancedView, type Diagnostics } from "@/features/diagnostics/AdvancedView";
import { AccuracyTest } from "@/features/diagnostics/AccuracyTest";
import { ConfidenceMeter } from "@/features/shared/ConfidenceMeter";
import { Toggle } from "@/features/shared/Toggle";
import { Slider } from "@/features/shared/Slider";
import { Segmented } from "@/features/shared/Segmented";
import { HelpSheet } from "@/features/shared/HelpSheet";
import { useHotkeys } from "@/features/shared/useHotkeys";
import { setClickThrough, nativeClick, dispatchAction, isTrusted,
  openAccessibilitySettings, requestAccessibility,
  nativeDragStart, nativeDragEnd, moveToMonitor, listMonitors,
  captureGazeSpace, getGazeMapping, setWindowMode, logPerf, type GazeMapping } from "@/core/system/nativeInput";
import { RadialMenu } from "@/features/tracking/RadialMenu";
import { PoseAdaptiveCorrector } from "@/core/engine/adaptation";
import { listen } from "@tauri-apps/api/event";
import { useSettings, resolveDwell, type DwellPreset, type EmptyDwellAction, type ActivationMode } from "@/store/settings";
import { playClick } from "@/core/system/sound";
import { QUALITY_THRESHOLD } from "@/core/session/machine";
import type { Profile } from "@/core/session/persistence";
import "@/styles/global.css";

// How many calibration passes (initial + weak-point refinements) before we
// accept a best-effort result instead of looping forever.
const MAX_CALIBRATION_ATTEMPTS = 3;

// Blink-activation tuning. Eyes are "closed" below this openness; a deliberate
// blink is an eyes-closed interval long enough to be intentional but short
// enough not to read as resting the eyes.
const BLINK_CLOSED = 0.18;
const BLINK_MIN_MS = 200;
const BLINK_MAX_MS = 900;
const BLINK_COOLDOWN_MS = 700; // min gap between blink-triggered clicks (anti-double-fire)

// Rolling click-vs-target drift (fraction of screen) above which we suggest a
// quick re-center. Dismissing hides the nudge for this long.
const DRIFT_NUDGE = 0.055;
const DRIFT_DISMISS_MS = 60_000;

function Inner() {
  const { state, context, send, saved, patchSaved, ready } = useSession();
  const settings = useSettings();
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [showDiag, setShowDiag] = useState(false);
  const [calibNote, setCalibNote] = useState<string | null>(null);
  const [camLive, setCamLive] = useState(false);
  const [calibConf, setCalibConf] = useState<number | null>(null);
  const [trackConf, setTrackConf] = useState<number | null>(null);
  // Gaze control of the OS cursor. Armed by default post-calibration (cursor is
  // joined to the gaze); ⌃⌥Space disarms → all control to mouse/trackpad, no fight.
  const [armed, setArmed] = useState(true);
  // Radial action menu: the normalized gaze point where it's anchored, or null.
  const [actionMenu, setActionMenu] = useState<{ nx: number; ny: number } | null>(null);
  // Effective Accessibility permission (null = unknown yet). Synthetic clicks
  // no-op when false — this is the definitive shield-vs-permission diagnostic.
  const [axTrusted, setAxTrusted] = useState<boolean | null>(null);
  // A "Ready to calibrate" gate the user must press before calibration starts.
  const [calibReady, setCalibReady] = useState(false);
  // Quick (3×3) vs full (5×5) calibration, chosen at the ready gate and kept
  // stable across any weak-point refinement pass (so point ids line up).
  const [calibMode, setCalibMode] = useState<"full" | "quick">("full");
  const calibAttemptsRef = useRef(0);
  // Gaze drag gesture: null → idle, "arming" → next commit presses & holds,
  // "dragging" → cursor emits drag events and next commit releases.
  const [dragState, setDragState] = useState<null | "arming" | "dragging">(null);
  const dragStateRef = useRef(dragState);
  dragStateRef.current = dragState;
  const [showKeyboard, setShowKeyboard] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [precision, setPrecision] = useState(false); // fine-targeting mode
  const [testing, setTesting] = useState(false);      // accuracy-test overlay
  const blinkLastFireRef = useRef(0);                 // blink cooldown guard
  // --- Utility window shell -------------------------------------------------
  // Whether the settings popover is open (the HUD must grow to fit it).
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Gaze-space → window mapping for the current window shape.
  const [mapping, setMapping] = useState<GazeMapping | null>(null);
  // True once the window has actually expanded for a gaze-anchored overlay —
  // gates rendering so overlays never draw into the small capsule for a frame.
  const [expanded, setExpanded] = useState(false);
  const needCaptureRef = useRef(true); // capture gaze space on next widget entry
  const morphSeqRef = useRef(0);       // ignore stale async morph completions
  // Idle auto-pause: last time a face was seen + drift-safe settings copy.
  const lastFaceRef = useRef(performance.now());
  const idleRef = useRef({ auto: settings.idleAutoPause, timeoutS: settings.idleTimeoutS });
  idleRef.current = { auto: settings.idleAutoPause, timeoutS: settings.idleTimeoutS };
  // Rolling gaze-drift estimate (EMA of click-vs-target residuals) → "re-center?".
  const driftEmaRef = useRef(0);
  const driftDismissedRef = useRef(0);
  const [showDriftNudge, setShowDriftNudge] = useState(false);

  const cameraRef = useRef<CameraManager | null>(null);
  const engineRef = useRef<IGazeEngine | null>(null);
  const rafRef = useRef(0);
  // Pose-adaptive drift correction + manual re-anchor capture.
  const adaptRef = useRef(new PoseAdaptiveCorrector());
  const reanchorRef = useRef(false);
  const reanchorStartRef = useRef(0);
  const reanchorSamplesRef = useRef<{ x: number; y: number }[]>([]);
  const [reanchoring, setReanchoring] = useState(false);
  const headPoseRef = useRef<{ yaw: number; pitch: number } | null>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  // Blink activation: current mode + timestamp the eyes went closed (0 = open).
  const activationRef = useRef(settings.activationMode);
  activationRef.current = settings.activationMode;
  const blinkClosedSinceRef = useRef(0);

  if (!cameraRef.current) cameraRef.current = new CameraManager();
  if (!engineRef.current) engineRef.current = new MediaPipeGazeEngine();

  useEffect(() => {
    if (ready && saved?.calibration && engineRef.current) {
      const c = saved.calibration;
      engineRef.current.setCalibration(
        c.anchors
          ? { wx: c.wx, wy: c.wy, residual: c.residual, anchors: c.anchors }
          : { wx: c.wx, wy: c.wy, residual: c.residual },
      );
    }
  }, [ready, saved?.calibration]);

  const requestPermission = useCallback(async () => {
    try {
      await cameraRef.current!.requestPermissionAndStart();
      await engineRef.current!.init();
      setCamLive(true);
      patchSaved({ permissionGranted: true });
      send({ type: "PERMISSION_GRANTED" });
    } catch (err) {
      console.error("[gaze] camera/engine init failed:", err);
      send({ type: "PERMISSION_DENIED", reason: describeCameraError(err) });
    }
  }, [patchSaved, send]);

  useEffect(() => {
    if (!ready) return;
    const live = state === "tracking" || state === "paused" || state === "reacquiring" || state === "calibrating";
    if (live && !cameraRef.current!.video.srcObject && saved?.permissionGranted) {
      void requestPermission();
    }
  }, [ready, state, saved?.permissionGranted, requestPermission]);

  useEffect(() => {
    const cam = cameraRef.current!;
    return cam.on((ev) => {
      if (ev === "interrupted") { setCamLive(false); send({ type: "CAMERA_INTERRUPTED" }); }
      if (ev === "restored") { setCamLive(true); send({ type: "CAMERA_RESTORED" }); }
    });
  }, [send]);

  useEffect(() => {
    const v = previewRef.current;
    const src = cameraRef.current!.video.srcObject;
    if (v && src) { v.srcObject = src; void v.play().catch(() => {}); }
  }, [state, settings.cameraPreview, camLive]);

  useEffect(() => {
    // The accuracy test drives its own estimate loop; only one may run at a time
    // (MediaPipe needs monotonic timestamps), so pause the tracking loop then.
    if (testing || (state !== "tracking" && state !== "reacquiring")) {
      cancelAnimationFrame(rafRef.current);
      return;
    }
    const engine = engineRef.current!;
    const video = cameraRef.current!.video;
    let lastGood = performance.now();
    let lastVideoTime = -1;
    let lastInferAt = 0;
    let lastUi = 0;
    let frames = 0, fpsT = performance.now(), fps = 0;
    const HOLD_MS = 160;
    // Gaze-stability confidence: how sure we are you're fixating a *point*.
    const recent: { x: number; y: number; t: number }[] = [];
    const STAB_WINDOW = 300, SPREAD_REF = 0.05;
    let emaConf = 0;

    const loop = () => {
      const now = performance.now();
      // Spec §D: gate inference on the camera producing a new frame AND cap it
      // at ~30/s — telemetry showed a 60fps camera driving 13ms inferences 60×/s
      // (~80% of the main thread), the root cause of app-wide lag.
      const vt = video.currentTime;
      if (vt === lastVideoTime || now - lastInferAt < 30) { rafRef.current = requestAnimationFrame(loop); return; }
      lastVideoTime = vt;
      lastInferAt = now;
      const frame = engine.estimate(video, now);
      frames++;
      if (now - fpsT > 500) { fps = (frames * 1000) / (now - fpsT); frames = 0; fpsT = now; }

      // Face-seen tracking for idle auto-pause.
      if (frame.status !== "no_face") lastFaceRef.current = now;

      // Blink / wink activation: a deliberate eyes-closed interval emits a
      // trigger the DwellCursor turns into a click at the current gaze.
      if (activationRef.current === "blink" && frame.eyeOpenness) {
        const openMin = Math.min(frame.eyeOpenness.left, frame.eyeOpenness.right);
        const closed = openMin < BLINK_CLOSED;
        if (closed && !blinkClosedSinceRef.current) blinkClosedSinceRef.current = now;
        else if (!closed && blinkClosedSinceRef.current) {
          const dur = now - blinkClosedSinceRef.current;
          blinkClosedSinceRef.current = 0;
          if (dur >= BLINK_MIN_MS && dur <= BLINK_MAX_MS && now - blinkLastFireRef.current > BLINK_COOLDOWN_MS) {
            blinkLastFireRef.current = now;
            window.dispatchEvent(new CustomEvent("gaze:trigger"));
          }
        }
      } else if (blinkClosedSinceRef.current) {
        blinkClosedSinceRef.current = 0;
      }

      // Gaze-stability confidence (how sure we are you're fixating a point) AND
      // damped-fixation stabilization (kills rest jitter without a deadband):
      // when the estimate is steady we output the window average (rock-still);
      // when it's moving we pass the responsive smoothed point through. A slow
      // deliberate move still gets through — it shifts the average — so small
      // movements aren't blocked.
      let gazeConf = 0;
      if (frame.point) {
        recent.push({ x: frame.point.x, y: frame.point.y, t: now });
        while (recent.length && now - recent[0]!.t > STAB_WINDOW) recent.shift();
        const cx = recent.reduce((s, p) => s + p.x, 0) / recent.length;
        const cy = recent.reduce((s, p) => s + p.y, 0) / recent.length;
        const spread = recent.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / recent.length;
        const stability = Math.max(0, Math.min(1, 1 - spread / SPREAD_REF));
        const seen = Math.max(0, Math.min(1, frame.confidence / 0.6));
        gazeConf = stability * seen;

        // The engine's adaptive-predictive filter now does smoothing + fixation
        // lock, so pass its point straight through (no double-smoothing here).
        const out = { x: frame.point.x, y: frame.point.y };

        // Manual re-anchor capture: while the user fixates the center dot, sample
        // the PRE-correction gaze to measure current drift, then store a strong
        // pose-keyed correction so the mapping re-centers for this head posture.
        if (reanchorRef.current) {
          if (now - reanchorStartRef.current > 600) reanchorSamplesRef.current.push({ x: out.x, y: out.y });
          if (reanchorSamplesRef.current.length >= 30) {
            const s = reanchorSamplesRef.current;
            const avg = { x: s.reduce((a, q) => a + q.x, 0) / s.length, y: s.reduce((a, q) => a + q.y, 0) / s.length };
            adaptRef.current.reanchor(avg, { x: 0.5, y: 0.5 }, frame.headPose ?? null);
            reanchorRef.current = false; reanchorSamplesRef.current = [];
            driftEmaRef.current = 0; setShowDriftNudge(false);
            setReanchoring(false);
          }
        }

        // Pose-adaptive drift correction: shift by the correction learned for the
        // current head pose, so accuracy holds as the head deviates from calibration.
        headPoseRef.current = frame.headPose ?? null;
        const adapted = adaptRef.current.apply(out, frame.headPose ?? null);
        window.dispatchEvent(new CustomEvent("gaze:point", { detail: adapted }));
      } else {
        recent.length = 0;
      }
      if (frame.rawPoint) window.dispatchEvent(new CustomEvent("gaze:raw", { detail: frame.rawPoint }));
      emaConf += 0.2 * (gazeConf - emaConf);

      const good = frame.status === "ok" && frame.confidence >= 0.45 && frame.point;
      if (good && frame.point) {
        lastGood = now;
        if (stateRef.current === "reacquiring") {
          engine.reseedSmoothing(frame.point.x, frame.point.y, now);
          send({ type: "CONFIDENCE_RECOVERED" });
        }
      } else if (now - lastGood > HOLD_MS && stateRef.current === "tracking") {
        send({ type: "CONFIDENCE_LOST" });
      }

      // Spec §D: per-frame confidence/diagnostics must NOT re-render the whole
      // app tree — throttle these top-level state updates to ~10Hz. The
      // gaze:point event above (which drives the cursor) still fires per frame.
      if (now - lastUi > 90) {
        lastUi = now;
        setTrackConf(emaConf);
        setDiag({
          confidence: frame.confidence, factors: frame.factors, quality: context.quality, fps,
          headPose: frame.headPose, engine: engine.capabilities.name,
        });
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [state, send, context.quality, testing]);

  useHotkeys(useMemo(() => ({
    onRecalibrate: () => send({ type: "START_RECALIBRATION", weakPointIds: [] }),
    onPauseToggle: () => send({ type: stateRef.current === "paused" ? "RESUME" : "PAUSE" }),
    onToggleDiagnostics: () => setShowDiag((s) => !s),
  }), [send]));

  // Make the OS window background transparent while in widget (post-calibration)
  // mode, opaque otherwise (boot / permissions / calibration).
  const widgetMode = state === "tracking" || state === "paused" || state === "reacquiring";
  useEffect(() => {
    document.body.classList.toggle("widget", widgetMode);
    return () => document.body.classList.remove("widget");
  }, [widgetMode]);

  // Whether the first-run tutorial wants the screen.
  const tutorialVisible = state === "tracking" && !settings.hasSeenTutorial &&
    !showKeyboard && !actionMenu && !showHelp && !dragState && !testing;
  // Gaze-anchored overlays that need the window expanded to the full gaze space.
  const overlayOpen = widgetMode && (!!actionMenu || showKeyboard || showHelp || testing ||
    reanchoring || settingsOpen || tutorialVisible);

  // --- Utility window shell: morph the real OS window between its shapes -----
  // full (calibration/onboarding) ⇄ capsule HUD (tracking) ⇄ expanded (overlay).
  // The gaze space is captured ONCE per widget entry, while the window still
  // spans the calibrated screen, so gaze math survives the shrink.
  useEffect(() => {
    const seq = ++morphSeqRef.current;
    void (async () => {
      if (!widgetMode) {
        needCaptureRef.current = true;
        setMapping(null);
        setExpanded(false);
        await setWindowMode("full");
        return;
      }
      if (needCaptureRef.current) {
        await captureGazeSpace();
        needCaptureRef.current = false;
      }
      await setWindowMode(overlayOpen ? "expanded" : "capsule");
      if (morphSeqRef.current !== seq) return; // superseded by a newer morph
      setMapping(await getGazeMapping());
      setExpanded(overlayOpen);
    })();
  }, [widgetMode, overlayOpen]);

  // Click-through policy for the morphing window:
  //  - capsule HUD: NOT click-through (its buttons take real mouse clicks; it's
  //    tiny, so it can't shield the desktop).
  //  - expanded overlay: click-through (a transparent full-screen window that
  //    isn't click-through silently swallows every click and freezes the
  //    desktop), re-asserted on an interval so it can never stick. The opaque
  //    accuracy-test view is the exception — it must capture clicks.
  useEffect(() => {
    const on = widgetMode && overlayOpen && !testing;
    void setClickThrough(on);
    const t = window.setTimeout(() => void setClickThrough(on), 300);
    if (!on) return () => window.clearTimeout(t);
    const iv = window.setInterval(() => void setClickThrough(true), 1000);
    const onFocus = () => void setClickThrough(true);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearTimeout(t);
      window.clearInterval(iv);
      window.removeEventListener("focus", onFocus);
    };
  }, [widgetMode, overlayOpen, testing]);

  // Require a "Ready" press before each calibration run.
  useEffect(() => { if (state === "calibrating") setCalibReady(false); }, [state]);

  // ⌃⌥Space (global shortcut, emitted from Rust) arms/disarms gaze control.
  useEffect(() => {
    const un = listen("gaze:toggle-armed", () => setArmed((a) => !a));
    return () => { void un.then((f) => f()); };
  }, []);

  // ⌃⌥P (global shortcut) pauses/resumes — a keyboard escape that always works
  // even if the control bar can't be reached.
  useEffect(() => {
    const un = listen("gaze:toggle-pause", () =>
      send({ type: stateRef.current === "paused" ? "RESUME" : "PAUSE" }));
    return () => { void un.then((f) => f()); };
  }, [send]);

  // Quick re-anchor: look at the center dot ~1s to re-center the mapping for the
  // current head posture (fixes accumulated drift without a full recalibration).
  const startReanchor = useCallback(() => {
    reanchorRef.current = true;
    reanchorStartRef.current = performance.now();
    reanchorSamplesRef.current = [];
    setReanchoring(true);
    setShowDriftNudge(false);
  }, []);

  // ⌃⌥R (global shortcut) triggers the same re-anchor.
  useEffect(() => {
    const un = listen("gaze:reanchor", () => startReanchor());
    return () => { void un.then((f) => f()); };
  }, [startReanchor]);

  // Track click-vs-target drift and feed the self-healing corrector; when drift
  // stays high, surface a gentle "re-center?" nudge.
  const handleCalibrate = useCallback((gaze: { x: number; y: number }, target: { x: number; y: number }) => {
    adaptRef.current.observe(gaze, target, headPoseRef.current);
    const d = Math.hypot(target.x - gaze.x, target.y - gaze.y);
    driftEmaRef.current = driftEmaRef.current === 0 ? d : driftEmaRef.current + 0.25 * (d - driftEmaRef.current);
    if (driftEmaRef.current > DRIFT_NUDGE && performance.now() > driftDismissedRef.current)
      setShowDriftNudge(true);
  }, []);

  // Idle auto-pause: if no face for the configured timeout while tracking, pause.
  useEffect(() => {
    const iv = window.setInterval(() => {
      if (!idleRef.current.auto) return;
      const s = stateRef.current;
      if (s !== "tracking" && s !== "reacquiring") return;
      if (performance.now() - lastFaceRef.current > idleRef.current.timeoutS * 1000)
        send({ type: "PAUSE" });
    }, 2000);
    return () => window.clearInterval(iv);
  }, [send]);

  // ⌃⌥Return — "switch" click: emit a trigger the DwellCursor turns into a click
  // at the current gaze (for switch activation mode / an external switch).
  useEffect(() => {
    const un = listen("gaze:switch-click", () => window.dispatchEvent(new CustomEvent("gaze:trigger")));
    return () => { void un.then((f) => f()); };
  }, []);

  // Menu-bar "Recalibrate…" — Rust shows the window first, then emits this.
  useEffect(() => {
    const un = listen("gaze:recalibrate", () => {
      setCalibReady(false);
      send({ type: "START_RECALIBRATION", weakPointIds: [] });
    });
    return () => { void un.then((f) => f()); };
  }, [send]);

  // Closing (hiding) the main window force-pauses tracking: a hidden webview's
  // RAF loop throttles to a halt, so gaze control would silently die otherwise.
  // Explicit PAUSE keeps the state honest; reopen via the menu bar and resume.
  useEffect(() => {
    const un = listen("gaze:force-pause", () => send({ type: "PAUSE" }));
    return () => { void un.then((f) => f()); };
  }, [send]);

  // Pipe calibration perf telemetry to the terminal (diagnosable lag reports).
  useEffect(() => {
    const onPerf = (e: Event) => logPerf((e as CustomEvent<string>).detail);
    window.addEventListener("gaze:perf", onPerf as EventListener);
    return () => window.removeEventListener("gaze:perf", onPerf as EventListener);
  }, []);

  // ⌃⌥K — toggle the hands-free on-screen keyboard (only while tracking).
  useEffect(() => {
    const un = listen("gaze:toggle-keyboard", () => {
      if (stateRef.current === "tracking") setShowKeyboard((v) => !v);
    });
    return () => { void un.then((f) => f()); };
  }, []);

  // ⌃⌥Z — toggle precision (fine-targeting) mode.
  useEffect(() => {
    const un = listen("gaze:toggle-precision", () => setPrecision((v) => !v));
    return () => { void un.then((f) => f()); };
  }, []);

  // ⌃⌥T — toggle the objective accuracy test (also the hands-free way to close
  // it, since the dwell cursor is suspended while it drives its own loop).
  useEffect(() => {
    const un = listen("gaze:accuracy-test", () => {
      const s = stateRef.current;
      setTesting((t) => t ? false : (s === "tracking" || s === "paused" || s === "reacquiring"));
    });
    return () => { void un.then((f) => f()); };
  }, []);

  // Escape also closes the accuracy test.
  useEffect(() => {
    if (!testing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setTesting(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [testing]);

  // A gaze-drag can only run while actively tracking; cancel it if we leave.
  useEffect(() => {
    if (dragState && state !== "tracking") setDragState(null);
  }, [state, dragState]);

  // Gaze-drag step: first commit presses & holds; the next releases.
  const handleDragCommit = useCallback((aim: { x: number; y: number }) => {
    if (dragStateRef.current === "arming") { nativeDragStart(aim.x, aim.y); setDragState("dragging"); }
    else if (dragStateRef.current === "dragging") { nativeDragEnd(aim.x, aim.y); setDragState(null); }
  }, []);

  // Move the overlay to another display, then recalibrate (mapping is screen-
  // relative, so a different display needs a fresh calibration).
  const switchMonitor = useCallback(async (index: number) => {
    await moveToMonitor(index);
    setCalibReady(false);
    send({ type: "START_RECALIBRATION", weakPointIds: [] });
  }, [send]);

  // --- Calibration profiles -------------------------------------------------
  const profiles: Profile[] = saved?.profiles
    ?? (saved?.calibration ? [{ name: saved.activeProfile ?? "Default", calibration: saved.calibration }]
      : [{ name: "Default", calibration: null }]);
  const activeProfile = saved?.activeProfile ?? profiles[0]?.name ?? "Default";

  // Migrate a pre-profiles session to a single "Default" profile, once.
  useEffect(() => {
    if (!ready || !saved || saved.profiles) return;
    patchSaved({
      profiles: saved.calibration ? [{ name: "Default", calibration: saved.calibration }] : [{ name: "Default", calibration: null }],
      activeProfile: "Default",
    });
  }, [ready, saved]);

  const applyEngineCalibration = useCallback((c: Profile["calibration"]) => {
    if (!c || !engineRef.current) return;
    engineRef.current.setCalibration(
      c.anchors ? { wx: c.wx, wy: c.wy, residual: c.residual, anchors: c.anchors }
        : { wx: c.wx, wy: c.wy, residual: c.residual });
  }, []);

  const switchProfile = useCallback((name: string) => {
    const p = (saved?.profiles ?? profiles).find((x) => x.name === name);
    if (!p || name === activeProfile) return;
    adaptRef.current.reset();
    calibAttemptsRef.current = 0;
    patchSaved({ activeProfile: name, calibration: p.calibration });
    if (p.calibration && p.calibration.quality >= QUALITY_THRESHOLD) {
      applyEngineCalibration(p.calibration);
      if (stateRef.current === "calibrating") send({ type: "CALIBRATION_COMPLETE", quality: p.calibration.quality });
    } else {
      setCalibReady(false);
      send({ type: "START_RECALIBRATION", weakPointIds: [] });
    }
  }, [saved, profiles, activeProfile, patchSaved, send, applyEngineCalibration]);

  const newProfile = useCallback(() => {
    const list = saved?.profiles ?? profiles;
    let n = list.length + 1, name = `Profile ${n}`;
    while (list.some((p) => p.name === name)) { n++; name = `Profile ${n}`; }
    adaptRef.current.reset();
    calibAttemptsRef.current = 0;
    patchSaved({ profiles: [...list, { name, calibration: null }], activeProfile: name, calibration: null });
    setCalibReady(false);
    send({ type: "START_RECALIBRATION", weakPointIds: [] });
  }, [saved, profiles, patchSaved, send]);

  const deleteProfile = useCallback((name: string) => {
    const list = saved?.profiles ?? profiles;
    if (list.length <= 1 || name === activeProfile) return;
    patchSaved({ profiles: list.filter((p) => p.name !== name) });
  }, [saved, profiles, activeProfile, patchSaved]);

  // Auto-dismiss the radial action menu if it's left untouched for a few seconds.
  useEffect(() => {
    if (!actionMenu) return;
    const t = window.setTimeout(() => setActionMenu(null), 5000);
    return () => window.clearTimeout(t);
  }, [actionMenu]);

  // Poll effective Accessibility permission so we can SEE whether synthetic
  // clicks can land, instead of guessing (shield vs permission).
  useEffect(() => {
    let alive = true;
    const check = () => { void isTrusted().then((t) => { if (alive) setAxTrusted(t); }); };
    check();
    const iv = window.setInterval(check, 2000);
    return () => { alive = false; window.clearInterval(iv); };
  }, []);

  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current);
    engineRef.current?.dispose();
    cameraRef.current?.stop();
  }, []);

  if (!ready) return <Boot />;

  const showCapsule = state === "tracking" || state === "reacquiring" || state === "paused";
  const live = state === "calibrating" || state === "tracking" || state === "reacquiring";
  // Calibration meter = collection quality; tracking meter = gaze-lock confidence.
  const meterValue = state === "calibrating" ? calibConf : trackConf;
  // After calibration the app becomes a transparent always-on-top widget overlay
  // rather than an opaque window.
  const isWidget = state === "tracking" || state === "paused" || state === "reacquiring";
  const dwell = resolveDwell(settings);
  // Actionable reason tracking was lost, from the latest confidence factors.
  const reacquireReason = (() => {
    const f = diag?.factors;
    if (!f) return "Move back into the camera's view";
    if (f.face < 0.6) return "Move closer / back into frame";
    if (f.openness < 0.6) return "Open your eyes and look at the screen";
    if (f.pose < 0.62) return "Face the screen — head upright";
    return "Reacquiring your gaze…";
  })();

  return (
    <div style={{ position: "absolute", inset: 0, background: isWidget ? "transparent" : "var(--bg)" }}>
      {isWidget && (
        <DwellCursor active={isWidget && !testing} armed={armed && state === "tracking" && !testing}
          confidence={trackConf} onNativeClick={nativeClick}
          dwellMs={dwell.dwellMs} freeDwellMs={dwell.freeDwellMs} cooldownMs={settings.cooldownMs}
          emptyDwellAction={settings.emptyDwellAction}
          edgeScroll={settings.edgeScroll} scrollSpeed={settings.scrollSpeed}
          snapStrength={settings.snapStrength} stabilityTolerance={settings.stabilityTolerance}
          activationMode={settings.activationMode}
          dragPhase={dragState} onDragCommit={handleDragCommit}
          precision={precision}
          onClickSound={() => { if (settings.soundOnClick) playClick(settings.soundVolume); }}
          menuOpen={!!actionMenu}
          onRequestMenu={(nx, ny) => setActionMenu({ nx, ny })}
          mapping={mapping}
          onCalibrate={handleCalibrate} />
      )}
      {dragState && <DragBanner phase={dragState} />}
      {precision && !dragState && (
        <div style={{ position: "fixed", top: 44, left: "50%", transform: "translateX(-50%)", zIndex: 74,
          pointerEvents: "none", fontSize: 12, fontWeight: 600, color: "#083344",
          padding: "5px 14px", borderRadius: 999, backdropFilter: "blur(8px)",
          background: "rgba(34,211,238,0.92)" }}>
          ⊹ Precision mode — ⌃⌥Z to exit
        </div>
      )}
      {testing && expanded && camLive && engineRef.current && cameraRef.current && (
        <AccuracyTest engine={engineRef.current} video={cameraRef.current.video} onClose={() => setTesting(false)} />
      )}
      {showDriftNudge && state === "tracking" && !reanchoring && !dragState && (
        <DriftNudge onRecenter={startReanchor}
          onDismiss={() => { setShowDriftNudge(false); driftDismissedRef.current = performance.now() + DRIFT_DISMISS_MS; }} />
      )}
      {showHelp && expanded && <HelpSheet onClose={() => setShowHelp(false)} />}
      {tutorialVisible && expanded && (
        <Tutorial onDone={() => settings.set({ hasSeenTutorial: true })} />
      )}
      {isWidget && showKeyboard && expanded && (
        <OnScreenKeyboard onClose={() => setShowKeyboard(false)}
          onKeyFeedback={() => { if (settings.soundOnClick) playClick(settings.soundVolume); }} />
      )}
      {actionMenu && expanded && (
        <RadialMenu
          center={{ x: actionMenu.nx * window.innerWidth, y: actionMenu.ny * window.innerHeight }}
          onSelect={(action) => {
            if (action === "drag") { setDragState("arming"); setActionMenu(null); return; }
            dispatchAction(action, actionMenu.nx, actionMenu.ny);
            if (settings.soundOnClick) playClick(settings.soundVolume);
            setActionMenu(null);
          }}
          onCancel={() => setActionMenu(null)} />
      )}
      {isWidget && axTrusted === true && (
        <div style={{ position: "fixed", top: 8, left: "50%", transform: "translateX(-50%)",
          zIndex: 70, pointerEvents: "none", fontSize: 11, fontWeight: 600,
          padding: "3px 12px", borderRadius: 999, color: "#fff", backdropFilter: "blur(8px)",
          background: "rgba(16,120,60,0.85)" }}>
          Accessibility ✓ — clicks can land
        </div>
      )}
      {isWidget && axTrusted === false && <AccessibilityBanner />}
      {reanchoring && expanded && (
        <div style={{ position: "fixed", inset: 0, zIndex: 80, pointerEvents: "none",
          display: "grid", placeItems: "center", gap: 14 }}>
          <div style={{ width: 22, height: 22, borderRadius: 999, background: "var(--accent, #3c82f6)",
            boxShadow: "0 0 0 6px rgba(60,130,246,0.22), 0 0 26px rgba(60,130,246,0.6)" }} />
          <div style={{ fontSize: 13, fontWeight: 600, color: "#fff", background: "rgba(0,0,0,0.6)",
            padding: "5px 14px", borderRadius: 999, backdropFilter: "blur(8px)" }}>
            Look at the dot to re-center…
          </div>
        </div>
      )}
      {live && <ConfidenceMeter value={meterValue} />}

      {/* Soft full-screen calibration backdrop only (no bottom-left mini feed).
          NO blur filter: a full-screen live-video blur re-renders on the GPU
          every frame — exactly the GPU headroom MediaPipe inference needs, and
          a direct cause of a stuttering calibration dot. Dim opacity alone
          keeps the soft look. */}
      {settings.cameraPreview && state === "calibrating" && (
        <video ref={previewRef} muted playsInline
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover",
            opacity: 0.16, transform: "scaleX(-1)",
            transition: "opacity var(--dur-slow) var(--ease-soft)" }} />
      )}

      {state === "permissions" && <PermissionGate error={context.error} onRequest={requestPermission} />}

      {state === "calibrating" && !calibReady && (
        <ReadyGate weak={context.weakPointIds.length > 0}
          engine={engineRef.current} video={cameraRef.current?.video ?? null} camLive={camLive}
          onStart={(mode) => { if (context.weakPointIds.length === 0) setCalibMode(mode); setCalibReady(true); }} />
      )}

      {state === "calibrating" && calibReady && engineRef.current && (
        <CalibrationScene
          engine={engineRef.current}
          video={cameraRef.current!.video}
          weakPointIds={context.weakPointIds}
          note={calibNote}
          quick={calibMode === "quick"}
          onConfidence={setCalibConf}
          onComplete={(model, quality, weak) => {
            engineRef.current!.setCalibration(model);
            const calib = { ...model, quality, savedAt: Date.now() };
            patchSaved({
              calibration: calib,
              profiles: (saved?.profiles ?? profiles).map((p) => p.name === activeProfile ? { ...p, calibration: calib } : p),
              activeProfile,
              pauseOnStartup: settings.pauseOnStartup,
            });
            const attempt = ++calibAttemptsRef.current;
            const pct = Math.round(quality * 100);
            console.info(`[gaze] calibration attempt ${attempt}: quality=${pct}%, weak=${weak.length}`);

            if (quality >= QUALITY_THRESHOLD) {
              calibAttemptsRef.current = 0;
              setCalibNote(null);
              send({ type: "CALIBRATION_COMPLETE", quality });
            } else if (weak.length && attempt < MAX_CALIBRATION_ATTEMPTS) {
              setCalibNote(`Quality ${pct}% — refining ${weak.length} weak point${weak.length > 1 ? "s" : ""}…`);
              send({ type: "CALIBRATION_FAILED", weakPointIds: weak });
            } else {
              // Best-effort: accept a sub-threshold calibration rather than trap
              // the user in an endless retry. Tracking runs in a lower-confidence
              // mode; the diagnostic explains why.
              console.warn(`[gaze] accepting best-effort calibration at ${pct}% after ${attempt} attempt(s)`);
              calibAttemptsRef.current = 0;
              setCalibNote(null);
              send({ type: "CALIBRATION_COMPLETE", quality });
            }
          }}
        />
      )}

      {state === "reacquiring" && <ReacquiringPill reason={reacquireReason} />}
      {showDiag && diag && <AdvancedView d={diag} onClose={() => setShowDiag(false)} />}

      {showCapsule && (
        <Capsule
          state={state}
          side={settings.controlSide}
          armed={armed}
          onPauseToggle={() => send({ type: state === "paused" ? "RESUME" : "PAUSE" })}
          onRecalibrate={() => send({ type: "START_RECALIBRATION", weakPointIds: [] })}
          onSettingsToggle={setSettingsOpen}
          settingsSlot={<SettingsPanel onToggleDiagnostics={() => setShowDiag((s) => !s)} showDiag={showDiag}
            onShowKeyboard={() => setShowKeyboard(true)} onSwitchMonitor={switchMonitor}
            onShowHelp={() => setShowHelp(true)}
            profiles={profiles} activeProfile={activeProfile}
            onSwitchProfile={switchProfile} onNewProfile={newProfile} onDeleteProfile={deleteProfile} />}
        />
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h4 style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em",
      color: "var(--text-3)", margin: "var(--s-3) 0 2px" }}>{children}</h4>
  );
}

function SettingsPanel({ onToggleDiagnostics, showDiag, onShowKeyboard, onSwitchMonitor, onShowHelp,
  profiles, activeProfile, onSwitchProfile, onNewProfile, onDeleteProfile }:
  { onToggleDiagnostics: () => void; showDiag: boolean; onShowKeyboard: () => void;
    onSwitchMonitor: (index: number) => void; onShowHelp: () => void;
    profiles: Profile[]; activeProfile: string;
    onSwitchProfile: (name: string) => void; onNewProfile: () => void; onDeleteProfile: (name: string) => void }) {
  const s = useSettings();
  return (
    <div style={{ maxHeight: "62vh", overflowY: "auto", paddingRight: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--s-1)" }}>
        <h3 style={{ fontSize: 14 }}>Settings</h3>
        <button data-dwell onClick={onShowHelp}
          style={{ fontSize: 11.5, fontWeight: 600, padding: "3px 10px", borderRadius: 999,
            background: "var(--accent-soft)", color: "var(--accent)" }}>? Help</button>
      </div>

      <SectionLabel>Profiles</SectionLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "4px 0 2px" }}>
        {profiles.map((p) => {
          const active = p.name === activeProfile;
          return (
            <span key={p.name} style={{ display: "inline-flex", alignItems: "center", gap: 4,
              padding: "4px 4px 4px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600,
              background: active ? "var(--accent)" : "var(--accent-soft)", color: active ? "#fff" : "var(--text-2)" }}>
              <button data-dwell onClick={() => onSwitchProfile(p.name)}
                style={{ color: "inherit", fontSize: 12, fontWeight: 600 }}>
                {p.name}{p.calibration ? "" : " ·"}
              </button>
              {!active && profiles.length > 1 && (
                <button data-dwell aria-label={`Delete ${p.name}`} onClick={() => onDeleteProfile(p.name)}
                  style={{ width: 16, height: 16, borderRadius: 999, fontSize: 11, lineHeight: 1,
                    background: "rgba(0,0,0,0.15)", color: "inherit" }}>✕</button>
              )}
            </span>
          );
        })}
        <button data-dwell onClick={onNewProfile}
          style={{ padding: "4px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600,
            background: "var(--accent-soft)", color: "var(--accent)" }}>+ New</button>
      </div>

      <SectionLabel>Activation</SectionLabel>
      <Segmented<ActivationMode> label="Trigger" value={s.activationMode}
        options={[{ value: "dwell", label: "Dwell" }, { value: "blink", label: "Blink" }, { value: "switch", label: "Switch" }]}
        onChange={(v) => s.set({ activationMode: v })} />

      <SectionLabel>Dwell timing</SectionLabel>
      <Segmented<DwellPreset> label="Dwell speed" value={s.dwellPreset}
        options={[{ value: "relaxed", label: "Relaxed" }, { value: "normal", label: "Normal" }, { value: "fast", label: "Fast" }, { value: "custom", label: "Custom" }]}
        onChange={(v) => s.set({ dwellPreset: v })} />
      {s.dwellPreset === "custom" && (
        <>
          <Slider label="Control dwell" value={s.dwellMs} min={400} max={2000} step={50}
            onChange={(v) => s.set({ dwellMs: v })} format={(v) => `${v} ms`} />
          <Slider label="Empty-space dwell" value={s.freeDwellMs} min={600} max={2600} step={50}
            onChange={(v) => s.set({ freeDwellMs: v })} format={(v) => `${v} ms`} />
        </>
      )}
      <Slider label="Click cooldown" value={s.cooldownMs} min={250} max={1500} step={50}
        onChange={(v) => s.set({ cooldownMs: v })} format={(v) => `${v} ms`} />

      <SectionLabel>Interaction</SectionLabel>
      <Segmented<EmptyDwellAction> label="Empty-space dwell" value={s.emptyDwellAction}
        options={[{ value: "click", label: "Click" }, { value: "menu", label: "Action wheel" }]}
        onChange={(v) => s.set({ emptyDwellAction: v })} />
      <Slider label="Stability tolerance" value={s.stabilityTolerance} min={0.5} max={2} step={0.1}
        onChange={(v) => s.set({ stabilityTolerance: v })} format={(v) => `${v.toFixed(1)}×`} />
      <Slider label="Magnetic snap" value={s.snapStrength} min={0} max={1.5} step={0.1}
        onChange={(v) => s.set({ snapStrength: v })} format={(v) => (v === 0 ? "Off" : `${v.toFixed(1)}×`)} />

      <SectionLabel>Scrolling &amp; sound</SectionLabel>
      <Toggle label="Edge-gaze scrolling" checked={s.edgeScroll} onChange={(v) => s.set({ edgeScroll: v })} />
      {s.edgeScroll && (
        <Slider label="Scroll speed" value={s.scrollSpeed} min={0.25} max={2.5} step={0.25}
          onChange={(v) => s.set({ scrollSpeed: v })} format={(v) => `${v.toFixed(2)}×`} />
      )}
      <Toggle label="Click sound" checked={s.soundOnClick} onChange={(v) => s.set({ soundOnClick: v })} />
      {s.soundOnClick && (
        <Slider label="Volume" value={s.soundVolume} min={0} max={1} step={0.1}
          onChange={(v) => s.set({ soundVolume: v })} format={(v) => `${Math.round(v * 100)}%`} />
      )}

      <SectionLabel>System</SectionLabel>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0" }}>
        <span style={{ fontSize: 13.5 }}>On-screen keyboard</span>
        <button data-dwell onClick={onShowKeyboard}
          style={{ padding: "5px 12px", borderRadius: 999, fontSize: 12, fontWeight: 600,
            background: "var(--accent-soft)", color: "var(--accent)" }}>Open ⌃⌥K</button>
      </div>
      <MonitorPicker onSwitch={onSwitchMonitor} />

      <SectionLabel>Display</SectionLabel>
      <Toggle label="Camera preview" checked={s.cameraPreview} onChange={(v) => s.set({ cameraPreview: v })} />
      <Toggle label="Pause on startup" checked={s.pauseOnStartup} onChange={(v) => s.set({ pauseOnStartup: v })} />
      <Toggle label="Auto-launch calibration" checked={s.autoLaunchCalibration} onChange={(v) => s.set({ autoLaunchCalibration: v })} />
      <div style={{ display: "flex", padding: "9px 0", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 13.5 }}>Control bar position</span>
        <div style={{ display: "flex", gap: 4 }}>
          {(["left", "center", "right"] as const).map((p) => (
            <button key={p} onClick={() => s.set({ controlSide: p })}
              style={{ padding: "4px 8px", borderRadius: 8, fontSize: 11.5,
                background: s.controlSide === p ? "var(--accent)" : "var(--accent-soft)",
                color: s.controlSide === p ? "#fff" : "var(--text-2)" }}>{p[0]!.toUpperCase()}</button>
          ))}
        </div>
      </div>
      <div style={{ borderTop: "1px solid var(--stroke)", marginTop: 6, paddingTop: 6 }}>
        <Toggle label="Advanced diagnostics" checked={showDiag} onChange={onToggleDiagnostics} />
      </div>
    </div>
  );
}

/** Interactive prompt shown when synthetic clicks can't land because macOS
 * Accessibility permission is missing (commonly dropped after a rebuild). The
 * buttons open the settings pane and re-request the grant; both are dwell-
 * operable (data-dwell). */
function AccessibilityBanner() {
  const pill: React.CSSProperties = { padding: "5px 12px", borderRadius: 999, fontSize: 12, fontWeight: 600 };
  return (
    <div style={{ position: "fixed", top: 8, left: "50%", transform: "translateX(-50%)",
      zIndex: 70, pointerEvents: "auto", display: "flex", alignItems: "center", gap: 10,
      fontSize: 12, fontWeight: 600, color: "#fff", padding: "6px 8px 6px 14px",
      borderRadius: 999, backdropFilter: "blur(8px)", background: "rgba(160,32,32,0.94)" }}>
      <span>Accessibility off — clicks won't land</span>
      <button data-dwell onClick={() => void openAccessibilitySettings()}
        style={{ ...pill, background: "rgba(255,255,255,0.95)", color: "#7a1010" }}>Open settings</button>
      <button data-dwell onClick={() => void requestAccessibility()}
        style={{ ...pill, background: "rgba(255,255,255,0.25)", color: "#fff" }}>Re-request</button>
    </div>
  );
}

/** Gentle, dismissible prompt when gaze tracking appears to have drifted. */
function DriftNudge({ onRecenter, onDismiss }: { onRecenter: () => void; onDismiss: () => void }) {
  const pill: React.CSSProperties = { padding: "5px 12px", borderRadius: 999, fontSize: 12, fontWeight: 600 };
  return (
    <div style={{ position: "fixed", top: 44, left: "50%", transform: "translateX(-50%)", zIndex: 74,
      display: "flex", alignItems: "center", gap: 10, pointerEvents: "auto", color: "#fff",
      padding: "6px 8px 6px 14px", borderRadius: 999, backdropFilter: "blur(8px)",
      background: "rgba(180,120,20,0.94)", fontSize: 12, fontWeight: 600 }}>
      <span>Tracking may have drifted</span>
      <button data-dwell onClick={onRecenter} style={{ ...pill, background: "rgba(255,255,255,0.95)", color: "#7a5210" }}>Re-center</button>
      <button data-dwell onClick={onDismiss} style={{ ...pill, background: "rgba(255,255,255,0.22)", color: "#fff" }}>Dismiss</button>
    </div>
  );
}

/** Guidance while a gaze-drag gesture is in progress. */
function DragBanner({ phase }: { phase: "arming" | "dragging" }) {
  const msg = phase === "arming"
    ? "Drag armed — dwell where the drag should START"
    : "Dragging — dwell where to DROP (release)";
  return (
    <div style={{ position: "fixed", top: 44, left: "50%", transform: "translateX(-50%)",
      zIndex: 75, pointerEvents: "none", fontSize: 12.5, fontWeight: 600, color: "#fff",
      padding: "6px 16px", borderRadius: 999, backdropFilter: "blur(8px)",
      background: "rgba(120,60,190,0.9)" }}>
      ✥ {msg}
    </div>
  );
}

/** Display switcher — only rendered when more than one monitor is connected. */
function MonitorPicker({ onSwitch }: { onSwitch: (index: number) => void }) {
  const [monitors, setMonitors] = useState<string[]>([]);
  useEffect(() => { void listMonitors().then(setMonitors); }, []);
  if (monitors.length <= 1) return null;
  return (
    <div style={{ display: "flex", padding: "9px 0", alignItems: "center", justifyContent: "space-between",
      gap: 10, flexWrap: "wrap" }}>
      <span style={{ fontSize: 13.5 }}>Display <span className="dim" style={{ fontSize: 11 }}>(recalibrates)</span></span>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
        {monitors.map((m, i) => (
          <button key={i} data-dwell onClick={() => onSwitch(i)}
            style={{ padding: "4px 9px", borderRadius: 8, fontSize: 11.5, maxWidth: 120,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              background: "var(--accent-soft)", color: "var(--text-2)" }}>{m}</button>
        ))}
      </div>
    </div>
  );
}

const Boot = () => (
  <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
    <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", opacity: 0.7 }}>Gaze</div>
  </div>
);

/** Gate shown before calibration starts. Runs a live detection loop to coach the
 * user into a good position (distance, centering, light, head pose) BEFORE any
 * samples are collected, and lets them pick a quick or full calibration. This
 * loop stops (unmounts) the instant the user presses start, so it never overlaps
 * the calibration loop. */
function ReadyGate({ weak, engine, video, camLive, onStart }: {
  weak: boolean;
  engine: IGazeEngine | null;
  video: HTMLVideoElement | null;
  camLive: boolean;
  onStart: (mode: "full" | "quick") => void;
}) {
  const [pos, setPos] = useState<{ msg: string; tone: "wait" | "warn" | "good"; hx: number; hy: number; has: boolean }>(
    { msg: "Starting camera…", tone: "wait", hx: 0, hy: 0, has: false });

  useEffect(() => {
    if (!engine || !video) return;
    let raf = 0;
    let lastVt = -1;
    let lastInferAt = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      // Inference only on new camera frames, capped at ~30/s (spec §D).
      const now = performance.now();
      const vt = video.currentTime;
      if (vt === lastVt || now - lastInferAt < 30) return;
      lastVt = vt;
      lastInferAt = now;
      const f = engine.estimate(video, now);
      if (!camLive || f.status === "no_face" || !f.factors || !f.feature) {
        setPos({ msg: camLive ? "Center your face in the camera view" : "Starting camera…", tone: "wait", hx: 0, hy: 0, has: false });
        return;
      }
      const { openness, pose } = f.factors;
      const dist = f.feature.dist ?? 0.12;
      const hx = f.feature.hx ?? 0, hy = f.feature.hy ?? 0;
      let msg: string, tone: "wait" | "warn" | "good" = "warn";
      if (dist < 0.07) msg = "Move a bit closer";
      else if (dist > 0.2) msg = "Move back a little";
      else if (Math.abs(hx) > 0.12 || Math.abs(hy) > 0.12) msg = "Center your face in the view";
      else if (openness < 0.55) msg = "Open your eyes — add light in front of you";
      else if (pose < 0.62) msg = "Face the screen — head upright";
      else { msg = "Looks good — you're set"; tone = "good"; }
      setPos({ msg, tone, hx, hy, has: true });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, video, camLive]);

  const toneColor = pos.tone === "good" ? "var(--good, #34d399)" : pos.tone === "warn" ? "var(--warn, #fbbf24)" : "var(--text-3)";
  const box = 150, dotX = box / 2 + Math.max(-1, Math.min(1, pos.hx / 0.25)) * (box / 2 - 16);
  const dotY = box / 2 + Math.max(-1, Math.min(1, pos.hy / 0.25)) * (box / 2 - 16);

  return (
    <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }} className="fade-enter">
      <div style={{ maxWidth: 440, textAlign: "center", padding: "var(--s-6)" }}>
        <div style={{ position: "relative", width: box, height: box, margin: "0 auto var(--s-4)",
          borderRadius: 20, border: `2px dashed ${toneColor}`, background: "var(--accent-soft)",
          transition: "border-color var(--dur-med)" }}>
          <div style={{ position: "absolute", left: box / 2, top: box / 2, transform: "translate(-50%,-50%)",
            width: box - 40, height: box - 40, borderRadius: 999, border: "1.5px solid var(--stroke)" }} />
          {pos.has ? (
            <div style={{ position: "absolute", left: dotX, top: dotY, transform: "translate(-50%,-50%)",
              width: 20, height: 20, borderRadius: 999, background: toneColor,
              boxShadow: `0 0 14px ${toneColor}`, transition: "left 90ms linear, top 90ms linear, background var(--dur-med)" }} />
          ) : (
            <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 30 }}>👁</div>
          )}
        </div>

        <h2 style={{ fontSize: 20 }}>{weak ? "Ready to refine?" : "Ready to calibrate?"}</h2>
        <p style={{ margin: "var(--s-2) 0", fontSize: 14.5, fontWeight: 600, color: toneColor }} role="status">{pos.msg}</p>
        <p className="dim" style={{ margin: "0 0 var(--s-5)", fontSize: 13, lineHeight: 1.5 }}>
          Sit about an arm's length away, evenly lit. When you start, follow each dot with your eyes.
        </p>

        {weak ? (
          <button onClick={() => onStart("full")}
            style={{ padding: "12px 28px", borderRadius: "var(--radius-md)", background: "var(--accent)",
              color: "#fff", fontSize: 15, fontWeight: 500 }}>
            Start refinement
          </button>
        ) : (
          <div style={{ display: "flex", justifyContent: "center", gap: 10 }}>
            <button onClick={() => onStart("quick")}
              style={{ padding: "12px 22px", borderRadius: "var(--radius-md)", background: "var(--accent-soft)",
                color: "var(--accent)", fontSize: 14.5, fontWeight: 600 }}>
              Quick (~20s)
            </button>
            <button onClick={() => onStart("full")}
              style={{ padding: "12px 26px", borderRadius: "var(--radius-md)", background: "var(--accent)",
                color: "#fff", fontSize: 14.5, fontWeight: 600 }}>
              Full (best)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  return <SessionProvider><Inner /></SessionProvider>;
}
