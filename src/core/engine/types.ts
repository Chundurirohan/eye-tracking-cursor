export interface GazePoint { x: number; y: number; }
export interface HeadPose { yaw: number; pitch: number; roll: number; }
export type GazeStatus = "ok" | "low_confidence" | "no_face";

/** The raw per-frame signal calibration fits on (NOT screen-mapped).
 * `ix`/`iy` are the mean iris offset; the optional fields add per-eye detail and
 * head position/distance so calibration can compensate for head movement (the
 * single biggest accuracy killer in landmark-based gaze). Older callers/tests
 * that set only ix/iy/yaw/pitch still work — the basis falls back. */
export interface GazeFeature {
  ix: number;
  iy: number;
  yaw: number;
  pitch: number;
  lix?: number; liy?: number;   // left-eye iris offset
  rix?: number; riy?: number;   // right-eye iris offset
  hx?: number; hy?: number;     // head center offset within the frame
  dist?: number;                // inter-ocular distance (closeness to the camera)
}

export interface GazeFrame {
  timestamp: number;
  point: GazePoint | null;
  rawPoint: GazePoint | null;
  feature: GazeFeature | null;
  confidence: number;
  factors: ConfidenceFactors | null;
  headPose: HeadPose | null;
  status: GazeStatus;
  eyeOpenness: { left: number; right: number } | null;
}

export interface EngineCapabilities {
  name: string;
  supportsHeadPose: boolean;
  supportsIris: boolean;
}

/** A single normalized landmark (x,y in [0,1] of the video frame). Structurally
 * compatible with MediaPipe's NormalizedLandmark, kept local so the engine
 * contract doesn't leak the vendor type. */
export interface FaceLandmark { x: number; y: number; z: number; visibility?: number; }

/** Per-factor breakdown of the confidence score (each 0–1). Surfaced so the UI
 * can tell the user *which* thing is limiting accuracy, not just that it's low.
 * `fit` is null until a calibration model exists. */
export interface ConfidenceFactors {
  face: number;
  openness: number;
  pose: number;
  fit: number | null;
}
