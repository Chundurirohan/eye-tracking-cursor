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
  // Higher minCutoff + beta = the cursor keeps up with the gaze (responsive)
  // instead of lagging heavily behind it, while still steadying at a fixation.
  private fx = new OneEuroFilter(2.2, 0.02);
  private fy = new OneEuroFilter(2.2, 0.02);

  filter(x: number, y: number, tMs: number) {
    const t = tMs / 1000;
    return { x: this.fx.filter(x, t), y: this.fy.filter(y, t) };
  }

  reseed(x: number, y: number, tMs: number) { this.reset(); return this.filter(x, y, tMs); }
  reset() { this.fx.reset(); this.fy.reset(); }
}
