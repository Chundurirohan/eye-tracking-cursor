import type { GazeFrame, EngineCapabilities, FaceLandmark } from "./types";
import type { CalibrationModel } from "../calibration/types";

export interface IGazeEngine {
  readonly capabilities: EngineCapabilities;
  init(): Promise<void>;
  estimate(video: HTMLVideoElement, now: number): GazeFrame;
  setCalibration(model: CalibrationModel | null): void;
  reseedSmoothing(x: number, y: number, now: number): void;
  dispose(): void;
  /** Most recent face landmarks (normalized to the video frame), for overlay
   * rendering. Optional — engines that don't expose landmarks return null. */
  getLandmarks?(): FaceLandmark[] | null;
  /** Enter/leave calibration-sample-collection mode. While active the engine
   * must not apply the current model's fit factor to confidence. */
  setCollecting?(active: boolean): void;
}
