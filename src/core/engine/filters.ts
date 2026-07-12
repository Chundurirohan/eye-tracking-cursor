export class OneEuroFilter {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev: number | null = null;

  constructor(private minCutoff = 1.0, private beta = 0.007, private dCutoff = 1.0) {}

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x: number, tSeconds: number): number {
    if (this.tPrev === null || this.xPrev === null) {
      this.tPrev = tSeconds; this.xPrev = x; return x;
    }
    const dt = Math.max(1e-3, tSeconds - this.tPrev);
    const dx = (x - this.xPrev) / dt;
    const aD = this.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this.alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat; this.dxPrev = dxHat; this.tPrev = tSeconds;
    return xHat;
  }

  reset(): void { this.xPrev = null; this.dxPrev = 0; this.tPrev = null; }
}

export class GazeSmoother {
  // Two-mode cursor. A single filter can't serve both goals: heavy smoothing
  // gives rock-steady fixations (good for dwell) but lags badly on saccades;
  // light smoothing tracks saccades but jitters at rest. So we smooth calmly by
  // default (low minCutoff kills fixation jitter) and, when a saccade is
  // detected (velocity spike), drop the filter history so the cursor TELEPORTS
  // to the new location instead of gliding behind it.
  private fx = new OneEuroFilter(1.3, 0.015);
  private fy = new OneEuroFilter(1.3, 0.015);
  private last: { x: number; y: number; t: number } | null = null;

  // Normalized screen units per second. Deliberate gaze jumps far exceed this;
  // fixation jitter stays well below it.
  private static SACCADE_V = 2.6;

  filter(x: number, y: number, tMs: number) {
    const t = tMs / 1000;
    if (this.last) {
      const dt = Math.max(1e-3, t - this.last.t);
      const v = Math.hypot(x - this.last.x, y - this.last.y) / dt;
      if (v > GazeSmoother.SACCADE_V) { this.fx.reset(); this.fy.reset(); } // teleport
    }
    this.last = { x, y, t };
    return { x: this.fx.filter(x, t), y: this.fy.filter(y, t) };
  }

  reseed(x: number, y: number, tMs: number) { this.reset(); return this.filter(x, y, tMs); }
  reset() { this.fx.reset(); this.fy.reset(); this.last = null; }
}
