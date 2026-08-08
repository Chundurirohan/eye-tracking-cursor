import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SessionProvider, useSession } from "@/core/session/SessionContext";
import { CameraManager, describeCameraError } from "@/core/camera/CameraManager";
import { MediaPipeGazeEngine } from "@/core/engine/MediaPipeGazeEngine";
import type { IGazeEngine } from "@/core/engine/IGazeEngine";
import { PermissionGate } from "@/features/permissions/PermissionGate";
import { CalibrationScene } from "@/features/calibration/CalibrationScene";
import { Capsule } from "@/features/tracking/Capsule";
import { DwellCursor } from "@/features/tracking/DwellCursor";
import { ReacquiringPill } from "@/features/tracking/ReacquiringPill";
import { AdvancedView, type Diagnostics } from "@/features/diagnostics/AdvancedView";
import { LandmarkOverlay } from "@/features/diagnostics/LandmarkOverlay";
import { ConfidenceMeter } from "@/features/shared/ConfidenceMeter";
import { Toggle } from "@/features/shared/Toggle";
import { useHotkeys } from "@/features/shared/useHotkeys";
import { setClickThrough, nativeClick, dispatchAction, isTrusted, zoomToggle, screenInfo } from "@/core/system/nativeInput";
import { RadialMenu } from "@/features/tracking/RadialMenu";
import { OnScreenKeyboard } from "@/features/tracking/OnScreenKeyboard";
import { PoseAdaptiveCorrector } from "@/core/engine/adaptation";
import { listen } from "@tauri-apps/api/event";
import { useSettings } from "@/store/settings";
import { QUALITY_THRESHOLD } from "@/core/session/machine";
import "@/styles/global.css";

// How many calibration passes (initial + weak-point refinements) before we
// accept a best-effort result instead of looping forever.
const MAX_CALIBRATION_ATTEMPTS = 3;

// --- Display-proportional UI -----------------------------------------------
// A 27" desktop display is the reference: at that size everything renders at
// 1.0 and nothing changes. Smaller panels scale DOWN proportionally, because the
// HUD and keyboard are sized in absolute pixels and a control bar tuned for 27"
// eats an absurd share of a 14" laptop screen.
//
// Height in logical points is the right yardstick, not inches or physical pixels:
// macOS already folds display scaling into it, so a 27" desktop reads ~1440pt and
// a 14" MacBook ~982pt (≈0.68×) — which is the ratio we actually want.
const REFERENCE_HEIGHT_PT = 1440; // 27" desktop display
const MIN_UI_SCALE = 0.62;

// The window now spans the WHOLE display (so gaze can reach the menu bar and
// Dock), which means its bottom edge is behind the Dock rather than above it —
// bottom-anchored UI slid down with it. This lifts that UI back to where it sat
// when the window stopped short of the Dock.
const DOCK_LIFT_PT = 74;

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

  // Publish display-derived sizing as CSS vars, so every bottom-anchored surface
  // (HUD capsule, on-screen keyboard) scales from one place. See the constants
  // above for why height in points is the yardstick.
  useEffect(() => {
    let alive = true;
    const apply = async () => {
      const info = await screenInfo();
      if (!alive) return;
      const heightPt = info ? info[1] : window.innerHeight;
      const scale = Math.min(1, Math.max(MIN_UI_SCALE, heightPt / REFERENCE_HEIGHT_PT));
      const root = document.documentElement;
      root.style.setProperty("--ui-scale", String(scale));
      // Lift scales too, so it stays proportionate on a small panel.
      root.style.setProperty("--dock-lift", `${Math.round(DOCK_LIFT_PT * scale)}px`);
    };
    void apply();
    window.addEventListener("resize", apply); // display change / monitor swap
    return () => { alive = false; window.removeEventListener("resize", apply); };
  }, []);
  // Radial action menu: the normalized gaze point where it's anchored, or null.
  const [actionMenu, setActionMenu] = useState<{ nx: number; ny: number } | null>(null);
  const [showKeyboard, setShowKeyboard] = useState(false);
  // macOS Zoom magnifier on/off (we track it locally since the OS state isn't
  // queryable; our toggle is the only source that flips it).
  const [zoomOn, setZoomOn] = useState(false);
  // Whether the keyboard is up because a text field auto-triggered it (vs. a
  // manual toggle) — so auto-hide only reverses an auto-show, never fights the user.
  const keyboardAutoRef = useRef(false);
  // Effective Accessibility permission (null = unknown yet). Synthetic clicks
  // no-op when false — this is the definitive shield-vs-permission diagnostic.
  const [axTrusted, setAxTrusted] = useState<boolean | null>(null);
  // A "Ready to calibrate" gate the user must press before calibration starts.
  const [calibReady, setCalibReady] = useState(false);
  const calibAttemptsRef = useRef(0);

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
    // Keep the gaze loop running while PAUSED too — otherwise no gaze is fed and
    // the Resume button can't be dwell-clicked (you'd be stuck paused). Paused
    // just means DwellCursor is disarmed (no cursor warp / no clicks into apps);
    // our own controls stay gaze-operable. State transitions below are guarded on
    // stateRef, so the loop never auto-changes state while paused.
    if (state !== "tracking" && state !== "reacquiring" && state !== "paused") {
      cancelAnimationFrame(rafRef.current);
      return;
    }
    const engine = engineRef.current!;
    const video = cameraRef.current!.video;
    let lastGood = performance.now();
    let frames = 0, fpsT = performance.now(), fps = 0;
    const HOLD_MS = 160;
    // Gaze-stability confidence: how sure we are you're fixating a *point*.
    const recent: { x: number; y: number; t: number }[] = [];
    const STAB_WINDOW = 300, SPREAD_REF = 0.05;
    let emaConf = 0;

    const loop = () => {
      const now = performance.now();
      const frame = engine.estimate(video, now);
      frames++;
      if (now - fpsT > 500) { fps = (frames * 1000) / (now - fpsT); frames = 0; fpsT = now; }

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
      setTrackConf(emaConf);

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

      setDiag({
        confidence: frame.confidence, factors: frame.factors, quality: context.quality, fps,
        headPose: frame.headPose, engine: engine.capabilities.name,
      });
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [state, send, context.quality]);

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

  // In widget mode let mouse input pass THROUGH the overlay so the computer is
  // usable normally; capture it during setup/calibration so buttons are clickable.
  // A transparent overlay that ISN'T click-through silently captures every click
  // and "freezes" the desktop — so in widget mode we re-assert click-through on a
  // steady interval, and re-assert whenever the window regains focus, so it can
  // never get stuck in the blocking state.
  useEffect(() => {
    void setClickThrough(widgetMode);
    const t = window.setTimeout(() => void setClickThrough(widgetMode), 300);
    if (!widgetMode) return () => window.clearTimeout(t);
    const iv = window.setInterval(() => void setClickThrough(true), 1000);
    const onFocus = () => void setClickThrough(true);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearTimeout(t);
      window.clearInterval(iv);
      window.removeEventListener("focus", onFocus);
    };
  }, [widgetMode]);

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

  // ⌃⌥R (global shortcut) — quick re-anchor: look at the center dot for ~1s to
  // re-center the mapping for your current head posture (fixes accumulated drift
  // without a full recalibration).
  useEffect(() => {
    const un = listen("gaze:reanchor", () => {
      reanchorRef.current = true;
      reanchorStartRef.current = performance.now();
      reanchorSamplesRef.current = [];
      setReanchoring(true);
    });
    return () => { void un.then((f) => f()); };
  }, []);

  // Auto-show the on-screen keyboard when a text field takes focus anywhere on
  // the system (Rust AX watcher emits gaze:text-focus), and auto-hide when focus
  // leaves — but never override a keyboard the user opened/closed by hand.
  useEffect(() => {
    const un = listen<boolean>("gaze:text-focus", (e) => {
      if (e.payload) { keyboardAutoRef.current = true; setShowKeyboard(true); }
      else if (keyboardAutoRef.current) { keyboardAutoRef.current = false; setShowKeyboard(false); }
    });
    return () => { void un.then((f) => f()); };
  }, []);

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

  return (
    <div style={{ position: "absolute", inset: 0, background: isWidget ? "transparent" : "var(--bg)" }}>
      {isWidget && (
        <DwellCursor active={isWidget} armed={armed && state === "tracking"}
          confidence={trackConf} onNativeClick={nativeClick}
          menuOpen={!!actionMenu}
          onRequestMenu={(nx, ny) => setActionMenu({ nx, ny })}
          onCalibrate={(gaze, target) => adaptRef.current.observe(gaze, target, headPoseRef.current)} />
      )}
      {actionMenu && (
        <RadialMenu
          center={{ x: actionMenu.nx * window.innerWidth, y: actionMenu.ny * window.innerHeight }}
          onSelect={(action) => {
            dispatchAction(action, actionMenu.nx, actionMenu.ny);
            // A real action landed — this, and only this, counts as a COMPLETED
            // click and lifts magnet-fatigue suppression (see DwellCursor).
            // Opening the wheel is not enough, and Cancel below deliberately does
            // NOT fire: backing out is exactly the "I didn't want that" signal
            // suppression exists to record.
            window.dispatchEvent(new CustomEvent("gaze:action-committed"));
            setActionMenu(null);
          }}
          onCancel={() => setActionMenu(null)} />
      )}
      {isWidget && showKeyboard && (
        <OnScreenKeyboard onClose={() => { keyboardAutoRef.current = false; setShowKeyboard(false); }} />
      )}
      {isWidget && axTrusted !== null && (
        <div style={{ position: "fixed", top: 8, left: "50%", transform: "translateX(-50%)",
          zIndex: 70, pointerEvents: "none", fontSize: 11, fontWeight: 600,
          padding: "3px 12px", borderRadius: 999, color: "#fff", backdropFilter: "blur(8px)",
          background: axTrusted ? "rgba(16,120,60,0.85)" : "rgba(160,32,32,0.92)" }}>
          {axTrusted ? "Accessibility ✓ — clicks can land" : "Accessibility ✗ — clicks will NOT land"}
        </div>
      )}
      {reanchoring && (
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

      {/* Mini landmark camera only during live tracking — NOT during calibration
          (the calibration scene is deliberately clean; head-position validation
          lives in the ReadyGate before it starts). */}
      {(state === "tracking" || state === "reacquiring") && camLive && engineRef.current && (
        <LandmarkOverlay engine={engineRef.current} video={cameraRef.current!.video} />
      )}

      {/* Plain feed is only the soft calibration backdrop. During tracking the
          single camera view is the landmark overlay (bottom-left). */}
      {settings.cameraPreview && state === "calibrating" && (
        <video ref={previewRef} muted playsInline
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover",
            opacity: 0.22, filter: "blur(2px)", transform: "scaleX(-1)",
            transition: "opacity var(--dur-slow) var(--ease-soft)" }} />
      )}

      {state === "permissions" && <PermissionGate error={context.error} onRequest={requestPermission} />}

      {state === "calibrating" && !calibReady && (
        <ReadyGate weak={context.weakPointIds.length > 0}
          engine={engineRef.current} video={cameraRef.current?.video ?? null} camLive={camLive}
          onStart={() => setCalibReady(true)} />
      )}

      {state === "calibrating" && calibReady && engineRef.current && (
        <CalibrationScene
          engine={engineRef.current}
          video={cameraRef.current!.video}
          weakPointIds={context.weakPointIds}
          note={calibNote}
          onConfidence={setCalibConf}
          onComplete={(model, quality, weak) => {
            engineRef.current!.setCalibration(model);
            patchSaved({
              calibration: { ...model, quality, savedAt: Date.now() },
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

      {state === "reacquiring" && <ReacquiringPill />}
      {showDiag && diag && <AdvancedView d={diag} onClose={() => setShowDiag(false)} />}

      {showCapsule && (
        <Capsule
          state={state}
          side={settings.controlSide}
          armed={armed}
          onPauseToggle={() => send({ type: state === "paused" ? "RESUME" : "PAUSE" })}
          onRecalibrate={() => send({ type: "START_RECALIBRATION", weakPointIds: [] })}
          keyboardOn={showKeyboard}
          onToggleKeyboard={() => { keyboardAutoRef.current = false; setShowKeyboard((v) => !v); }}
          zoomOn={zoomOn}
          onToggleZoom={() => { zoomToggle(); setZoomOn((v) => !v); }}
          settingsSlot={<SettingsPanel onToggleDiagnostics={() => setShowDiag((s) => !s)} showDiag={showDiag} />}
        />
      )}
    </div>
  );
}

function SettingsPanel({ onToggleDiagnostics, showDiag }: { onToggleDiagnostics: () => void; showDiag: boolean }) {
  const s = useSettings();
  return (
    <div>
      <h3 style={{ fontSize: 14, marginBottom: "var(--s-2)" }}>Settings</h3>
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

const Boot = () => (
  <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
    <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", opacity: 0.7 }}>Gaze</div>
  </div>
);

/** Gate shown before calibration starts — nothing is collected until the user
 * presses Start. It runs a LIVE head-position check (distance, centering, eyes,
 * pose) and shows a position dot so the user can get settled and framed first —
 * the single biggest lever on final calibration quality. */
function ReadyGate({ weak, engine, video, camLive, onStart }: {
  weak: boolean;
  engine: IGazeEngine | null;
  video: HTMLVideoElement | null;
  camLive: boolean;
  onStart: () => void;
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
      // Inference only on new camera frames, capped at ~30/s.
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
        <button onClick={onStart}
          style={{ padding: "12px 28px", borderRadius: "var(--radius-md)", background: "var(--accent)",
            color: "#fff", fontSize: 15, fontWeight: 500 }}>
          {weak ? "Start refinement" : "Start calibration"}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  return <SessionProvider><Inner /></SessionProvider>;
}
