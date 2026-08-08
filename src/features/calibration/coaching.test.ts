import { describe, it, expect } from "vitest";
import { calibrationCoaching } from "./coaching";

const good = { face: 1, openness: 1, pose: 1, fit: null };

describe("calibrationCoaching", () => {
  it("returns null when nothing is actionable — the sample gets accepted instead", () => {
    // The core contract the user asked for: if there's no improvement to
    // suggest, don't nag — the controller accepts the frame.
    expect(calibrationCoaching(good)).toBeNull();
    // A bad fit factor must NOT produce advice (the user can't act on it) and
    // must not block: only face/eyes/head are actionable.
    expect(calibrationCoaching({ face: 1, openness: 1, pose: 1, fit: 0 })).toBeNull();
  });

  it("tells the user to fix lighting/framing when there's no face at all", () => {
    const c = calibrationCoaching(null);
    expect(c).not.toBeNull();
    expect(c!.headline).toMatch(/face/i);
    expect(c!.tips.length).toBeGreaterThan(0);
  });

  it("calls out the eyes when openness is the limiting factor", () => {
    const c = calibrationCoaching({ face: 1, openness: 0.3, pose: 1, fit: null });
    expect(c).not.toBeNull();
    expect(c!.tips.join(" ")).toMatch(/eyes|squint|glasses/i);
  });

  it("calls out head pose when the user is turned", () => {
    const c = calibrationCoaching({ face: 1, openness: 1, pose: 0.5, fit: null });
    expect(c!.tips.join(" ")).toMatch(/square up|head|turned|tilted/i);
  });
});
