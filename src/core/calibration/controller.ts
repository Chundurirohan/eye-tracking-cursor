import type { IGazeEngine } from "../engine/IGazeEngine";
import { buildGrid, fitCalibration, applyCalibration, trimmedSamples, pointResidual } from "./grid";
import type { CalibrationModel, CalibrationPoint, HeadDirection } from "./types";
import type { ConfidenceFactors } from "../engine/types";

export interface CalibrationProgress {
  index: number;
  total: number;
  point: CalibrationPoint | null;
  prompt: HeadDirection;
  phase: "collect" | "moving" | "fitting" | "done";
  /** Progress (0–1) through the current point's dwell window — drives the
   * shrinking-target animation that captures and holds the user's fixation. */
  dwell: number;
  /** True during the brief weak-point re-do pass at the end. */
  refining: boolean;
  movingPos: { x: number; y: number } | null;
  /** Live gaze cursor during the moving phase (from the provisional model). */
  cursorPos: { x: number; y: number } | null;
  /** Moving phase: the gaze is following the target (velocity-correlated). */
  inRange: boolean;
  /** A sample is being collected right now (dwell window open, or following). */
  settled: boolean;
  pass: number;
  passes: number;
  confidence: number;
  factors: ConfidenceFactors | null;
}

// --- Dwell (static point) collection ---------------------------------------
const SETTLE_MS = 500;            // saccade-to-target latency we skip before collecting
const COLLECT_MS = 1800;          // window we actually gather frames in (longer = steadier)
const POINT_MS = SETTLE_MS + COLLECT_MS; // hard per-point duration — ALWAYS advances after this
const COLLECT_FLOOR = 0.45;       // stricter: only keep clearly-good frames
const SAMPLE_CAP = 60;
const MIN_INFER_MS = 30;          // cap inference at ~30/s (a 60fps camera would otherwise burn ~80% of the main thread)
// Confidence-aware auto-advance (vision §Calibration): a point that has already
// banked plenty of clean samples finishes early — calibration feels fast when
// the signal is good, without ever being able to BLOCK advancement (the hard
// POINT_MS timer below still guarantees progress).
const EARLY_MIN_MS = 1200;        // never leave a point before this (not rushed)
const EARLY_SAMPLES = 18;         // clean samples that count as "enough"

// --- Smooth-pursuit (moving) collection ------------------------------------
const MOVING_PASSES = 3;
const MOVING_DURATION_MS = 7000;
const PURSUIT_WINDOW_MS = 380;    // window over which we correlate eye vs target motion
const FOLLOW_COS = 0.45;          // stricter: eye must clearly track the target to collect
const MIN_TARGET_MOTION = 0.02;   // target must have moved this much to judge following
// Smooth-pursuit latency: the eyes trail a moving target by ~this long, so a
// collected frame's gaze corresponds to where the target was PURSUIT_LAG_MS ago,
// not its current position. Pairing with the lagged position removes a
// systematic bias that otherwise throws tracking off.
const PURSUIT_LAG_MS = 110;
const MOVING_PATHS = [
  { ax: 0.4, ay: 0.32, fx: 0.9, fy: 0.6, px: 0.0, py: 1.2 },
  { ax: 0.42, ay: 0.34, fx: 0.6, fy: 1.0, px: 1.4, py: 0.0 },
  { ax: 0.38, ay: 0.36, fx: 1.1, fy: 0.7, px: 2.2, py: 0.6 },
];

// --- Weak-point re-do -------------------------------------------------------
const WEAK_RESIDUAL = 0.12;       // grid point reprojects worse than this => re-do it
const MAX_REDO_POINTS = 6;        // bound the re-do so it stays quick

export class CalibrationController {
  private points: CalibrationPoint[] = [];
  private queue: number[] = [];     // indices into `points` to dwell-collect
  private qi = 0;
  private mode: "grid" | "refine" = "grid";
  private refined = false;
  private pointEnteredAt = 0;
  private phase: CalibrationProgress["phase"] = "collect";
  private raf = 0;
  private weakOnly: number[] | null = null;
  private stopped = false;
  private lastConfidence = 0;
  private lastFactors: ConfidenceFactors | null = null;
  // Inference gate: only run the (expensive) face estimate when the camera has
  // produced a new frame, so the deterministic dot animation can run at display
  // refresh rate and stay smooth regardless of inference cost (spec §D).
  private lastVideoTime = -1;
  private lastInferAt = 0;

  private provisional: CalibrationModel | null = null;

  // Moving phase.
  private movingPass = 0;
  private passes = MOVING_PASSES; // reduced in "quick" mode
  private passStart = 0;
  private cursor: { x: number; y: number } | null = null;
  private pursuit: { cx: number; cy: number; tx: number; ty: number; t: number }[] = [];

  constructor(
    private engine: IGazeEngine,
    private video: HTMLVideoElement,
    private onProgress: (p: CalibrationProgress) => void,
    private onComplete: (model: CalibrationModel, quality: number, weak: number[]) => void
  ) {}

  start(weakPointIds?: number[], mode: "full" | "quick" = "full") {
    const all = buildGrid(mode);
    if (weakPointIds && weakPointIds.length) {
      this.weakOnly = weakPointIds;
      this.points = all.filter((p) => weakPointIds.includes(p.id));
    } else {
      this.weakOnly = null;
      this.points = all;
    }
    this.passes = mode === "quick" ? 1 : MOVING_PASSES;
    this.queue = this.points.map((_, i) => i);
    this.qi = 0; this.mode = "grid"; this.refined = false;
    this.phase = "collect"; this.pointEnteredAt = performance.now();
    this.stopped = false; this.provisional = null; this.movingPass = 0; this.pursuit.length = 0;
    this.lastVideoTime = -1;
    this.engine.setCollecting?.(true);
    this.loop();
  }

  /** Whether to run inference this tick: the camera must have produced a new
   * frame AND at least MIN_INFER_MS must have passed — telemetry showed a 60fps
   * camera driving MediaPipe 60×/s at ~13ms each (~80% of the main thread),
   * which is what made calibration feel awful even at a reported 60fps. ~30/s
   * sampling is all the pipeline needs. Returns true (never throttles) when the
   * video has no numeric `currentTime` — e.g. a test stub. */
  private frameAdvanced(now: number): boolean {
    const vt = this.video.currentTime;
    if (typeof vt !== "number") return true;
    if (vt === this.lastVideoTime) return false;
    if (now - this.lastInferAt < MIN_INFER_MS) return false;
    this.lastVideoTime = vt;
    this.lastInferAt = now;
    return true;
  }

  // Perf telemetry: RAF rate + inference cost, logged every ~2s so a "laggy"
  // report comes with numbers (low raf = main-thread/GPU starvation; high infer
  // = model cost). Only on a real video (silent in tests).
  private perfT = 0;
  private perfFrames = 0;
  private perfInferN = 0;
  private perfInferMs = 0;

  private estimateTimed(now: number) {
    const t0 = performance.now();
    const frame = this.engine.estimate(this.video, now);
    this.perfInferMs += performance.now() - t0;
    this.perfInferN++;
    return frame;
  }

  private perfTick(now: number) {
    if (typeof this.video.currentTime !== "number") return;
    this.perfFrames++;
    if (!this.perfT) { this.perfT = now; return; }
    const dt = now - this.perfT;
    if (dt < 2000) return;
    const raf = (this.perfFrames * 1000) / dt;
    const inferHz = (this.perfInferN * 1000) / dt;
    const avg = this.perfInferN ? this.perfInferMs / this.perfInferN : 0;
    const msg = `phase=${this.phase} raf=${raf.toFixed(0)}fps infer=${inferHz.toFixed(0)}/s avg=${avg.toFixed(1)}ms`;
    console.info(`[gaze][calib-perf] ${msg}`);
    // Fan out to the app shell, which pipes it to the terminal via Rust (the
    // webview console isn't visible in `tauri dev`). Keeps this core layer
    // free of any Tauri import.
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("gaze:perf", { detail: msg }));
    this.perfT = now; this.perfFrames = 0; this.perfInferN = 0; this.perfInferMs = 0;
  }

  stop() { this.stopped = true; this.engine.setCollecting?.(false); cancelAnimationFrame(this.raf); }

  private loop = () => {
    if (this.stopped) return;
    const now = performance.now();
    this.perfTick(now);
    if (this.phase === "collect") this.tickCollect(now);
    else if (this.phase === "moving") this.tickMoving(now);
    if (!this.stopped) this.raf = requestAnimationFrame(this.loop);
  };

  // --- Dwell window: collect every usable frame, ALWAYS advance on the timer --
  private tickCollect(now: number) {
    const pIndex = this.queue[this.qi];
    if (pIndex == null) return this.afterQueue();
    const point = this.points[pIndex]!;

    const elapsed = now - this.pointEnteredAt;
    const collecting = elapsed >= SETTLE_MS && elapsed < POINT_MS;

    // Inference (+ sample collection) only when the camera frame advanced; the
    // dwell animation below is emitted every frame so it stays smooth.
    if (this.frameAdvanced(now)) {
      const frame = this.estimateTimed(now);
      this.lastConfidence = frame.confidence;
      this.lastFactors = frame.factors;
      if (collecting && frame.feature && frame.confidence >= COLLECT_FLOOR && point.samples.length < SAMPLE_CAP) {
        point.samples.push({ feature: frame.feature, confidence: frame.confidence });
      }
    }

    this.emitCollect(point, Math.min(1, elapsed / POINT_MS), collecting);

    // Confidence-aware early advance (grid pass only — refine points carry
    // samples from the first pass, so sample count there isn't fresh evidence).
    const earlyDone = this.mode === "grid" && elapsed >= EARLY_MIN_MS && point.samples.length >= EARLY_SAMPLES;

    // Hard guarantee: no per-point gate. After the window we move on no matter
    // what, so a point can never trap the user.
    if (elapsed >= POINT_MS || earlyDone) {
      this.qi++; this.pointEnteredAt = now;
      if (this.qi >= this.queue.length) this.afterQueue();
    }
  }

  private afterQueue() {
    this.refit();
    if (this.weakOnly) return this.finish(); // externally-requested weak-only run: no moving phase
    // grid -> moving, and (after weak-point re-collection) refine -> moving AGAIN,
    // so the repeated pursuit pass is fit against the improved point set.
    this.beginMoving();
  }

  private refit() {
    const pts = this.points.filter((p) => p.samples.length > 0);
    const total = pts.reduce((s, p) => s + p.samples.length, 0);
    if (total >= 8) {
      try { this.provisional = fitCalibration(pts.map((p) => ({ ...p, samples: trimmedSamples(p.samples) }))); }
      catch { /* keep previous */ }
    }
  }

  private beginMoving() {
    if (!this.provisional) return this.finish(); // not enough to drive a cursor
    this.phase = "moving";
    this.movingPass = 0; this.passStart = performance.now(); this.pursuit.length = 0;
  }

  // --- Smooth pursuit: collect only while the eye is FOLLOWING the target -----
  private tickMoving(now: number) {
    const elapsed = now - this.passStart;
    const t = elapsed / 1000;
    const path = MOVING_PATHS[this.movingPass % MOVING_PATHS.length]!;
    // The target's path is a pure function of time — computed EVERY frame so the
    // dot animates at display refresh rate regardless of inference cadence.
    const tx = 0.5 + path.ax * Math.sin(t * path.fx + path.px);
    const ty = 0.5 + path.ay * Math.sin(t * path.fy + path.py);

    // Inference (+ pursuit sampling) only when the camera frame advanced.
    let following = this.isFollowing();
    if (this.frameAdvanced(now)) {
      const frame = this.estimateTimed(now);
      this.lastConfidence = frame.confidence;
      this.lastFactors = frame.factors;
      this.cursor = null;
      if (frame.feature && this.provisional) {
        this.cursor = applyCalibration(this.provisional, frame.feature);
        this.pursuit.push({ cx: this.cursor.x, cy: this.cursor.y, tx, ty, t: now });
        while (this.pursuit.length && now - this.pursuit[0]!.t > PURSUIT_WINDOW_MS) this.pursuit.shift();
        following = this.isFollowing();
        if (following && frame.confidence >= COLLECT_FLOOR) {
          // Lag compensation: pair the gaze with where the target was ~110ms ago
          // (latest buffered path point at/older than that), since the eye trails.
          const lagT = now - PURSUIT_LAG_MS;
          let sx = tx, sy = ty;
          for (const e of this.pursuit) { if (e.t <= lagT) { sx = e.tx; sy = e.ty; } }
          this.points.push({
            id: 1000 + this.movingPass * 100000 + Math.round(elapsed),
            x: sx, y: sy, variation: "center",
            samples: [{ feature: frame.feature, confidence: frame.confidence }],
          });
        }
      }
    }

    this.onProgress({
      index: this.movingPass + 1, total: this.passes, point: null, prompt: "center",
      phase: "moving", dwell: 0, refining: false,
      movingPos: { x: tx, y: ty }, cursorPos: this.cursor, inRange: following, settled: following,
      pass: this.movingPass + 1, passes: this.passes,
      confidence: this.lastConfidence, factors: this.lastFactors,
    });

    if (elapsed >= MOVING_DURATION_MS) {
      this.refit(); // progressive: sharpen the cursor for the next sweep
      this.movingPass++;
      this.passStart = now; this.pursuit.length = 0;
      if (this.movingPass >= this.passes) this.endMoving();
    }
  }

  /** Cosine between the eye's recent displacement and the target's: you can't
   * smoothly pursue a target you aren't actually tracking, so this verifies
   * following without depending on the model's absolute accuracy. */
  private isFollowing(): boolean {
    if (this.pursuit.length < 5) return false;
    const a = this.pursuit[0]!, b = this.pursuit[this.pursuit.length - 1]!;
    const tdx = b.tx - a.tx, tdy = b.ty - a.ty;
    const cdx = b.cx - a.cx, cdy = b.cy - a.cy;
    const tmag = Math.hypot(tdx, tdy), cmag = Math.hypot(cdx, cdy);
    if (tmag < MIN_TARGET_MOTION || cmag < 1e-4) return false;
    return (tdx * cdx + tdy * cdy) / (tmag * cmag) > FOLLOW_COS;
  }

  private endMoving() {
    this.refit();
    // One bounded weak-point re-do pass, in-session so all samples are kept and
    // the model is refit with everything (never refit from a tiny subset).
    if (!this.refined && this.provisional) {
      const weak = this.weakGridIndices(this.provisional);
      if (weak.length) {
        this.refined = true; this.mode = "refine";
        this.queue = weak; this.qi = 0;
        this.phase = "collect"; this.pointEnteredAt = performance.now();
        return;
      }
    }
    this.finish();
  }

  private weakGridIndices(model: CalibrationModel): number[] {
    return this.points
      .map((p, i) => ({ i, id: p.id, r: pointResidual(model, p) }))
      .filter((x) => x.id < 1000 && x.r > WEAK_RESIDUAL)
      .sort((a, b) => b.r - a.r)
      .slice(0, MAX_REDO_POINTS)
      .map((x) => x.i);
  }

  private finish() {
    cancelAnimationFrame(this.raf);
    this.engine.setCollecting?.(false);
    this.phase = "fitting"; this.emitCollect(null, 1, false);
    try {
      const trimmed = this.points.map((p) => ({ ...p, samples: trimmedSamples(p.samples) }));
      const model = fitCalibration(trimmed);
      const gridResiduals = trimmed
        .filter((p) => p.id < 1000)
        .map((p) => pointResidual(model, p))
        .filter((r) => Number.isFinite(r));
      const meanRes = gridResiduals.length
        ? gridResiduals.reduce((a, b) => a + b, 0) / gridResiduals.length
        : model.residual;
      const quality = Math.max(0, Math.min(1, 1 - meanRes / 0.1));
      this.phase = "done";
      // Empty weak list: the controller already did its own re-do, so the app
      // should accept this result rather than launch another pass.
      this.onComplete(model, quality, []);
    } catch (err) {
      console.error("[gaze] calibration fit failed:", err);
      this.phase = "done";
      this.onComplete({ wx: [], wy: [], residual: 1 }, 0, []);
    }
  }

  private emitCollect(point: CalibrationPoint | null, dwell: number, collecting: boolean) {
    const pIndex = this.queue[this.qi];
    this.onProgress({
      index: this.mode === "grid" ? this.qi : (pIndex ?? 0),
      total: this.mode === "grid" ? this.queue.length : this.points.length,
      point,
      prompt: point?.variation ?? "center",
      phase: this.phase, dwell, refining: this.mode === "refine",
      movingPos: null, cursorPos: null, inRange: false, settled: collecting,
      pass: 0, passes: this.passes,
      confidence: this.lastConfidence, factors: this.lastFactors,
    });
  }
}
