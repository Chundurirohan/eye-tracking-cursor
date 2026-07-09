import type { HeadPose, ConfidenceFactors } from "./types";
import type { CalibrationPoint } from "../calibration/types";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export interface ConfidenceArgs {
  faceScore: number;
  eyeOpenness: number;
  headPose: HeadPose | null;
  /**
   * Reprojection error of the *current* calibration model, or `null` when no
   * model exists yet (i.e. during calibration sample collection). When null the
   * "fit" factor is omitted entirely instead of defaulting to a worst-case
   * value — otherwise the geometric mean would collapse to ~0 and confidence
   * could never clear the sampling gate, stalling calibration on point one.
   */
  reprojectionError: number | null;
}

/** Break the confidence score into its named factors (each 0–1). */
export function confidenceFactors(args: ConfidenceArgs): ConfidenceFactors {
  const { faceScore, eyeOpenness, headPose, reprojectionError } = args;
  const face = clamp01(faceScore);
  // Forgiving openness curve: smaller/partially-lidded eyes (distance, eyelid
  // shape, a webcam that under-reads aperture) should still score usably. Only
  // genuinely shut eyes fall toward zero.
  const openness = clamp01((eyeOpenness - 0.08) / 0.42);
  // Soft pose factor with a floor: extreme head orientation lowers confidence
  // but can NOT drive it to zero. Calibration intentionally samples varied head
  // directions (left/right/up/down), so head pose must not hard-gate sampling —
  // and a constant convention offset must not pin the whole score near zero.
  const poseRaw = headPose
    ? clamp01(1 - (Math.abs(headPose.yaw) + Math.abs(headPose.pitch)) / 1.6)
    : 0.7;
  const pose = 0.55 + 0.45 * poseRaw;
  const fit = reprojectionError != null ? clamp01(1 - reprojectionError / 0.12) : null;
  return { face, openness, pose, fit };
}

/** Geometric mean of the *live* factors — face, eye openness, head pose. These
 * are the things that vary per frame and signal whether THIS frame is reliable.
 *
 * `fit` is intentionally excluded: it's the calibration model's overall
 * reprojection error, a CONSTANT every frame. Folding a constant into per-frame
 * confidence just shifts the whole range down — a model with a mediocre residual
 * would pin confidence below the reacquire threshold forever, leaving tracking
 * permanently stuck on "reacquiring". `fit` is kept on the factor breakdown for
 * diagnostics, but it does not gate live confidence. */
export function confidenceOf(f: ConfidenceFactors): number {
  const factors = [f.face, f.openness, f.pose];
  const eps = 1e-3;
  const logMean = factors.reduce((s, x) => s + Math.log(x + eps), 0) / factors.length;
  return clamp01(Math.exp(logMean));
}

export function computeConfidence(args: ConfidenceArgs): number {
  return confidenceOf(confidenceFactors(args));
}

/** The only factors the *user* can act on. `fit` is deliberately excluded: it
 * reflects a calibration model, not anything the person can change by adjusting
 * how they sit, so it must never block collecting a calibration sample. */
export const SAMPLE_MINIMUMS = { face: 0.6, openness: 0.6, pose: 0.62 } as const;

export type SampleBlocker = "face" | "eyes" | "head";

/** Which user-controllable factors are too low to trust this frame. An empty
 * list means there is nothing the user could improve — so the frame should be
 * accepted as a calibration sample regardless of the composite confidence. */
export function sampleBlockers(f: ConfidenceFactors): SampleBlocker[] {
  const out: SampleBlocker[] = [];
  if (f.face < SAMPLE_MINIMUMS.face) out.push("face");
  if (f.openness < SAMPLE_MINIMUMS.openness) out.push("eyes");
  if (f.pose < SAMPLE_MINIMUMS.pose) out.push("head");
  return out;
}

export interface WeakPointReport {
  overallQuality: number;
  weakPointIds: number[];
  needsRecalibration: boolean;
}

export function analyzeCalibration(points: CalibrationPoint[], targetQuality = 0.9): WeakPointReport {
  const scored = points.map((p) => ({
    id: p.id,
    q: p.samples.length ? p.samples.reduce((s, v) => s + v.confidence, 0) / p.samples.length : 0,
  }));
  const overall = scored.reduce((s, p) => s + p.q, 0) / Math.max(1, scored.length);
  const weak = scored.filter((p) => p.q < targetQuality).map((p) => p.id);
  return { overallQuality: overall, weakPointIds: weak, needsRecalibration: overall < targetQuality };
}
