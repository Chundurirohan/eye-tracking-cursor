import type { GazeFeature } from "../engine/types";
import type { CalibrationModel, CalibrationPoint, CalibrationSample, HeadDirection } from "./types";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Component-wise median feature — a robust per-point representative that shrugs
 * off a few stray frames (a blink, a glance away mid-dwell). */
export function medianFeature(samples: CalibrationSample[]): GazeFeature {
  const m = (g: (s: CalibrationSample) => number) => median(samples.map(g));
  return {
    ix: m((s) => s.feature.ix), iy: m((s) => s.feature.iy),
    yaw: m((s) => s.feature.yaw), pitch: m((s) => s.feature.pitch),
    lix: m((s) => s.feature.lix ?? s.feature.ix), liy: m((s) => s.feature.liy ?? s.feature.iy),
    rix: m((s) => s.feature.rix ?? s.feature.ix), riy: m((s) => s.feature.riy ?? s.feature.iy),
    hx: m((s) => s.feature.hx ?? 0), hy: m((s) => s.feature.hy ?? 0),
    dist: m((s) => s.feature.dist ?? 0),
  };
}

/** Keep the `keepFrac` of a point's samples closest to its median feature,
 * discarding the rest as outliers. Done at fit time (not as a live gate), so it
 * cleans bad frames without ever being able to block collection. */
export function trimmedSamples(samples: CalibrationSample[], keepFrac = 0.7): CalibrationSample[] {
  if (samples.length <= 4) return samples;
  const m = medianFeature(samples);
  const dist = (f: GazeFeature) =>
    Math.hypot(f.ix - m.ix, f.iy - m.iy) + 0.3 * Math.hypot(f.yaw - m.yaw, f.pitch - m.pitch);
  const sorted = [...samples].sort((a, b) => dist(a.feature) - dist(b.feature));
  return sorted.slice(0, Math.max(4, Math.ceil(samples.length * keepFrac)));
}

/** Mean reprojection error of a point's samples under a model — how far the
 * model places this point's gaze from where the point actually is. Used to flag
 * weak points for a re-do. Infinity when the point has no samples. */
export function pointResidual(m: CalibrationModel, p: CalibrationPoint): number {
  if (!p.samples.length) return Infinity;
  let e = 0;
  for (const s of p.samples) {
    const q = applyCalibration(m, s.feature);
    e += Math.hypot(q.x - p.x, q.y - p.y);
  }
  return e / p.samples.length;
}

export function buildGrid(): CalibrationPoint[] {
  const rows = 5, cols = 5;
  const variations: HeadDirection[] = ["center", "left", "right", "up", "down"];
  const pts: CalibrationPoint[] = [];
  let id = 0;
  const margin = 0.08;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = margin + (c / (cols - 1)) * (1 - 2 * margin);
      const y = margin + (r / (rows - 1)) * (1 - 2 * margin);
      pts.push({ id: id++, x, y, variation: variations[(r + c) % variations.length]!, samples: [] });
    }
  }
  return pts;
}

export function featureBasis(f: GazeFeature): number[] {
  const { ix, iy, yaw, pitch } = f;
  const lix = f.lix ?? ix, liy = f.liy ?? iy;
  const rix = f.rix ?? ix, riy = f.riy ?? iy;
  const hx = f.hx ?? 0, hy = f.hy ?? 0, dist = f.dist ?? 0;
  return [
    1,
    lix, liy, rix, riy,        // per-eye iris
    yaw, pitch,                // head pose
    hx, hy, dist,              // head position + distance
    ix * ix, iy * iy, ix * iy, // iris curvature (screen corners)
    ix * dist, iy * dist,      // distance compensation (closer/farther)
    ix * yaw, iy * pitch,      // head-pose compensation
    hx * ix, hy * iy,          // head-translation compensation
  ];
}

/** Number of basis terms — used to reject a stale saved calibration whose model
 * was fit against a different (older) feature basis. */
export const FEATURE_BASIS_DIM = featureBasis({ ix: 0, iy: 0, yaw: 0, pitch: 0 }).length;

function ridge(X: number[][], y: number[], lambda: number): number[] {
  const n = X[0]!.length;
  const A = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b = new Array<number>(n).fill(0);
  for (let r = 0; r < X.length; r++) {
    for (let i = 0; i < n; i++) {
      b[i]! += X[r]![i]! * y[r]!;
      for (let j = 0; j < n; j++) A[i]![j]! += X[r]![i]! * X[r]![j]!;
    }
  }
  for (let i = 0; i < n; i++) A[i]![i]! += lambda;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r]![i]!) > Math.abs(A[p]![i]!)) p = r;
    [A[i], A[p]] = [A[p]!, A[i]!]; [b[i], b[p]] = [b[p]!, b[i]!];
    const piv = A[i]![i]! || 1e-9;
    for (let j = i; j < n; j++) A[i]![j]! /= piv;
    b[i]! /= piv;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = A[r]![i]!;
      for (let j = i; j < n; j++) A[r]![j]! -= f * A[i]![j]!;
      b[r]! -= f * b[i]!;
    }
  }
  return b;
}

const dot = (w: number[], x: number[]) => w.reduce((s, wi, i) => s + wi * (x[i] ?? 0), 0);

export function fitCalibration(points: CalibrationPoint[], lambda = 1e-2): CalibrationModel {
  const X: number[][] = [], yx: number[] = [], yy: number[] = [];
  for (const p of points) {
    for (const s of p.samples) {
      X.push(featureBasis(s.feature));
      yx.push(p.x); yy.push(p.y);
    }
  }
  if (X.length < 8) throw new Error("Insufficient calibration samples");

  // Standardize each basis column (except the intercept) before ridge, so the
  // penalty is applied fairly across features of very different scales
  // (iris ~±1 vs inter-ocular distance ~0.1). Without this, ridge shrinks the
  // large-scale iris terms hardest and the cursor's range collapses toward the
  // screen center. Weights are folded back to raw space so applyCalibration is
  // unchanged.
  const n = X[0]!.length;
  const mean = new Array(n).fill(0), std = new Array(n).fill(1);
  for (let i = 1; i < n; i++) {
    let m = 0; for (const r of X) m += r[i]!; m /= X.length;
    let v = 0; for (const r of X) { const d = r[i]! - m; v += d * d; }
    mean[i] = m; std[i] = Math.sqrt(v / X.length) || 1;
  }
  const Xs = X.map((r) => r.map((v, i) => (i === 0 ? 1 : (v - mean[i]!) / std[i]!)));

  const toRaw = (ws: number[]): number[] => {
    const w = new Array(n).fill(0);
    let b = ws[0]!;
    for (let i = 1; i < n; i++) { w[i] = ws[i]! / std[i]!; b -= ws[i]! * mean[i]! / std[i]!; }
    w[0] = b;
    return w;
  };
  const wx = toRaw(ridge(Xs, yx, lambda));
  const wy = toRaw(ridge(Xs, yy, lambda));

  let err = 0;
  for (let i = 0; i < X.length; i++) {
    const px = dot(wx, X[i]!), py = dot(wy, X[i]!);
    err += Math.hypot(px - yx[i]!, py - yy[i]!);
  }

  // Local correction anchors: per grid point, the residual between where the
  // global model places its (median) gaze and where the point actually is.
  const anchors: NonNullable<CalibrationModel["anchors"]> = [];
  for (const p of points) {
    if (p.id >= 1000 || !p.samples.length) continue; // grid (dwell) points only
    const b = featureBasis(medianFeature(p.samples));
    const px = dot(wx, b), py = dot(wy, b);
    anchors.push({ px, py, dx: p.x - px, dy: p.y - py });
  }

  return { wx, wy, residual: err / X.length, anchors };
}

const CORRECT_SIGMA = 0.15; // screen-fraction radius of local-correction influence

export function applyCalibration(m: CalibrationModel, f: GazeFeature) {
  const b = featureBasis(f);
  // Guard a stale/empty model (e.g. one fit against an older feature basis):
  // park at center rather than emitting a wild cursor until recalibration.
  if (m.wx.length !== b.length || m.wy.length !== b.length) return { x: 0.5, y: 0.5 };
  let x = dot(m.wx, b), y = dot(m.wy, b);

  // Local correction: smoothly interpolate the calibration residuals near this
  // prediction, snapping it toward the calibrated truth in this screen region.
  if (m.anchors && m.anchors.length) {
    const s2 = 2 * CORRECT_SIGMA * CORRECT_SIGMA;
    let wsum = 0, dx = 0, dy = 0;
    for (const a of m.anchors) {
      const w = Math.exp(-((x - a.px) ** 2 + (y - a.py) ** 2) / s2);
      wsum += w; dx += w * a.dx; dy += w * a.dy;
    }
    if (wsum > 1e-6) { x += dx / wsum; y += dy / wsum; }
  }
  return { x: clamp01(x), y: clamp01(y) };
}
