import { describe, it, expect } from "vitest";
import { computeConfidence, analyzeCalibration } from "./confidence";
import type { CalibrationPoint } from "../calibration/types";

// The sampling gate the CalibrationController uses to accept a frame.
const CONFIDENCE_GATE = 0.55;

describe("computeConfidence", () => {
  it("clears the calibration sampling gate for a good, uncalibrated face", () => {
    // Regression for the stuck-on-first-point bug: during calibration there is
    // no model yet (reprojectionError = null). A well-lit, centered face must
    // produce confidence well above the gate, otherwise no sample is ever
    // collected and calibration never advances past point one.
    const c = computeConfidence({
      faceScore: 1,
      eyeOpenness: 0.9,
      headPose: { yaw: 0, pitch: 0, roll: 0 },
      reprojectionError: null,
    });
    expect(c).toBeGreaterThan(CONFIDENCE_GATE);
  });

  it("still tolerates a moderate head turn while uncalibrated", () => {
    // Grid variations ask the user to turn slightly; those frames must still
    // clear the gate or directional points would never collect samples.
    const c = computeConfidence({
      faceScore: 1,
      eyeOpenness: 0.9,
      headPose: { yaw: 0.35, pitch: 0.15, roll: 0 },
      reprojectionError: null,
    });
    expect(c).toBeGreaterThan(CONFIDENCE_GATE);
  });

  it("does NOT let the model's fit error collapse live confidence", () => {
    // Regression for the stuck-on-reacquiring bug: the fit residual is constant
    // per frame, so it must not gate live confidence. A good live frame stays
    // high regardless of how poor the calibration model's residual is.
    const live = { faceScore: 1, eyeOpenness: 0.9, headPose: { yaw: 0, pitch: 0, roll: 0 } };
    const poorFit = computeConfidence({ ...live, reprojectionError: 0.5 });
    const goodFit = computeConfidence({ ...live, reprojectionError: 0.03 });
    const noFit = computeConfidence({ ...live, reprojectionError: null });
    expect(poorFit).toBeGreaterThan(CONFIDENCE_GATE);
    expect(poorFit).toBeCloseTo(noFit, 5); // fit has no effect on the score
    expect(goodFit).toBeCloseTo(noFit, 5);
  });

  it("drops with closed eyes", () => {
    const c = computeConfidence({
      faceScore: 1,
      eyeOpenness: 0.1,
      headPose: { yaw: 0, pitch: 0, roll: 0 },
      reprojectionError: null,
    });
    expect(c).toBeLessThan(CONFIDENCE_GATE);
  });
});

describe("analyzeCalibration", () => {
  it("flags low-confidence points as weak", () => {
    const pts: CalibrationPoint[] = [
      { id: 0, x: 0.1, y: 0.1, variation: "center", samples: [{ feature: { ix: 0, iy: 0, yaw: 0, pitch: 0 }, confidence: 0.9 }] },
      { id: 1, x: 0.9, y: 0.9, variation: "center", samples: [{ feature: { ix: 0, iy: 0, yaw: 0, pitch: 0 }, confidence: 0.2 }] },
    ];
    const report = analyzeCalibration(pts, 0.6);
    expect(report.weakPointIds).toContain(1);
    expect(report.weakPointIds).not.toContain(0);
  });
});
