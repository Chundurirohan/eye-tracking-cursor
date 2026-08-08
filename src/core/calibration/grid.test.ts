import { describe, it, expect } from "vitest";
import { buildGrid, fitCalibration, applyCalibration, featureBasis } from "./grid";
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

  it("regularises harder on a noisy signal, keeping predictions stable", () => {
    // Regression for the moving-phase cursor swinging wildly on a laptop panel.
    // A fixed lambda fits 17 basis terms from 25 screen positions; when the signal
    // is weak (a small close screen needs far less eye rotation, so noise is a
    // much bigger share of it) that overfits and prediction VARIANCE explodes.
    // Telemetry showed the cursor sweeping the full screen with pursuit
    // correlation flapping 0%–83% — high variance, not a frozen cursor.
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    const noisy: CalibrationPoint[] = [];
    let id = 0;
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        const x = 0.1 + gx * 0.2, y = 0.1 + gy * 0.2;
        const samples = [];
        for (let k = 0; k < 8; k++) {
          samples.push({
            // Weak gain, noise on the same order as the signal.
            feature: { ix: (x - 0.5) * 0.3 + rnd() * 0.08, iy: (y - 0.5) * 0.3 + rnd() * 0.08, yaw: 0, pitch: 0 },
            confidence: 0.9,
          });
        }
        noisy.push({ id: id++, x, y, variation: "center", samples });
      }
    }

    // Same generator, but a strong clean signal — what an external monitor gives.
    const clean: CalibrationPoint[] = [];
    id = 0;
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        const x = 0.1 + gx * 0.2, y = 0.1 + gy * 0.2;
        const samples = [];
        for (let k = 0; k < 8; k++) {
          samples.push({ feature: { ix: (x - 0.5) * 1.4, iy: (y - 0.5) * 1.4, yaw: 0, pitch: 0 }, confidence: 0.9 });
        }
        clean.push({ id: id++, x, y, variation: "center", samples });
      }
    }

    const noisyFit = fitCalibration(noisy);
    const cleanFit = fitCalibration(clean);
    // The whole point: the penalty must RESPOND to signal quality. A weak signal
    // has to be regularised harder or the fit chases noise. (Measured: clean
    // selects 1e-3, noisy selects 1e-1 — a 100× difference.)
    expect(noisyFit.lambda!).toBeGreaterThan(cleanFit.lambda!);
    // And a fixed penalty cannot do this at all — it is the same number always.
    expect(fitCalibration(noisy, 1e-2).lambda).toBe(fitCalibration(clean, 1e-2).lambda);
  });

  it("keeps the local correction bounded and fading with distance", () => {
    // Regression for the moving-phase reticle pinning low and juddering between
    // two spots on a laptop (weaker fit => bigger anchor residuals) while being
    // fine on an external monitor.
    //
    // Normalising the residual interpolation by `wsum` alone is scale-free: far
    // from every anchor the weights are tiny but their RATIO is unchanged, so the
    // nearest anchor's residual still applied at full strength. One badly-fit
    // grid point could then drag the cursor across the screen, and noise flipping
    // which anchor dominates teleported it between two positions.
    const model = {
      wx: [0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      wy: [0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      residual: 0.1,
      // A single, badly-fit anchor in the far corner with a huge residual.
      anchors: [{ px: 0.05, py: 0.05, dx: 0.9, dy: 0.9 }],
    };
    const n = featureBasis({ ix: 0, iy: 0, yaw: 0, pitch: 0 }).length;
    model.wx = Array(n).fill(0); model.wx[0] = 0.5;
    model.wy = Array(n).fill(0); model.wy[0] = 0.5;

    // Probe lands at screen centre (0.5, 0.5) — far from that lone anchor, so its
    // pull must have largely decayed rather than applying in full.
    const out = applyCalibration(model, { ix: 0, iy: 0, yaw: 0, pitch: 0 });
    expect(Math.hypot(out.x - 0.5, out.y - 0.5)).toBeLessThan(0.2);
    // And no correction may ever exceed the cap, whatever the residual.
    expect(out.x).toBeLessThan(0.99);
    expect(out.y).toBeLessThan(0.99);
  });

  it("returns the screen center for an empty model", () => {
    expect(applyCalibration({ wx: [], wy: [], residual: 1 }, { ix: 0.5, iy: 0.5, yaw: 0, pitch: 0 }))
      .toEqual({ x: 0.5, y: 0.5 });
  });
});
