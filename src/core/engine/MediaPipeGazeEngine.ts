import { devLog } from "@/core/system/nativeInput";
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

  async init(): Promise<void> {
    if (this.landmarker) return;
    // Vendored locally by `scripts/setup-assets.mjs` and shipped in the bundle.
    //
    // These were previously fetched from a CDN on every launch. That made the app
    // require an internet connection to do anything, and — because the webview
    // holds the full native IPC bridge and the app holds Accessibility — it meant
    // a CDN compromise could execute code with cursor and keyboard control of the
    // user's machine. Loading from the bundle removes that path entirely and is
    // what the strict CSP in tauri.conf.json now enforces.
    const make = async (delegate: "GPU" | "CPU") => {
      // A fresh fileset per attempt: a failed GPU start can leave the wasm module unusable.
      const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
      // WebKitGTK can't make a WebGL context on MediaPipe's default OffscreenCanvas
      // (the "kGpuService" / GLctx errors), but does on a real, in-DOM-less canvas.
      const canvas = document.createElement("canvas");
      canvas.width = 640; canvas.height = 480;
      let glOk = false;
      try { glOk = !!(canvas.getContext("webgl2") ?? canvas.getContext("webgl")); } catch { /* none */ }
      devLog(`WebGL on a regular canvas: ${glOk ? "available" : "NOT available"}`);
      return FaceLandmarker.createFromOptions(fileset, {
        canvas,
        baseOptions: { modelAssetPath: "/mediapipe/face_landmarker.task", delegate },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: true,
      });
    };
    try {
      this.landmarker = await make("GPU");
    } catch (err) {
      // No WebGL context (common in WebKitGTK / Linux VMs / blocklisted GPUs): run on CPU.
      console.warn("[gaze] GPU delegate unavailable, falling back to CPU:", err);
      devLog("MediaPipe: GPU delegate unavailable, using CPU");
      this.landmarker = await make("CPU");
    }
  }

  private diagAt = 0; private diagN = 0; private diagFaces = 0; private diagMs = 0; private diagErr = "";
  /** Once every 3s, print detection stats to the terminal (webview console isn't reachable). */
  private diag(t0: number, face: boolean, err?: unknown): void {
    const t = performance.now();
    this.diagN++; this.diagMs += t - t0; if (face) this.diagFaces++;
    if (err && !this.diagErr) this.diagErr = err instanceof Error ? err.message : String(err);
    if (t - this.diagAt < 3000) return;
    if (this.diagN > 1) {
      devLog(`detect: ${this.diagN} frames, ${this.diagFaces} with face, avg ${(this.diagMs / this.diagN).toFixed(0)}ms${this.diagErr ? `, error: ${this.diagErr}` : ""}`);
    }
    this.diagAt = t; this.diagN = 0; this.diagFaces = 0; this.diagMs = 0; this.diagErr = "";
  }

  setCalibration(model: CalibrationModel | null): void { this.calibration = model; }
  reseedSmoothing(x: number, y: number, now: number): void { this.smoother.reseed(x, y, now); }

  estimate(video: HTMLVideoElement, now: number): GazeFrame {
    if (!this.landmarker || video.readyState < 2) return this.empty(now, "no_face");

    let result: FaceLandmarkerResult;
    const t0 = performance.now();
    try {
      result = this.landmarker.detectForVideo(video, now);
    } catch (err) {
      this.diag(t0, false, err);
      return this.empty(now, "no_face");
    }
    this.diag(t0, !!result.faceLandmarks?.length);
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
