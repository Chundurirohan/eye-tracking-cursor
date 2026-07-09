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
import { setClickThrough, nativeClick } from "@/core/system/nativeInput";
import { listen } from "@tauri-apps/api/event";
import { useSettings } from "@/store/settings";
import { QUALITY_THRESHOLD } from "@/core/session/machine";
import "@/styles/global.css";

// How many calibration passes (initial + weak-point refinements) before we
// accept a best-effort result instead of looping forever.
const MAX_CALIBRATION_ATTEMPTS = 3;

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
  // A "Ready to calibrate" gate the user must press before calibration starts.
  const [calibReady, setCalibReady] = useState(false);
  const calibAttemptsRef = useRef(0);

  const cameraRef = useRef<CameraManager | null>(null);
  const engineRef = useRef<IGazeEngine | null>(null);
  const rafRef = useRef(0);
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
    if (state !== "tracking" && state !== "reacquiring") {
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

        const w = Math.max(0, Math.min(1, (spread - 0.015) / (0.06 - 0.015))); // 0 fixate, 1 move
        const out = { x: cx + (frame.point.x - cx) * w, y: cy + (frame.point.y - cy) * w };
        window.dispatchEvent(new CustomEvent("gaze:point", { detail: out }));
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
  // Re-assert shortly after in case the window wasn't ready on the first call.
  useEffect(() => {
    void setClickThrough(widgetMode);
    const t = window.setTimeout(() => void setClickThrough(widgetMode), 300);
    return () => window.clearTimeout(t);
  }, [widgetMode]);

  // Require a "Ready" press before each calibration run.
  useEffect(() => { if (state === "calibrating") setCalibReady(false); }, [state]);

  // ⌃⌥Space (global shortcut, emitted from Rust) arms/disarms gaze control.
  useEffect(() => {
    const un = listen("gaze:toggle-armed", () => setArmed((a) => !a));
    return () => { void un.then((f) => f()); };
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
          confidence={trackConf} onNativeClick={nativeClick} />
      )}
      {live && <ConfidenceMeter value={meterValue} />}

      {live && camLive && engineRef.current && (
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
        <ReadyGate weak={context.weakPointIds.length > 0} onStart={() => setCalibReady(true)} />
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
 * presses Start, so they can get settled and positioned first. */
function ReadyGate({ weak, onStart }: { weak: boolean; onStart: () => void }) {
  return (
    <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }} className="fade-enter">
      <div style={{ maxWidth: 420, textAlign: "center", padding: "var(--s-6)" }}>
        <div style={{ width: 56, height: 56, margin: "0 auto var(--s-4)", borderRadius: 16,
          background: "var(--accent-soft)", display: "grid", placeItems: "center", fontSize: 26 }}>👁</div>
        <h2 style={{ fontSize: 20 }}>{weak ? "Ready to refine?" : "Ready to calibrate?"}</h2>
        <p className="dim" style={{ margin: "var(--s-2) 0 var(--s-5)", fontSize: 14, lineHeight: 1.5 }}>
          Sit about an arm's length away, face evenly lit and centered. When you press start,
          follow each dot with your eyes and keep your head relaxed.
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
