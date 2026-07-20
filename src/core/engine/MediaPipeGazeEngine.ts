import {
  FaceLandmarker, FilesetResolver, type FaceLandmarkerResult,
} from "@mediapipe/tasks-vision";
import type { IGazeEngine } from "./IGazeEngine";
import type { GazeFrame, GazeFeature, HeadPose, EngineCapabilities, FaceLandmark } from "./types";
import { AdaptivePredictiveFilter } from "./filters";
import { confidenceFactors, confidenceOf } from "./confidence";
import type { CalibrationModel } from "../calibration/types";
import { applyCalibration } from "../calibration/grid";

const L_IRIS = [468, 469, 470, 471, 472];
const R_IRIS = [473, 474, 475, 476, 477];
const L_EYE_CORNERS = [33, 133];
const R_EYE_CORNERS = [362, 263];
const L_EYE_LID = [159, 145];
const R_EYE_LID = [386, 374];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// Bundled (offline-capable) MediaPipe assets, served from the app root in both
// dev and the packaged build. CDN URLs are the fallback only.
const LOCAL_WASM = "/mediapipe/wasm";
const LOCAL_MODEL = "/mediapipe/face_landmarker.task";
const CDN_WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const CDN_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

export class MediaPipeGazeEngine implements IGazeEngine {
  readonly capabilities: EngineCapabilities = {
    name: "MediaPipe FaceLandmarker",
    supportsHeadPose: true,
    supportsIris: true,
  };

  private landmarker: FaceLandmarker | null = null;
  private smoother = new AdaptivePredictiveFilter();
  private calibration: CalibrationModel | null = null;
  private collecting = false;
  private lastLandmarks: FaceLandmark[] | null = null;

  getLandmarks(): FaceLandmark[] | null { return this.lastLandmarks; }
  // While collecting calibration samples we are *building* a new model, so the
  // current (possibly stale, possibly bad) model's reprojection error must not
  // factor into confidence — otherwise it caps the score and stalls calibration
  // even when the user is doing everything right.
  setCollecting(active: boolean): void { this.collecting = active; }

  private async build(wasmBase: string, modelPath: string): Promise<FaceLandmarker> {
    const fileset = await FilesetResolver.forVisionTasks(wasmBase);
    return FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelPath, delegate: "GPU" },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: true,
    });
  }

  async init(): Promise<void> {
    if (this.landmarker) return;
    // Prefer the bundled assets (offline-capable); fall back to the CDN if
    // they're missing. Runtime inference speed is unaffected by the source (the
    // GPU delegate does the heavy lifting), so this can't hurt smoothness.
    try {
      this.landmarker = await this.build(LOCAL_WASM, LOCAL_MODEL);
    } catch (err) {
      console.warn("[gaze] bundled MediaPipe assets unavailable — falling back to CDN", err);
      this.landmarker = await this.build(CDN_WASM, CDN_MODEL);
    }
  }

  setCalibration(model: CalibrationModel | null): void { this.calibration = model; }
  reseedSmoothing(x: number, y: number, now: number): void { this.smoother.reseed(x, y, now); }

  estimate(video: HTMLVideoElement, now: number): GazeFrame {
    if (!this.landmarker || video.readyState < 2) return this.empty(now, "no_face");

    let result: FaceLandmarkerResult;
    try {
      result = this.landmarker.detectForVideo(video, now);
    } catch {
      return this.empty(now, "no_face");
    }
    if (!result.faceLandmarks?.length) return this.empty(now, "no_face");

    const lm = result.faceLandmarks[0]!;
    this.lastLandmarks = lm;
    const headPose = this.extractHeadPose(result);
    const eyeOpenness = {
      left: this.eyeOpenness(lm, L_EYE_LID, L_EYE_CORNERS),
      right: this.eyeOpenness(lm, R_EYE_LID, R_EYE_CORNERS),
    };

    const leftVec = this.irisVector(lm, L_IRIS, L_EYE_CORNERS, L_EYE_LID);
    const rightVec = this.irisVector(lm, R_IRIS, R_EYE_CORNERS, R_EYE_LID);

    // Head position + distance from the outer eye corners (33 = left, 263 =
    // right), so calibration can compensate for the head moving/leaning.
    const lo = lm[33]!, ro = lm[263]!;
    // Confidence-weighted eye fusion: weight each eye by its openness so a
    // squinting / occluded / glare-hit eye contributes less (a small floor keeps
    // a fully-closed eye from zeroing the sum). Falls back to equal weight when
    // both eyes are open.
    const wL = Math.max(0.05, eyeOpenness.left);
    const wR = Math.max(0.05, eyeOpenness.right);
    const wSum = wL + wR;
    const feature: GazeFeature = {
      ix: (wL * leftVec.x + wR * rightVec.x) / wSum,
      iy: (wL * leftVec.y + wR * rightVec.y) / wSum,
      lix: leftVec.x, liy: leftVec.y,
      rix: rightVec.x, riy: rightVec.y,
      yaw: headPose?.yaw ?? 0,
      pitch: headPose?.pitch ?? 0,
      hx: (lo.x + ro.x) / 2 - 0.5,
      hy: (lo.y + ro.y) / 2 - 0.5,
      dist: Math.hypot(ro.x - lo.x, ro.y - lo.y),
    };

    let rawPoint: GazeFrame["rawPoint"] = null;
    // null = no fit factor. True when uncalibrated (no model yet) OR while
    // collecting calibration samples (we're rebuilding the model, so judging
    // frames against the old one is wrong and caps the score).
    let reproErr: number | null = null;
    if (this.calibration && !this.collecting) {
      rawPoint = applyCalibration(this.calibration, feature);
      reproErr = this.calibration.residual;
    }

    const factors = confidenceFactors({
      faceScore: 1,
      eyeOpenness: Math.min(eyeOpenness.left, eyeOpenness.right),
      headPose,
      reprojectionError: reproErr,
    });
    const confidence = confidenceOf(factors);

    let point: GazeFrame["point"] = null;
    if (rawPoint && confidence > 0.2) {
      const s = this.smoother.update(rawPoint.x, rawPoint.y, confidence, now);
      point = { x: clamp01(s.x), y: clamp01(s.y) };
    }

    return {
      timestamp: now,
      point,
      rawPoint,
      feature,
      confidence,
      factors,
      headPose,
      eyeOpenness,
      status: confidence < 0.4 ? "low_confidence" : point ? "ok" : "low_confidence",
    };
  }

  dispose(): void {
    this.landmarker?.close();
    this.landmarker = null;
    this.smoother.reset();
  }

  private irisVector(lm: { x: number; y: number }[], iris: number[], corners: number[], lid: number[]) {
    const cx = iris.reduce((s, i) => s + lm[i]!.x, 0) / iris.length;
    const cy = iris.reduce((s, i) => s + lm[i]!.y, 0) / iris.length;
    const outer = lm[corners[0]!]!, inner = lm[corners[1]!]!;
    const upper = lm[lid[0]!]!, lower = lm[lid[1]!]!;
    const w = Math.hypot(inner.x - outer.x, inner.y - outer.y) || 1e-4;
    const h = Math.hypot(lower.y - upper.y, lower.x - upper.x) || 1e-4;
    const midX = (outer.x + inner.x) / 2;
    const midY = (upper.y + lower.y) / 2;
    return { x: (cx - midX) / (w / 2), y: (cy - midY) / (h / 2) };
  }

  private eyeOpenness(lm: { x: number; y: number }[], lid: number[], corners: number[]) {
    const upper = lm[lid[0]!]!, lower = lm[lid[1]!]!;
    const outer = lm[corners[0]!]!, inner = lm[corners[1]!]!;
    const h = Math.hypot(lower.y - upper.y, lower.x - upper.x);
    const w = Math.hypot(inner.x - outer.x, inner.y - outer.y) || 1e-4;
    return clamp01((h / w) * 3.2);
  }

  private extractHeadPose(result: FaceLandmarkerResult): HeadPose | null {
    const m = result.facialTransformationMatrixes?.[0]?.data;
    if (!m) return null;
    const r00 = m[0]!, r10 = m[1]!, r20 = m[2]!, r21 = m[6]!, r22 = m[10]!;
    const pitch = Math.atan2(-r20, Math.hypot(r21, r22));
    const yaw = Math.atan2(r10, r00);
    const roll = Math.atan2(r21, r22);
    return { yaw, pitch, roll };
  }

  private empty(now: number, status: GazeFrame["status"]): GazeFrame {
    this.lastLandmarks = null;
    return { timestamp: now, point: null, rawPoint: null, feature: null, confidence: 0, factors: null, headPose: null, eyeOpenness: null, status };
  }
}
