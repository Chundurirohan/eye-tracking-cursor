import type { ConfidenceFactors } from "@/core/engine/types";
import { sampleBlockers } from "@/core/engine/confidence";

export interface Coaching {
  headline: string;
  tips: string[];
}

/** Advice for getting an acceptable calibration reading, derived from the exact
 * same `sampleBlockers` the controller uses to accept a sample. The contract:
 * if this returns null, the calibration controller is collecting the frame — so
 * the user is never told to fix something while also being stuck. Returns null
 * when there's nothing the user could improve. */
export function calibrationCoaching(factors: ConfidenceFactors | null): Coaching | null {
  if (!factors) {
    return {
      headline: "I can't see your face",
      tips: [
        "Center your whole face in the camera view.",
        "Add light in front of you — avoid a bright window or lamp behind your head.",
      ],
    };
  }

  const blockers = sampleBlockers(factors);
  if (blockers.length === 0) return null;

  const tips: string[] = [];
  if (blockers.includes("eyes")) {
    tips.push("Open your eyes naturally and look right at the dot — try not to squint.");
    tips.push("If you wear glasses, tip your head slightly to clear glare off the lenses.");
  }
  if (blockers.includes("head")) {
    tips.push("Square up to the screen: head upright and centered, not turned or tilted.");
  }
  if (blockers.includes("face")) {
    tips.push("Move so your face is fully visible and fills more of the frame.");
  }
  tips.push("Sit about an arm's length away with even, front-facing light.");

  return { headline: "Let's sharpen the reading", tips };
}
