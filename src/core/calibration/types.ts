import type { GazeFeature, HeadPose } from "../engine/types";

export type HeadDirection = "center" | "left" | "right" | "up" | "down";

export interface CalibrationSample { feature: GazeFeature; confidence: number; }

export interface CalibrationPoint {
  id: number;
  x: number;
  y: number;
  variation: HeadDirection;
  samples: CalibrationSample[];
}

export interface CalibrationModel {
  wx: number[];
  wy: number[];
  residual: number;
  /** Per-point residual anchors for local correction: after the global fit, the
   * leftover error at each calibration point (where it landed vs. where it
   * should have) is stored and smoothly interpolated at runtime, snapping
   * predictions toward the calibrated truth in each screen region. */
  anchors?: { px: number; py: number; dx: number; dy: number }[];
}

export type { HeadPose };
