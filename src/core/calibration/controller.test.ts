import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CalibrationController, type CalibrationProgress } from "./controller";
import type { IGazeEngine } from "../engine/IGazeEngine";
import type { GazeFrame, ConfidenceFactors } from "../engine/types";

// A cooperative-user engine stub. The gaze feature is a clean linear map of the
// point the controller is currently asking the user to look at (read via
// `getTarget`), so the ridge fit is well-conditioned and the provisional model
// drives the moving cursor onto the target (high velocity correlation =>
// "following"). `confidence`/`factors`/`noFace` exercise the gates.
function makeEngine(opts: {
  getTarget: () => { x: number; y: number };
  confidence?: number;
  factors?: ConfidenceFactors | null;
  noFace?: boolean;
}): IGazeEngine {
  const confidence = opts.confidence ?? 0.9;
  return {
    capabilities: { name: "stub", supportsHeadPose: true, supportsIris: true },
    init: async () => {},
    setCalibration: () => {},
    setCollecting: () => {},
    reseedSmoothing: () => {},
    dispose: () => {},
    estimate: (_v, now): GazeFrame => {
      if (opts.noFace) {
        return { timestamp: now, point: null, rawPoint: null, feature: null, confidence: 0,
          factors: null, headPose: null, eyeOpenness: null, status: "no_face" };
      }
      const t = opts.getTarget();
      const feature = { ix: (t.x - 0.5) * 1.4, iy: (t.y - 0.5) * 1.4, yaw: 0, pitch: 0 };
      const factors = opts.factors !== undefined ? opts.factors
        : { face: 1, openness: 1, pose: 1, fit: null };
      return { timestamp: now, point: null, rawPoint: null, feature, confidence, factors,
        headPose: { yaw: 0, pitch: 0, roll: 0 }, eyeOpenness: { left: 0.9, right: 0.9 }, status: "ok" };
    },
  };
}

let queue: Array<() => void>;
let clock: number;

beforeEach(() => {
  queue = [];
  clock = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queue.push(() => cb(clock));
    return queue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function drive(maxTicks: number, stepMs: number, onTick?: () => boolean) {
  for (let i = 0; i < maxTicks; i++) {
    clock += stepMs;
    const pending = queue;
    queue = [];
    pending.forEach((fn) => fn());
    if (onTick && onTick()) return;
  }
}

const fakeVideo = { readyState: 4 } as unknown as HTMLVideoElement;

/** Runs a calibration to completion, following the current target the way a
 * real user's eyes would. */
function runCalibration(
  build: (getTarget: () => { x: number; y: number }) => IGazeEngine,
  opts: { weak?: number[]; ticks?: number } = {},
): {
  maxIndex: number;
  completed: { quality: number; weak: number[] } | null;
  model: { wx: number[]; wy: number[]; residual: number } | null;
  sawMoving: boolean;
} {
  let target = { x: 0.5, y: 0.5 };
  const getTarget = () => target;
  let maxIndex = 0;
  let completed: { quality: number; weak: number[] } | null = null;
  let model: { wx: number[]; wy: number[]; residual: number } | null = null;
  let sawMoving = false;

  const ctrl = new CalibrationController(
    build(getTarget),
    fakeVideo,
    (p: CalibrationProgress) => {
      if (p.movingPos) { target = p.movingPos; sawMoving = true; }
      else if (p.point) { target = { x: p.point.x, y: p.point.y }; maxIndex = Math.max(maxIndex, p.index); }
    },
    (m, quality, weak) => { model = m; completed = { quality, weak }; },
  );

  ctrl.start(opts.weak);
  drive(opts.ticks ?? 4500, 30, () => completed !== null);
  ctrl.stop();
  return { maxIndex, completed, model, sawMoving };
}

describe("CalibrationController", () => {
  it("dwells each point, runs the moving passes, and completes with a usable model", () => {
    const r = runCalibration((getTarget) => makeEngine({ getTarget }));
    expect(r.maxIndex).toBeGreaterThan(0);      // advanced past the first point
    expect(r.sawMoving).toBe(true);             // reached the smooth-pursuit phase
    expect(r.completed).not.toBeNull();
    expect(r.model!.wx.length).toBeGreaterThan(0);
    expect(r.completed!.quality).toBeGreaterThan(0);
  });

  it("never gets stuck: advances on the dwell timer even when confidence is pinned low", () => {
    // Regression for the stale-fit cap AND the outlier-deadlock: a low composite
    // confidence (with strong actionable factors) must not stall a point.
    const r = runCalibration((getTarget) =>
      makeEngine({ getTarget, confidence: 0.18, factors: { face: 1, openness: 1, pose: 1, fit: 0 } }));
    expect(r.maxIndex).toBeGreaterThan(0);
    expect(r.completed).not.toBeNull();
  });

  it("does not produce a usable calibration when there is no face", () => {
    // Always advances (no stall), but with no samples the fit can't succeed, so
    // the model is empty rather than fabricated.
    const r = runCalibration((getTarget) => makeEngine({ getTarget, noFace: true }), { ticks: 4500 });
    expect(r.completed).not.toBeNull();
    expect(r.model!.wx.length).toBe(0);
  });

  it("calibrates only the requested weak points and skips the moving phase", () => {
    const r = runCalibration((getTarget) => makeEngine({ getTarget }), { weak: [0, 1, 2] });
    expect(r.completed).not.toBeNull();
    expect(r.sawMoving).toBe(false);
  });
});
