import { useEffect, useRef, useState } from "react";
import { CalibrationController, type CalibrationProgress } from "@/core/calibration/controller";
import type { IGazeEngine } from "@/core/engine/IGazeEngine";
import type { CalibrationModel, HeadDirection } from "@/core/calibration/types";
import type { ConfidenceFactors } from "@/core/engine/types";
import { Glass } from "@/features/shared/Glass";
import { calibrationCoaching, type Coaching } from "./coaching";
import { confidenceLook } from "@/features/shared/confidenceColor";

// How long confidence must sit below the acceptable bar before we surface
// coaching — long enough not to flicker on a brief dip.
const COACH_AFTER_MS = 2200;

const PROMPT_COPY: Record<HeadDirection, string> = {
  center: "Look here",
  left: "Look here — turn slightly left",
  right: "Look here — turn slightly right",
  up: "Look here — tilt slightly up",
  down: "Look here — tilt slightly down",
};

export function CalibrationScene({
  engine, video, weakPointIds, note, onComplete, onConfidence,
}: {
  engine: IGazeEngine;
  video: HTMLVideoElement;
  weakPointIds: number[];
  note: string | null;
  onComplete: (model: CalibrationModel, quality: number, weak: number[]) => void;
  onConfidence?: (confidence: number) => void;
}) {
  const [progress, setProgress] = useState<CalibrationProgress | null>(null);
  const [coaching, setCoaching] = useState<Coaching | null>(null);
  const lowSinceRef = useRef<number | null>(null);
  const completeRef = useRef(onComplete);
  completeRef.current = onComplete;
  const confRef = useRef(onConfidence);
  confRef.current = onConfidence;

  useEffect(() => {
    const ctrl = new CalibrationController(engine, video,
      (p) => { setProgress(p); confRef.current?.(p.confidence); },
      (m, q, w) => completeRef.current(m, q, w));
    ctrl.start(weakPointIds.length ? weakPointIds : undefined);
    return () => ctrl.stop();
  }, [engine, video, weakPointIds]);

  // Surface coaching only when there's something the user can actually fix, and
  // only after it has persisted briefly (no flicker on a momentary dip). If
  // there are no actionable blockers, the controller is collecting the sample —
  // so we show nothing rather than nag.
  useEffect(() => {
    const advice = calibrationCoaching(progress?.factors ?? null);
    if (!advice) { lowSinceRef.current = null; setCoaching(null); return; }
    const now = performance.now();
    if (lowSinceRef.current == null) lowSinceRef.current = now;
    if (now - lowSinceRef.current >= COACH_AFTER_MS) setCoaching(advice);
  }, [progress?.factors]);

  const target = progress?.point;
  const moving = progress?.movingPos;
  const cursor = progress?.cursorPos;
  const isFitting = progress?.phase === "fitting";
  const refining = !!progress?.refining || weakPointIds.length > 0;

  const subtitle = isFitting ? "Finishing up…"
    : moving ? `Follow the moving dot with your eyes · Pass ${progress!.pass} of ${progress!.passes}`
    : "Look at the dot until it settles";

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }} className="fade-enter">
      <div style={{ position: "absolute", top: "var(--s-7)", left: 0, right: 0, textAlign: "center", zIndex: 3 }}>
        <h2 style={{ fontSize: 20 }}>{refining ? "Refining a few points" : "Calibrating"}</h2>
        <p className="dim" style={{ marginTop: 6, fontSize: 14 }}>{subtitle}</p>
        {note && (
          <p style={{ marginTop: 8, fontSize: 12.5, color: "var(--text-3)" }} role="status">{note}</p>
        )}
      </div>

      {target && <Target x={target.x} y={target.y} label={PROMPT_COPY[target.variation]}
        dwell={progress?.dwell ?? 0} collecting={!!progress?.settled} />}
      {moving && <Target x={moving.x} y={moving.y} label="" dwell={0} collecting={false} />}
      {moving && cursor && <GazeCursor x={cursor.x} y={cursor.y} following={!!progress?.inRange} />}

      {progress && !moving && !progress.refining && (
        <div style={{ position: "absolute", bottom: "var(--s-7)", left: 0, right: 0,
          display: "flex", justifyContent: "center", gap: 6, zIndex: 3 }}>
          {Array.from({ length: progress.total }).map((_, i) => (
            <span key={i} style={{ width: 6, height: 6, borderRadius: 999,
              background: i < progress.index ? "var(--accent)" : i === progress.index ? "var(--text-2)" : "var(--text-3)",
              transition: "background var(--dur-fast) var(--ease-soft)" }} />
          ))}
        </div>
      )}

      {isFitting && (
        <Glass radius="lg" style={{ position: "absolute", top: "50%", left: "50%",
          transform: "translate(-50%,-50%)", padding: "var(--s-5) var(--s-6)", zIndex: 4 }}>
          <span style={{ fontSize: 15 }}>Computing your gaze model…</span>
        </Glass>
      )}

      {coaching && !isFitting && (
        <CoachingBanner coaching={coaching} factors={progress?.factors ?? null} />
      )}
    </div>
  );
}

/** Bottom-center guidance shown when the confidence score is stuck low. Names
 * the limiting factor, lists concrete fixes, and shows a live factor readout so
 * the user can watch a number climb as they adjust. */
function CoachingBanner({ coaching, factors }: { coaching: Coaching; factors: ConfidenceFactors | null }) {
  return (
    <Glass radius="lg" className="fade-enter"
      style={{ position: "absolute", left: "50%", bottom: "13%", transform: "translateX(-50%)",
        maxWidth: 440, padding: "var(--s-4) var(--s-5)", zIndex: 5, textAlign: "left" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 16 }}>💡</span>
        <span style={{ fontSize: 15, fontWeight: 600 }}>{coaching.headline}</span>
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
        {coaching.tips.map((t, i) => (
          <li key={i} style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.45 }}>{t}</li>
        ))}
      </ul>
      {factors && (
        <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
          <FactorChip label="Eyes" v={factors.openness} />
          <FactorChip label="Head" v={factors.pose} />
          <FactorChip label="Face" v={factors.face} />
        </div>
      )}
    </Glass>
  );
}

function FactorChip({ label, v }: { label: string; v: number }) {
  const { color } = confidenceLook(v);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5,
      color: "var(--text-3)" }}>
      <span style={{ width: 7, height: 7, borderRadius: 999, background: color }} />
      {label} <span className="mono" style={{ color }}>{Math.round(v * 100)}%</span>
    </span>
  );
}

/** A single solid blue calibration dot — no ring. It shrinks from large to
 * small as the dwell window progresses (the shrink draws and holds the eye on
 * the point), and brightens while frames are actually being collected. */
function Target({ x, y, label, dwell, collecting }:
  { x: number; y: number; label: string; dwell: number; collecting: boolean }) {
  const size = 34 - 16 * Math.min(1, Math.max(0, dwell)); // 34px -> 18px across the window
  return (
    <div style={{ position: "absolute", left: `${x * 100}%`, top: `${y * 100}%`,
      transform: "translate(-50%,-50%)", zIndex: 3,
      transition: "left var(--dur-med) var(--ease-soft), top var(--dur-med) var(--ease-soft)" }}>
      <div style={{ width: size, height: size, borderRadius: 999, background: "var(--accent)",
        boxShadow: collecting ? "0 0 22px var(--accent)" : "0 0 12px var(--accent)",
        transition: "width 90ms linear, height 90ms linear, box-shadow var(--dur-fast)" }} />
      {label && <div style={{ position: "absolute", top: 34, left: "50%", transform: "translateX(-50%)",
        whiteSpace: "nowrap", fontSize: 13, color: "var(--text-2)" }}>{label}</div>}
    </div>
  );
}

/** The user's live gaze position during the moving phase, driven by the
 * provisional model. Turns green when the eye is following the target (so the
 * frame is being collected), amber otherwise. */
function GazeCursor({ x, y, following }: { x: number; y: number; following: boolean }) {
  const color = following ? "#34d399" : "#fbbf24";
  return (
    <div style={{ position: "absolute", left: `${x * 100}%`, top: `${y * 100}%`,
      transform: "translate(-50%,-50%)", zIndex: 4, pointerEvents: "none",
      transition: "left 60ms linear, top 60ms linear" }}>
      <div style={{ width: 34, height: 34, borderRadius: 999, border: `2px solid ${color}`,
        boxShadow: `0 0 14px ${color}`, transition: "border-color 120ms, box-shadow 120ms" }} />
      <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)",
        width: 5, height: 5, borderRadius: 999, background: color }} />
    </div>
  );
}
