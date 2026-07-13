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

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 1-D constant-velocity Kalman filter. State = [position, velocity]; covariance
 * P = [[a,b],[b,d]] (symmetric). Standard predict/update with a continuous
 * white-noise-acceleration process model. */
class Kalman1D {
  private p = 0; private v = 0;
  private a = 1; private b = 0; private d = 1;
  constructor(private q = 3.0) {}

  reset(p0: number) { this.p = p0; this.v = 0; this.a = 1; this.b = 0; this.d = 1; }
  /** Increase velocity uncertainty so the filter re-acquires fast (saccade). */
  boostVel(extra: number) { this.d += extra; }

  step(z: number, dt: number, R: number): { p: number; v: number } {
    // Predict: x = F x, P = F P Fᵀ + Q,  F = [[1,dt],[0,1]]
    this.p += this.v * dt;
    const q = this.q;
    const a2 = this.a + 2 * dt * this.b + dt * dt * this.d + (q * dt * dt * dt) / 3;
    const b2 = this.b + dt * this.d + (q * dt * dt) / 2;
    const d2 = this.d + q * dt;
    // Update with position measurement z (H = [1,0]):
    const S = a2 + R;
    const k0 = a2 / S;
    const k1 = b2 / S;
    const y = z - this.p;
    this.p += k0 * y;
    this.v += k1 * y;
    this.a = (1 - k0) * a2;
    this.b = (1 - k0) * b2;
    this.d = d2 - k1 * b2;
    return { p: this.p, v: this.v };
  }
}

/**
 * Adaptive + predictive cursor filter. Combines four things:
 *  1. Predictive Kalman — a constant-velocity model that estimates velocity and
 *     projects the output `LEAD` seconds ahead, so the cursor sits where the eye
 *     is NOW instead of lagging the ~pipeline latency behind it.
 *  2. Adaptive measurement noise — R scales up as confidence drops, so the
 *     filter trusts the measurement when tracking is clean and coasts on the
 *     model (smoother) when it's noisy.
 *  3. Saccade handling — on a large raw jump, velocity uncertainty is boosted so
 *     the filter snaps to the new location instead of dragging behind it.
 *  4. Fixation lock — when velocity is near zero, the output is pulled to a
 *     running centroid, killing residual jitter so targets are easy to hold.
 */
export class AdaptivePredictiveFilter {
  private kx = new Kalman1D();
  private ky = new Kalman1D();
  private last: { x: number; y: number; t: number } | null = null;
  private hist: { x: number; y: number }[] = [];

  // Tunables (normalized screen units, seconds). Best-guessed; safe to adjust.
  private static BASE_R = 0.0009;   // measurement variance at full confidence
  private static R_CONF_GAIN = 8;   // how much low confidence inflates R
  private static SACCADE_V = 2.4;   // units/sec — above this, treat as a saccade
  private static LEAD = 0.05;       // seconds of predictive lead at full confidence
  private static FIX_LOW = 0.28;    // below this speed → fully locked to centroid
  private static FIX_HIGH = 1.2;    // above this speed → fully live (no lock)
  private static WINDOW = 10;       // frames for the fixation centroid

  update(mx: number, my: number, confidence: number, tMs: number): { x: number; y: number } {
    const t = tMs / 1000;
    if (!this.last) {
      this.kx.reset(mx); this.ky.reset(my);
      this.last = { x: mx, y: my, t };
      this.hist = [{ x: mx, y: my }];
      return { x: mx, y: my };
    }
    const dt = clamp(t - this.last.t, 1e-3, 0.1);
    const rawSpeed = Math.hypot(mx - this.last.x, my - this.last.y) / dt;
    this.last = { x: mx, y: my, t };

    const c = clamp(confidence, 0, 1);
    const R = AdaptivePredictiveFilter.BASE_R * (1 + AdaptivePredictiveFilter.R_CONF_GAIN * (1 - c));
    if (rawSpeed > AdaptivePredictiveFilter.SACCADE_V) { this.kx.boostVel(6); this.ky.boostVel(6); }

    const sx = this.kx.step(mx, dt, R);
    const sy = this.ky.step(my, dt, R);

    // Fixation centroid (over recent Kalman positions).
    this.hist.push({ x: sx.p, y: sy.p });
    if (this.hist.length > AdaptivePredictiveFilter.WINDOW) this.hist.shift();
    let cxs = 0, cys = 0;
    for (const h of this.hist) { cxs += h.x; cys += h.y; }
    const cx = cxs / this.hist.length, cy = cys / this.hist.length;

    // Predictive lead — scaled by confidence so a shaky signal doesn't overshoot.
    const lead = AdaptivePredictiveFilter.LEAD * c;
    let ox = sx.p + sx.v * lead;
    let oy = sy.p + sy.v * lead;

    // Fixation lock: blend toward the centroid when nearly still (w=0 = locked,
    // w=1 = fully live predicted point).
    const speed = Math.hypot(sx.v, sy.v);
    const w = clamp(
      (speed - AdaptivePredictiveFilter.FIX_LOW) /
        (AdaptivePredictiveFilter.FIX_HIGH - AdaptivePredictiveFilter.FIX_LOW),
      0, 1,
    );
    ox = cx + (ox - cx) * w;
    oy = cy + (oy - cy) * w;

    return { x: clamp01(ox), y: clamp01(oy) };
  }

  reseed(x: number, y: number, tMs: number) { this.reset(); return this.update(x, y, 1, tMs); }
  reset() { this.last = null; this.hist = []; this.kx.reset(0); this.ky.reset(0); }
}
