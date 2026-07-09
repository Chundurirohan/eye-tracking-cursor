/** Shared mapping from a 0–1 confidence/quality score to a label + color, so
 * the calibration meter, tracking meter, and diagnostics all read the same. */
export interface ConfidenceLook { label: string; color: string; }

export function confidenceLook(v: number): ConfidenceLook {
  if (v >= 0.8) return { label: "Strong", color: "#34d399" };
  if (v >= 0.65) return { label: "Good", color: "#4ade80" };
  if (v >= 0.45) return { label: "Fair", color: "#fbbf24" };
  if (v > 0) return { label: "Poor", color: "#f87171" };
  return { label: "No signal", color: "#6b7280" };
}
