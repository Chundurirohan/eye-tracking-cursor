import { describe, it, expect } from "vitest";
import {
  reduce, initialContext, decideResume, QUALITY_THRESHOLD,
  type Machine,
} from "./machine";
import type { PersistedSession } from "./persistence";

const at = (state: Machine["state"], ctx = initialContext): Machine => ({ state, context: ctx });

describe("session state machine", () => {
  it("boots to the resume target", () => {
    const next = reduce(at("boot"), {
      type: "BOOT_DONE",
      resume: { target: "calibrating", reason: "test" },
    });
    expect(next.state).toBe("calibrating");
  });

  it("moves permissions -> calibrating on grant", () => {
    expect(reduce(at("permissions"), { type: "PERMISSION_GRANTED" }).state).toBe("calibrating");
  });

  it("ignores a grant outside the permissions state", () => {
    expect(reduce(at("tracking"), { type: "PERMISSION_GRANTED" }).state).toBe("tracking");
  });

  it("completes calibration into tracking and clears weak points", () => {
    const start = at("calibrating", { ...initialContext, weakPointIds: [3, 7] });
    const next = reduce(start, { type: "CALIBRATION_COMPLETE", quality: 0.72 });
    expect(next.state).toBe("tracking");
    expect(next.context.quality).toBe(0.72);
    expect(next.context.weakPointIds).toEqual([]);
  });

  it("retries calibration with the weak points on failure", () => {
    const next = reduce(at("calibrating"), { type: "CALIBRATION_FAILED", weakPointIds: [1, 2] });
    expect(next.state).toBe("calibrating");
    expect(next.context.weakPointIds).toEqual([1, 2]);
  });

  it("loses and recovers confidence around tracking", () => {
    const lost = reduce(at("tracking"), { type: "CONFIDENCE_LOST" });
    expect(lost.state).toBe("reacquiring");
    expect(reduce(lost, { type: "CONFIDENCE_RECOVERED" }).state).toBe("tracking");
  });

  it("pauses and resumes when calibration is good", () => {
    const tracking = at("tracking", { ...initialContext, quality: 0.8 });
    const paused = reduce(tracking, { type: "PAUSE" });
    expect(paused.state).toBe("paused");
    expect(reduce(paused, { type: "RESUME" }).state).toBe("tracking");
  });

  it("resumes into recalibration when quality is too low", () => {
    const paused = at("paused", { ...initialContext, quality: 0.2 });
    expect(reduce(paused, { type: "RESUME" }).state).toBe("calibrating");
  });

  it("pauses on camera interruption and reacquires on restore", () => {
    const interrupted = reduce(at("tracking"), { type: "CAMERA_INTERRUPTED" });
    expect(interrupted.state).toBe("paused");
    expect(interrupted.context.pausedByCamera).toBe(true);
    const restored = reduce(interrupted, { type: "CAMERA_RESTORED" });
    expect(restored.state).toBe("reacquiring");
  });
});

describe("decideResume", () => {
  const base: PersistedSession = {
    version: 1, permissionGranted: true, pauseOnStartup: false,
    calibration: { wx: [1], wy: [1], residual: 0.03, quality: 0.8, savedAt: Date.now() },
  };

  it("asks for permission on first launch", () => {
    expect(decideResume(null).target).toBe("permissions");
    expect(decideResume({ ...base, permissionGranted: false }).target).toBe("permissions");
  });

  it("calibrates when no valid calibration is stored", () => {
    expect(decideResume({ ...base, calibration: null }).target).toBe("calibrating");
  });

  it("recalibrates a sub-threshold saved calibration", () => {
    const weak = { ...base, calibration: { ...base.calibration!, quality: QUALITY_THRESHOLD - 0.1 } };
    expect(decideResume(weak).target).toBe("calibrating");
  });

  it("resumes tracking with a valid recent calibration", () => {
    expect(decideResume(base).target).toBe("tracking");
  });

  it("honors a paused-on-startup preference", () => {
    expect(decideResume({ ...base, pauseOnStartup: true }).target).toBe("paused");
  });
});
