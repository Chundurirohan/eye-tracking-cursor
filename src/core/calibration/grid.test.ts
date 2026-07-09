import { describe, it, expect } from "vitest";
import { buildGrid, fitCalibration, applyCalibration } from "./grid";
import type { CalibrationPoint } from "./types";
import type { GazeFeature } from "../engine/types";

describe("buildGrid", () => {
  it("produces a 5x5 grid inside the screen margins", () => {
    const grid = buildGrid();
    expect(grid).toHaveLength(25);
    for (const p of grid) {
      expect(p.x).toBeGreaterThanOrEqual(0.08);
      expect(p.x).toBeLessThanOrEqual(0.92);
      expect(p.y).toBeGreaterThanOrEqual(0.08);
      expect(p.y).toBeLessThanOrEqual(0.92);
    }
    expect(new Set(grid.map((p) => p.id)).size).toBe(25);
  });
});

describe("fitCalibration", () => {
  // Synthesize samples from a known linear mapping and confirm the fit recovers
  // it well enough to map features back to screen coordinates.
  const target = (f: GazeFeature) => ({ x: 0.2 + 0.5 * f.ix, y: 0.3 + 0.4 * f.iy });

  function syntheticPoints(): CalibrationPoint[] {
    const pts: CalibrationPoint[] = [];
    let id = 0;
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        const feature: GazeFeature = { ix: i * 0.2, iy: j * 0.2, yaw: 0, pitch: 0 };
        const { x, y } = target(feature);
        pts.push({ id: id++, x, y, variation: "center", samples: [{ feature, confidence: 0.9 }] });
      }
    }
    return pts;
  }

  it("recovers a linear feature->screen mapping", () => {
    const model = fitCalibration(syntheticPoints());
    expect(model.wx.length).toBeGreaterThan(0);
    expect(model.residual).toBeLessThan(0.05);

    const probe: GazeFeature = { ix: 0.3, iy: -0.1, yaw: 0, pitch: 0 };
    const out = applyCalibration(model, probe);
    const want = target(probe);
    expect(Math.abs(out.x - want.x)).toBeLessThan(0.06);
    expect(Math.abs(out.y - want.y)).toBeLessThan(0.06);
  });

  it("throws when there are too few samples to fit", () => {
    const pts: CalibrationPoint[] = [
      { id: 0, x: 0.5, y: 0.5, variation: "center", samples: [{ feature: { ix: 0, iy: 0, yaw: 0, pitch: 0 }, confidence: 0.9 }] },
    ];
    expect(() => fitCalibration(pts)).toThrow();
  });

  it("returns the screen center for an empty model", () => {
    expect(applyCalibration({ wx: [], wy: [], residual: 1 }, { ix: 0.5, iy: 0.5, yaw: 0, pitch: 0 }))
      .toEqual({ x: 0.5, y: 0.5 });
  });
});
