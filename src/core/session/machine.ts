import type { PersistedSession } from "./persistence";

export type AppState =
  | "boot" | "permissions" | "calibrating" | "tracking"
  | "reacquiring" | "paused" | "error";

export interface ResumeDecision {
  target: "permissions" | "calibrating" | "tracking" | "paused";
  reason: string;
}

export type AppEvent =
  | { type: "BOOT_DONE"; resume: ResumeDecision }
  | { type: "PERMISSION_GRANTED" }
  | { type: "PERMISSION_DENIED"; reason: string }
  | { type: "CALIBRATION_COMPLETE"; quality: number }
  | { type: "CALIBRATION_FAILED"; weakPointIds: number[] }
  | { type: "START_RECALIBRATION"; weakPointIds?: number[] }
  | { type: "CONFIDENCE_LOST" }
  | { type: "CONFIDENCE_RECOVERED" }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "CAMERA_INTERRUPTED" }
  | { type: "CAMERA_RESTORED" }
  | { type: "FATAL"; message: string };

export interface SessionContext {
  quality: number;
  weakPointIds: number[];
  error: string | null;
  pausedByCamera: boolean;
}

// Calibration quality is a blend of detection confidence and fit residual
// (see CalibrationController.finish). On the feature scale this engine produces,
// a genuinely good calibration lands around 0.65–0.8, so the pass bar lives just
// below that. A value near 1.0 is unreachable and would trap the user in an
// endless recalibration loop.
export const QUALITY_THRESHOLD = 0.6;

export const initialContext: SessionContext = {
  quality: 0, weakPointIds: [], error: null, pausedByCamera: false,
};

export interface Machine { state: AppState; context: SessionContext; }

export function reduce(m: Machine, e: AppEvent): Machine {
  const { state, context } = m;
  switch (e.type) {
    case "BOOT_DONE":
      return { state: e.resume.target, context };
    case "PERMISSION_GRANTED":
      return state === "permissions" ? { state: "calibrating", context } : m;
    case "PERMISSION_DENIED":
      return { state: "permissions", context: { ...context, error: e.reason } };
    case "CALIBRATION_COMPLETE":
      // Pure transition: the decision to accept vs. retry lives with the caller
      // (App), which owns the attempt budget and best-effort fallback. Reaching
      // this event means "accept and start tracking".
      return {
        state: "tracking",
        context: { ...context, quality: e.quality, error: null, weakPointIds: [] },
      };
    case "CALIBRATION_FAILED":
      return { state: "calibrating", context: { ...context, weakPointIds: e.weakPointIds } };
    case "START_RECALIBRATION":
      return { state: "calibrating", context: { ...context, weakPointIds: e.weakPointIds ?? [] } };
    case "CONFIDENCE_LOST":
      return state === "tracking" ? { state: "reacquiring", context } : m;
    case "CONFIDENCE_RECOVERED":
      return state === "reacquiring" ? { state: "tracking", context } : m;
    case "PAUSE":
      return (state === "tracking" || state === "reacquiring")
        ? { state: "paused", context: { ...context, pausedByCamera: false } } : m;
    case "RESUME":
      if (state === "paused" && context.quality >= QUALITY_THRESHOLD)
        return { state: "tracking", context: { ...context, pausedByCamera: false } };
      if (state === "paused") return { state: "calibrating", context };
      return m;
    case "CAMERA_INTERRUPTED":
      return { state: "paused", context: { ...context, pausedByCamera: true } };
    case "CAMERA_RESTORED":
      return (state === "paused" && context.pausedByCamera)
        ? { state: "reacquiring", context: { ...context, pausedByCamera: false } } : m;
    case "FATAL":
      return { state: "error", context: { ...context, error: e.message } };
    default:
      return m;
  }
}

const STALE_MS = 1000 * 60 * 60 * 12;
export function isCalibrationStale(savedAt: number): boolean {
  return Date.now() - savedAt > STALE_MS;
}

export function decideResume(saved: PersistedSession | null): ResumeDecision {
  if (!saved || !saved.permissionGranted)
    return { target: "permissions", reason: "First launch or no camera permission" };
  if (!saved.calibration || saved.calibration.quality < QUALITY_THRESHOLD)
    return { target: "calibrating", reason: "No valid calibration" };
  if (isCalibrationStale(saved.calibration.savedAt))
    return { target: "calibrating", reason: "Calibration expired" };
  if (saved.pauseOnStartup)
    return { target: "paused", reason: "User prefers paused start" };
  return { target: "tracking", reason: "Valid calibration; resuming tracking" };
}
