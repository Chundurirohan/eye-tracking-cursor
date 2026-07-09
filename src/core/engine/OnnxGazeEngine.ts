import type { IGazeEngine } from "./IGazeEngine";
import type { GazeFrame, EngineCapabilities } from "./types";
import type { CalibrationModel } from "../calibration/types";

export class OnnxGazeEngine implements IGazeEngine {
  readonly capabilities: EngineCapabilities = {
    name: "ONNX Appearance Model (experimental)",
    supportsHeadPose: true,
    supportsIris: false,
  };
  async init(): Promise<void> { throw new Error("OnnxGazeEngine not enabled in V1. See docs/LICENSING.md."); }
  estimate(): GazeFrame { throw new Error("not initialized"); }
  setCalibration(_m: CalibrationModel | null): void {}
  reseedSmoothing(_x: number, _y: number, _n: number): void {}
  dispose(): void {}
}
