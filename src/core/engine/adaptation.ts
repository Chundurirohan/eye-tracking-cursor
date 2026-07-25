// Pose- AND region-adaptive gaze correction.
//
// A single static calibration can't survive head movement OR uneven screen
// accuracy — the further your head drifts from the pose you calibrated in, the
// more wrong the mapping gets, and gaze error is usually worse toward the screen
// edges than at the center. This keeps a small set of correction "anchors" keyed
// to BOTH head pose AND screen region, and applies a distance-weighted blend of
// them. So the correction learned for the top-left corner in a left-turned head
// pose applies there specifically — instead of one global offset smearing
// everywhere. It re-centers itself as you move rather than decaying.
//
// Two ways anchors are set:
//  - reanchor(): a STRONG, reliable correction from a manual re-anchor (the user
//    looked at a known on-screen dot). Can't corrupt — it's a real truth point.
//  - observe(): a WEAK, automatic correction from a confirmed click on a known
//    target. Bounded + slow so a noisy click can't run it away. Every confident
//    click makes the app quietly more accurate in that region + pose.

export type Pose = { yaw: number; pitch: number };
export type Pt = { x: number; y: number };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const clampAbs = (v: number, m: number) => Math.min(m, Math.max(-m, v));

// An anchor: at screen region (sx,sy) and head pose (yaw,pitch), gaze was off by
// (dx,dy) — the correction to add.
type Anchor = { yaw: number; pitch: number; sx: number; sy: number; dx: number; dy: number; strong: boolean };

export class PoseAdaptiveCorrector {
  private anchors: Anchor[] = [];
  private poseSigma = 0.12;    // radians — influence radius in head-pose space
  private screenSigma = 0.20;  // normalized — influence radius in screen space
  private mergeDist = 0.06;    // radians — merge if pose is within this…
  private screenMerge = 0.12;  // …AND screen region is within this
  private maxAnchors = 40;     // a 2D grid (pose × region) needs more room
  private maxOffset = 0.16;    // clamp correction to a fraction of the screen
  private autoRate = 0.15;     // learning rate for automatic (click) anchors

  /** Pose- and region-weighted correction applied to a gaze point. */
  apply(p: Pt, pose: Pose | null): Pt {
    if (!this.anchors.length) return p;
    const ps2 = 2 * this.poseSigma * this.poseSigma;
    const ss2 = 2 * this.screenSigma * this.screenSigma;
    let wsum = 0, dx = 0, dy = 0;
    for (const a of this.anchors) {
      // Screen-space weight (always). Strong (manual re-anchor) corrections reach
      // broadly — a quick global re-center; weak per-click corrections stay local
      // to their region. Pose-space weight only applies if we know the pose.
      const sd2 = (p.x - a.sx) ** 2 + (p.y - a.sy) ** 2;
      let w = Math.exp(-sd2 / (a.strong ? ss2 * 4 : ss2)) * (a.strong ? 1.6 : 1);
      if (pose) {
        const pd2 = (pose.yaw - a.yaw) ** 2 + (pose.pitch - a.pitch) ** 2;
        w *= Math.exp(-pd2 / ps2);
      }
      wsum += w; dx += w * a.dx; dy += w * a.dy;
    }
    if (wsum < 1e-6) return p;
    return { x: clamp01(p.x + dx / wsum), y: clamp01(p.y + dy / wsum) };
  }

  /** Strong correction from a manual re-anchor: user's gaze while looking at a
   *  known target `dot`. Fully replaces a nearby strong anchor in this region. */
  reanchor(gaze: Pt, dot: Pt, pose: Pose | null): void {
    this.merge(pose, dot, dot.x - gaze.x, dot.y - gaze.y, true, 1);
  }

  /** Weak, bounded correction from a confirmed click on a known target. */
  observe(gaze: Pt, target: Pt, pose: Pose | null): void {
    const rx = target.x - gaze.x, ry = target.y - gaze.y;
    if (Math.hypot(rx, ry) > 0.22) return; // reject implausible residuals
    this.merge(pose, target, rx, ry, false, this.autoRate);
  }

  private merge(pose: Pose | null, at: Pt, rx: number, ry: number, strong: boolean, rate: number): void {
    const yaw = pose?.yaw ?? 0, pitch = pose?.pitch ?? 0;
    const near = this.anchors.find(
      (a) => a.strong === strong &&
        Math.hypot(a.sx - at.x, a.sy - at.y) < this.screenMerge &&
        Math.hypot(a.yaw - yaw, a.pitch - pitch) < this.mergeDist,
    );
    if (near) {
      near.dx = clampAbs(near.dx + rate * (rx - near.dx), this.maxOffset);
      near.dy = clampAbs(near.dy + rate * (ry - near.dy), this.maxOffset);
      // Ease the anchor toward where it's actually being reinforced.
      near.sx += 0.2 * (at.x - near.sx);
      near.sy += 0.2 * (at.y - near.sy);
      return;
    }
    this.anchors.push({
      yaw, pitch, sx: at.x, sy: at.y,
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
