// Pose-adaptive gaze correction.
//
// A single static calibration can't survive head movement — the further your
// head drifts from the pose you calibrated in, the more wrong the mapping gets.
// This keeps a small set of correction "anchors" KEYED TO HEAD POSE, and applies
// a pose-weighted blend of them to the gaze point. As your head moves into a new
// posture, the correction for that posture applies — so it re-centers itself
// instead of decaying.
//
// Two ways anchors are set:
//  - reanchor(): a STRONG, reliable correction from a manual re-anchor (the user
//    looked at a known on-screen dot). Can't corrupt — it's a real truth point.
//  - observe(): a WEAK, automatic correction from a confirmed click on a known
//    target. Bounded + slow so a noisy click can't run it away.

export type Pose = { yaw: number; pitch: number };
export type Pt = { x: number; y: number };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const clampAbs = (v: number, m: number) => Math.min(m, Math.max(-m, v));

type Anchor = { yaw: number; pitch: number; dx: number; dy: number; strong: boolean };

export class PoseAdaptiveCorrector {
  private anchors: Anchor[] = [];
  private poseSigma = 0.12;   // radians — influence radius in head-pose space
  private mergeDist = 0.06;   // radians — merge new samples into a nearby anchor
  private maxAnchors = 16;
  private maxOffset = 0.16;   // clamp correction to a fraction of the screen
  private autoRate = 0.15;    // learning rate for automatic (click) anchors

  /** Pose-weighted correction applied to a gaze point. */
  apply(p: Pt, pose: Pose | null): Pt {
    if (!this.anchors.length || !pose) return p;
    const s2 = 2 * this.poseSigma * this.poseSigma;
    let wsum = 0, dx = 0, dy = 0;
    for (const a of this.anchors) {
      const d2 = (pose.yaw - a.yaw) ** 2 + (pose.pitch - a.pitch) ** 2;
      const w = Math.exp(-d2 / s2) * (a.strong ? 1.6 : 1);
      wsum += w; dx += w * a.dx; dy += w * a.dy;
    }
    if (wsum < 1e-6) return p;
    return { x: clamp01(p.x + dx / wsum), y: clamp01(p.y + dy / wsum) };
  }

  /** Strong correction from a manual re-anchor: user's gaze while looking at a
   *  known target `dot`. Fully replaces a nearby strong anchor. */
  reanchor(gaze: Pt, dot: Pt, pose: Pose | null): void {
    if (!pose) return;
    this.merge(pose, dot.x - gaze.x, dot.y - gaze.y, true, 1);
  }

  /** Weak, bounded correction from a confirmed click on a known target. */
  observe(gaze: Pt, target: Pt, pose: Pose | null): void {
    if (!pose) return;
    const rx = target.x - gaze.x, ry = target.y - gaze.y;
    if (Math.hypot(rx, ry) > 0.22) return; // reject implausible residuals
    this.merge(pose, rx, ry, false, this.autoRate);
  }

  private merge(pose: Pose, rx: number, ry: number, strong: boolean, rate: number): void {
    const near = this.anchors.find(
      (a) => a.strong === strong && Math.hypot(a.yaw - pose.yaw, a.pitch - pose.pitch) < this.mergeDist,
    );
    if (near) {
      near.dx = clampAbs(near.dx + rate * (rx - near.dx), this.maxOffset);
      near.dy = clampAbs(near.dy + rate * (ry - near.dy), this.maxOffset);
      return;
    }
    this.anchors.push({
      yaw: pose.yaw, pitch: pose.pitch,
      dx: clampAbs(strong ? rx : rate * rx, this.maxOffset),
      dy: clampAbs(strong ? ry : rate * ry, this.maxOffset),
      strong,
    });
    if (this.anchors.length > this.maxAnchors) {
      const i = this.anchors.findIndex((a) => !a.strong); // drop a weak one first
      this.anchors.splice(i >= 0 ? i : 0, 1);
    }
  }

  reset(): void { this.anchors = []; }
}
