import { startDiagnosticLog as openLog, appendDiagnosticLog } from "@/core/system/pixelError";
import { useEffect, useRef, useState } from "react";

// Runs INDEFINITELY: every pass reshuffles the grid and starts again, logging each
// point as it completes (so a crash loses at most the current point). It ends only
// when the user stops it (Stop button, Esc, or a long dwell on Stop).
//
// Objective accuracy check: show a grid of targets, look at each, measure the
// error between the calibrated gaze and the target, then draw a heatmap + numbers.
// Turns "does this feel better?" into a measurement you can compare (spec §Scenario 3).

const isNative = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const SETTLE_MS = 600;   // skip the saccade-to-target latency

type Result = { tx: number; ty: number; ex: number; ey: number; err: number; n: number };

function buildTestGrid(): { x: number; y: number }[] {
  const cols = 4, rows = 3, m = 0.12;
  const pts: { x: number; y: number }[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      pts.push({ x: m + (c / (cols - 1)) * (1 - 2 * m), y: m + (r / (rows - 1)) * (1 - 2 * m) });
  // Shuffle the fixed grid so the user cannot anticipate the next target.
  for (let i = pts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pts[i], pts[j]] = [pts[j]!, pts[i]!];
  }
  return pts;
}

// green (accurate) → red (inaccurate); ~12% of screen counts as fully "bad".
const errColor = (e: number) => `hsl(${(1 - Math.min(1, e / 0.12)) * 130}, 80%, 50%)`;

export function AccuracyTest({ onClose }: {
  onClose: () => void;
}) {
  const [targets, setTargets] = useState(buildTestGrid);
  const [round, setRound] = useState(1);
  const roundRef = useRef(1);
  const startedAtRef = useRef(Date.now());
  const [idx, setIdx] = useState(0);
  const [done, setDone] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [pointProgress, setPointProgress] = useState(0);
  const [logFile, setLogFile] = useState<string | null>(null);
  const enteredAtRef = useRef(0);
  const samplesRef = useRef<{ x: number; y: number }[]>([]);
  const logFileRef = useRef<string | null>(null);

  const startDiagnosticLog = () => {
    logFileRef.current = null;
    setLogFile(null);
    void openLog()
      .then((file) => { logFileRef.current = file; setLogFile(file); })
      .catch((error: unknown) => console.error("[gaze] failed to start diagnostic log:", error));
  };

  useEffect(() => {
    document.body.dataset.accuracyTest = "true";
    startDiagnosticLog();
    return () => { delete document.body.dataset.accuracyTest; };
  }, []);

  useEffect(() => {
    if (done) return;
    enteredAtRef.current = performance.now();
    samplesRef.current = [];
    const onGaze = (event: Event) => {
      const point = (event as CustomEvent<{ x: number; y: number }>).detail;
      if (performance.now() - enteredAtRef.current >= SETTLE_MS) samplesRef.current.push(point);
    };
    // Dwelling on a test control (Stop) must not be logged as a measurement.
    const onDwellComplete = (event: Event) => {
      if ((event as CustomEvent<{ control?: boolean }>).detail?.control) return;
      completePoint();
    };
    window.addEventListener("gaze:point", onGaze);
    window.addEventListener("gaze:dwell-complete", onDwellComplete);
    const onDwellProgress = (event: Event) => {
      const progress = (event as CustomEvent<{ progress: number }>).detail.progress;
      setPointProgress(progress);
    };
    window.addEventListener("gaze:dwell-progress", onDwellProgress);
    return () => {
      window.removeEventListener("gaze:point", onGaze);
      window.removeEventListener("gaze:dwell-complete", onDwellComplete);
      window.removeEventListener("gaze:dwell-progress", onDwellProgress);
    };
  }, [idx, done, targets]);

  const completePoint = () => {
    const t = targets[idx]!;
    const samples = samplesRef.current;
    let ex = t.x, ey = t.y, err = NaN;
    if (samples.length) {
      ex = samples.reduce((s, p) => s + p.x, 0) / samples.length;
      ey = samples.reduce((s, p) => s + p.y, 0) / samples.length;
      err = Math.hypot(ex - t.x, ey - t.y);
    }
    const result = { tx: t.x, ty: t.y, ex, ey, err, n: samples.length };
    setResults((r) => [...r, result]);
    const file = logFileRef.current;
    if (file) {
      const line = [
        `target=(${t.x.toFixed(6)},${t.y.toFixed(6)})`,
        `predicted=(${ex.toFixed(6)},${ey.toFixed(6)})`,
        `error=${Number.isFinite(err) ? err.toFixed(6) : "unavailable"}`,
        `samples=${samples.length}`,
        `round=${roundRef.current}`,
        `t=${((Date.now() - startedAtRef.current) / 1000).toFixed(1)}`,
      ].join(" ");
      const write = isNative
        ? appendDiagnosticLog(file, line)
        : fetch("/pixel-error-test/entry", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file, result }),
          }).then(() => undefined);
      void write.catch((error: unknown) => console.error("[gaze] failed to write diagnostic log:", error));
    }
    setPointProgress(0);
    if (idx + 1 >= targets.length) {
      // Pass finished: reshuffle and go around again (never "done" on its own).
      roundRef.current += 1;
      setRound(roundRef.current);
      setTargets(buildTestGrid());
      setIdx(0);
    } else {
      setIdx(idx + 1);
    }
  };

  const stop = () => { setPointProgress(1); setDone(true); };

  // Esc stops the run.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") stop(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const valid = results.filter((r) => Number.isFinite(r.err));
  const viewportW = typeof window === "undefined" ? 1 : window.innerWidth;
  const viewportH = typeof window === "undefined" ? 1 : window.innerHeight;
  const mean = valid.length ? valid.reduce((s, r) => s + r.err, 0) / valid.length : NaN;
  const meanPx = valid.length
    ? valid.reduce((s, r) => s + Math.hypot((r.ex - r.tx) * viewportW, (r.ey - r.ty) * viewportH), 0) / valid.length
    : NaN;
  const max = valid.length ? Math.max(...valid.map((r) => r.err)) : NaN;
  const restart = () => {
    setResults([]);
    roundRef.current = 1; setRound(1);
    startedAtRef.current = Date.now();
    setTargets(buildTestGrid());
    setIdx(0);
    setDone(false);
    setPointProgress(0);
    startDiagnosticLog();
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 90, background: "var(--bg)", overflow: "hidden" }} className="fade-enter">
      <div style={{ position: "absolute", top: "var(--s-6)", left: 0, right: 0, textAlign: "center", zIndex: 2 }}>
        <h2 style={{ fontSize: 20 }}>{done ? "Accuracy results" : "Accuracy test"}</h2>
        <p className="dim" style={{ fontSize: 14, marginTop: 6 }}>
          {done
            ? `Mean error ${meanPx.toFixed(1)} px · normalized ${(mean * 100).toFixed(1)}% · worst ${(max * 100).toFixed(1)}%`
            : `Look straight at the dot · pass ${round}, ${idx + 1} of ${targets.length} · ${valid.length} logged${valid.length ? ` · mean ${meanPx.toFixed(0)} px` : ""} · Esc or Stop to finish`}
        </p>
      </div>

      {!done && (
        <button data-dwell data-test-control="true" data-dwell-ms="2500" data-dwell-settle="600" onClick={stop}
          style={{ position: "absolute", top: "var(--s-6)", right: "var(--s-6)", zIndex: 3,
            padding: "8px 18px", borderRadius: "var(--radius-md)", background: "var(--accent-soft)",
            color: "var(--accent)", fontSize: 13, fontWeight: 600 }}>Stop test</button>
      )}

      {!done && (
        <div
          style={{ position: "absolute", left: `${targets[idx]!.x * 100}%`, top: `${targets[idx]!.y * 100}%`,
          transform: "translate(-50%,-50%)", textAlign: "center" }}>
          <div style={{ width: 22, height: 22, borderRadius: 999, background: "var(--accent)",
            boxShadow: "0 0 18px var(--accent)" }} />
          <div style={{ position: "absolute", top: 34, left: "50%", transform: "translateX(-50%)",
            width: 72, height: 4, borderRadius: 99, background: "var(--stroke)", overflow: "hidden" }}>
            <div style={{ width: `${pointProgress * 100}%`, height: "100%",
              background: "var(--accent)", transition: "width 50ms linear" }} />
          </div>
        </div>
      )}

      {done && (
        <>
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
            {results.slice(-150).map((r, i) => Number.isFinite(r.err) && (
              <line key={i} x1={`${r.tx * 100}%`} y1={`${r.ty * 100}%`} x2={`${r.ex * 100}%`} y2={`${r.ey * 100}%`}
                stroke={errColor(r.err)} strokeWidth={2} opacity={0.55} />
            ))}
          </svg>
          {results.slice(-150).map((r, i) => (
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
                    {`${(Math.hypot((r.ex - r.tx) * viewportW, (r.ey - r.ty) * viewportH)).toFixed(0)} px`}
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
          {logFile && <div className="dim" style={{ position: "absolute", bottom: 12, left: 0, right: 0, textAlign: "center", fontSize: 11 }}>
            Log: {logFile}
          </div>}
        </>
      )}
    </div>
  );
}
