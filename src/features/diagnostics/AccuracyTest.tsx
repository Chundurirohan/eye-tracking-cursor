import { useEffect, useMemo, useState } from "react";
import type { IGazeEngine } from "@/core/engine/IGazeEngine";

// Objective accuracy check: show a grid of targets, look at each, measure the
// error between the calibrated gaze and the target, then draw a heatmap + numbers.
// Turns "does this feel better?" into a measurement you can compare (spec §Scenario 3).

const SETTLE_MS = 600;   // skip the saccade-to-target latency
const COLLECT_MS = 900;  // average the gaze over this window per target

type Result = { tx: number; ty: number; ex: number; ey: number; err: number; n: number };

function buildTestGrid(): { x: number; y: number }[] {
  const cols = 4, rows = 3, m = 0.12;
  const pts: { x: number; y: number }[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      pts.push({ x: m + (c / (cols - 1)) * (1 - 2 * m), y: m + (r / (rows - 1)) * (1 - 2 * m) });
  return pts;
}

// green (accurate) → red (inaccurate); ~12% of screen counts as fully "bad".
const errColor = (e: number) => `hsl(${(1 - Math.min(1, e / 0.12)) * 130}, 80%, 50%)`;

export function AccuracyTest({ engine, video, onClose }: {
  engine: IGazeEngine; video: HTMLVideoElement; onClose: () => void;
}) {
  const targets = useMemo(buildTestGrid, []);
  const [idx, setIdx] = useState(0);
  const [done, setDone] = useState(false);
  const [results, setResults] = useState<Result[]>([]);

  useEffect(() => {
    if (done) return;
    let raf = 0, processed = false;
    let lastVt = -1;
    let lastInferAt = 0;
    const enteredAt = performance.now();
    const samples: { x: number; y: number }[] = [];
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      // Inference only on new camera frames, capped at ~30/s (spec §D); the
      // per-target timing below still advances every animation frame.
      const vt = video.currentTime;
      if (vt !== lastVt && now - lastInferAt >= 30) {
        lastVt = vt;
        lastInferAt = now;
        const frame = engine.estimate(video, now);
        const elapsed0 = now - enteredAt;
        if (elapsed0 >= SETTLE_MS && elapsed0 < SETTLE_MS + COLLECT_MS && frame.point) samples.push(frame.point);
      }
      const elapsed = now - enteredAt;
      if (elapsed >= SETTLE_MS + COLLECT_MS && !processed) {
        processed = true;
        const t = targets[idx]!;
        let ex = t.x, ey = t.y, err = NaN;
        if (samples.length) {
          ex = samples.reduce((s, p) => s + p.x, 0) / samples.length;
          ey = samples.reduce((s, p) => s + p.y, 0) / samples.length;
          err = Math.hypot(ex - t.x, ey - t.y);
        }
        setResults((r) => [...r, { tx: t.x, ty: t.y, ex, ey, err, n: samples.length }]);
        if (idx + 1 >= targets.length) setDone(true); else setIdx(idx + 1);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [idx, done, engine, video, targets]);

  const valid = results.filter((r) => Number.isFinite(r.err));
  const mean = valid.length ? valid.reduce((s, r) => s + r.err, 0) / valid.length : NaN;
  const max = valid.length ? Math.max(...valid.map((r) => r.err)) : NaN;
  const restart = () => { setResults([]); setIdx(0); setDone(false); };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 90, background: "var(--bg)", overflow: "hidden" }} className="fade-enter">
      <div style={{ position: "absolute", top: "var(--s-6)", left: 0, right: 0, textAlign: "center", zIndex: 2 }}>
        <h2 style={{ fontSize: 20 }}>{done ? "Accuracy results" : "Accuracy test"}</h2>
        <p className="dim" style={{ fontSize: 14, marginTop: 6 }}>
          {done
            ? `Mean error ${(mean * 100).toFixed(1)}% of screen · worst ${(max * 100).toFixed(1)}%`
            : `Look straight at the dot · ${idx + 1} of ${targets.length}`}
        </p>
      </div>

      {!done && (
        <div style={{ position: "absolute", left: `${targets[idx]!.x * 100}%`, top: `${targets[idx]!.y * 100}%`,
          transform: "translate(-50%,-50%)" }}>
          <div style={{ width: 22, height: 22, borderRadius: 999, background: "var(--accent)",
            boxShadow: "0 0 18px var(--accent)" }} />
        </div>
      )}

      {done && (
        <>
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
            {results.map((r, i) => Number.isFinite(r.err) && (
              <line key={i} x1={`${r.tx * 100}%`} y1={`${r.ty * 100}%`} x2={`${r.ex * 100}%`} y2={`${r.ey * 100}%`}
                stroke={errColor(r.err)} strokeWidth={2} opacity={0.55} />
            ))}
          </svg>
          {results.map((r, i) => (
            <div key={i}>
              <div style={{ position: "absolute", left: `${r.tx * 100}%`, top: `${r.ty * 100}%`,
                transform: "translate(-50%,-50%)", width: 18, height: 18, borderRadius: 999,
                background: Number.isFinite(r.err) ? errColor(r.err) : "var(--text-3)",
                boxShadow: Number.isFinite(r.err) ? `0 0 12px ${errColor(r.err)}` : "none" }} />
              {Number.isFinite(r.err) && (
                <>
                  <div style={{ position: "absolute", left: `${r.ex * 100}%`, top: `${r.ey * 100}%`,
                    transform: "translate(-50%,-50%)", width: 9, height: 9, borderRadius: 999,
                    border: `2px solid ${errColor(r.err)}` }} />
                  <div style={{ position: "absolute", left: `${r.tx * 100}%`, top: `${r.ty * 100}%`,
                    transform: "translate(-50%, 14px)", fontSize: 10.5, color: "var(--text-3)", whiteSpace: "nowrap" }}>
                    {(r.err * 100).toFixed(1)}%
                  </div>
                </>
              )}
            </div>
          ))}
          <div style={{ position: "absolute", bottom: "var(--s-6)", left: 0, right: 0,
            display: "flex", justifyContent: "center", gap: 12, zIndex: 2 }}>
            <button data-dwell onClick={restart} style={{ padding: "10px 22px", borderRadius: "var(--radius-md)",
              background: "var(--accent-soft)", color: "var(--accent)", fontSize: 14, fontWeight: 600 }}>Run again</button>
            <button data-dwell onClick={onClose} style={{ padding: "10px 22px", borderRadius: "var(--radius-md)",
              background: "var(--accent)", color: "#fff", fontSize: 14, fontWeight: 600 }}>Done</button>
          </div>
        </>
      )}
    </div>
  );
}
