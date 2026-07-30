import { useEffect, useRef, useState } from "react";
import { confidenceLook } from "@/features/shared/confidenceColor";
import { warpCursor, nativeTargets, nativeScroll } from "@/core/system/nativeInput";

const DWELL_MS = 800;       // hold gaze on a registered clickable this long to act
const FREE_DWELL_MS = 1500; // longer, deliberate dwell where NO clickable is detected
                            // (empty space) — cuts accidental activations
const SNAP_VELOCITY = 1.2;  // normalized units/sec: above this the gaze is moving,
                            // so snapping releases (no "gravity" while switching targets)
const COOLDOWN_MS = 600;    // min gap between clicks
const STALE_MS = 400;       // hide reticle if no gaze sample this recently
const WARP_MS = 20;         // OS-cursor warp throttle
// Render-rate smoothing of the VISIBLE cursor: each 60fps frame the reticle eases
// toward its target by `SMOOTH_MIN + SMOOTH_GAIN·gap`. Small gaps (rest jitter)
// ease slowly → smooth; large gaps (saccades) ramp to a full jump → still snappy.
// This is the "smoothing delay" — the ease introduces a tiny, deliberate lag that
// turns ~30fps steps into a smooth glide, WITHOUT the fragile timestamp buffer.
// Clicks are unaffected (they warp to the true target point at fire time).
const SMOOTH_MIN = 0.16;
const SMOOTH_GAIN = 9;
// Snap radius as a fraction of the smaller screen dimension: gaze only has to
// land within this of a control to lock (magnetically) onto it. Kept modest so
// the cursor doesn't yank to the bar from far away (which reads as "off").
const SNAP_FRAC = 0.048;    // slightly weaker magnet: only captures when you're
                           // clearly on a target, leaving reachable space between
                           // targets (so an UNdetected control beside a detected
                           // one isn't impossible to reach)
const FREE_TOL = 0.06;      // free-space dwell jitter tolerance
const FREE_LEAVE = 0.1;     // leave-to-rearm distance
const ANCHOR_EMA = 0.1;
// Edge-gaze scrolling / hands-free reading: resting gaze in a band near the top
// or bottom edge (clear of the menu bar and Dock) scrolls the page.
const SCROLL_TOP: [number, number] = [0.03, 0.11];    // [min, max] normalized y for "scroll up"
const SCROLL_BOTTOM: [number, number] = [0.89, 0.97]; // [min, max] normalized y for "scroll down"
const SCROLL_DELAY = 400;   // dwell in the band before scrolling starts
const SCROLL_TICK_MS = 40;  // scroll cadence
const SCROLL_STEP = 34;     // pixels per tick
const STICKY_MARGIN = 1.35;    // once dwelling, keep the target until gaze leaves
                               // its bounds by this × the snap radius (no jitter-flip)
// Magnet-fatigue: if you keep approaching a snap target and looking away without
// clicking it (a stubborn neighbor stealing the cursor from what you actually
// want), suppress it so it stops grabbing you until your next click lands.
const REJECT_MIN_PROG = 0.12;  // the dwell must have started for a leave to count
const REJECT_WINDOW = 4500;    // ms — rejections must cluster in time to count
const REJECT_COUNT = 2;        // this many rejections → suppress the target
const SMALL_TARGET = 0.11;     // only auto-learn drift from targets smaller than this
                               // (normalized), where the gaze was genuinely on it
const CONF_RADIUS_GAIN = 0.4;  // low confidence widens the snap radius by up to this
const INTENT_BONUS = 0.4;      // a target dead-on your gaze trajectory reads up to
                               // 40% "closer", so intent — not just proximity — wins
const COMMIT_LOCK = 0.35;      // dwell progress past which the well pulls fully to
                               // center (rock-steady while you commit the click)
const CLICKABLE = 'button, a, [role="button"], input, [data-dwell]';

type P = { x: number; y: number };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A coarse position key (normalized center → ~2% grid) used to identify a snap
 * target across frames for magnet-fatigue, since native targets have no ID. */
const keyOf = (nx: number, ny: number) => `${Math.round(nx * 50)},${Math.round(ny * 50)}`;

/** Nearest clickable in THIS app within `limit` px of (px,py), biased toward the
 * one your gaze is MOVING toward (intent) so dense toolbars resolve the way you
 * mean. `vx,vy` are the normalized gaze velocity components (0,0 = at rest). */
function nearestClickable(px: number, py: number, limit: number, vx: number, vy: number, suppressed: Set<string>): HTMLElement | null {
  const vmag = Math.hypot(vx, vy);
  let best: HTMLElement | null = null, bestScore = limit;
  document.querySelectorAll<HTMLElement>(CLICKABLE).forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    // Magnet-fatigue: ignore a target you keep rejecting.
    if (suppressed.size && suppressed.has(keyOf((r.left + r.width / 2) / window.innerWidth, (r.top + r.height / 2) / window.innerHeight))) return;
    const dx = Math.max(r.left - px, 0, px - r.right);
    const dy = Math.max(r.top - py, 0, py - r.bottom);
    const d = Math.hypot(dx, dy);
    if (d >= limit) return;
    let score = d;
    if (vmag > 0.15) {
      // Cosine alignment of gaze motion with the direction to this target's center.
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const dirx = cx - px, diry = cy - py;
      const dmag = Math.hypot(dirx, diry) || 1;
      const align = Math.max(0, (dirx * vx + diry * vy) / (dmag * vmag));
      score = d * (1 - INTENT_BONUS * align);
    }
    if (score < bestScore) { bestScore = score; best = el; }
  });
  return best;
}

type NativeTarget = { x: number; y: number; w: number; h: number };

/** Nearest system-wide clickable (from the scanner cache) within `limit`
 * NORMALIZED units of (px,py), intent-biased toward gaze motion. All coords are
 * normalized to window content. Returns the target (center + size) or null. */
function nearestNativeTarget(px: number, py: number, limit: number, vx: number, vy: number, list: NativeTarget[], suppressed: Set<string>): NativeTarget | null {
  const vmag = Math.hypot(vx, vy);
  let best: NativeTarget | null = null, bestScore = limit;
  for (const t of list) {
    if (suppressed.size && suppressed.has(keyOf(t.x, t.y))) continue; // magnet-fatigue
    const dx = Math.max(Math.abs(px - t.x) - t.w / 2, 0);
    const dy = Math.max(Math.abs(py - t.y) - t.h / 2, 0);
    const d = Math.hypot(dx, dy);
    if (d >= limit) continue;
    let score = d;
    if (vmag > 0.15) {
      const dirx = t.x - px, diry = t.y - py;
      const dmag = Math.hypot(dirx, diry) || 1;
      const align = Math.max(0, (dirx * vx + diry * vy) / (dmag * vmag));
      score = d * (1 - INTENT_BONUS * align);
    }
    if (score < bestScore) { bestScore = score; best = t; }
  }
  return best;
}

/** Continuous gravity-well pull of the reticle from `p` toward a target `center`
 * — the same crisp magnet the HUD buttons use, applied everywhere. Within the
 * firm INNER zone it locks fully onto center ("clicks into place"); through the
 * outer band it eases in (never weaker than ~half), and low confidence pulls a
 * bit harder. `commit` forces a full lock while a dwell is landing. */
function gravityWell(p: P, center: P, radiusN: number, conf: number, commit: boolean): P {
  if (commit) return center;
  const d = Math.hypot(p.x - center.x, p.y - center.y);
  const inner = radiusN * 0.4;
  if (d <= inner) return center; // firm snap — sit right on the target like the HUD
  const t = clamp01(1 - (d - inner) / (radiusN - inner));
  const smooth = t * t * (3 - 2 * t);
  const strength = clamp01((0.4 + 0.6 * smooth) * (1 + (1 - conf) * 0.3));
  return { x: p.x + (center.x - p.x) * strength, y: p.y + (center.y - p.y) * strength };
}

/** Gaze reticle + dwell-to-click, with magnetic target snapping.
 * - When `armed`: warps the real OS cursor to the gaze (or onto a nearby control
 *   — magnetic), and dwell fires a click (DOM click on our controls, native OS
 *   click into other apps). The reticle is confidence-colored.
 * - When disarmed: the reticle still shows where you're looking, but the OS
 *   cursor is NOT touched (all control to the mouse/trackpad) and dwell is off.
 *   The reticle goes gray so you can see control is released. */
export function DwellCursor({ active, armed, confidence, onNativeClick, onCalibrate, menuOpen = false, onRequestMenu }: {
  active: boolean; armed: boolean; confidence: number | null;
  onNativeClick?: (nx: number, ny: number) => void;
  /** Called on a confirmed click onto a known target center (gaze, target) —
   *  feeds the self-healing drift corrector. Both points are normalized. */
  onCalibrate?: (gaze: P, target: P) => void;
  /** Whether the radial action menu is currently open (suppresses re-opening). */
  menuOpen?: boolean;
  /** A free-space dwell requests the radial action menu at this normalized point. */
  onRequestMenu?: (nx: number, ny: number) => void;
}) {
  const [disp, setDisp] = useState<P | null>(null); // reticle position (may be snapped)
  const [progress, setProgress] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [flash, setFlash] = useState(false);
  const [ripple, setRipple] = useState<{ x: number; y: number; id: number } | null>(null);

  const posRef = useRef<P | null>(null);
  const dispSmoothRef = useRef<P | null>(null); // eased visible-cursor position
  const lastGazeRef = useRef(0);
  const lastWarpRef = useRef(0);
  const targetRef = useRef<HTMLElement | null>(null);
  const freeAnchorRef = useRef<P | null>(null);
  const dwellStartRef = useRef(0);
  const lastClickRef = useRef(0);
  const armedElRef = useRef<HTMLElement | null>(null);
  const armedPosRef = useRef<P | null>(null);
  const clickRef = useRef(onNativeClick);
  clickRef.current = onNativeClick;
  const confRef = useRef(confidence);
  confRef.current = confidence;
  const calibrateRef = useRef(onCalibrate);
  calibrateRef.current = onCalibrate;
  const requestMenuRef = useRef(onRequestMenu);
  requestMenuRef.current = onRequestMenu;
  const menuOpenRef = useRef(menuOpen);
  menuOpenRef.current = menuOpen;
  // System-wide clickables from the background scanner, refreshed a few times a
  // second and hit-tested locally every frame (instant magnetism + boxes).
  const nativeListRef = useRef<NativeTarget[]>([]);
  const nativeHitRef = useRef<NativeTarget | null>(null); // current native hit (for box + drift-learn)
  const lastPtRef = useRef<{ x: number; y: number; t: number } | null>(null); // for gaze speed
  const scrollDwellRef = useRef(0); // when gaze entered a scroll band
  const lastScrollRef = useRef(0);
  const progressRef = useRef(0); // live dwell progress, to lock the target mid-commit
  // Magnet-fatigue state: rejection counts + the currently-suppressed targets, and
  // the snap target from the previous frame (to detect an abandoned dwell).
  const rejectRef = useRef<Map<string, { count: number; t: number }>>(new Map());
  const suppressRef = useRef<Set<string>>(new Set());
  const lastSnapRef = useRef<string | null>(null); // snap-target key from the last frame

  useEffect(() => {
    const onGaze = (e: Event) => { posRef.current = (e as CustomEvent<P>).detail; lastGazeRef.current = performance.now(); };
    window.addEventListener("gaze:point", onGaze as EventListener);
    return () => window.removeEventListener("gaze:point", onGaze as EventListener);
  }, []);

  // Poll the scanner cache into a local list (the scan itself runs on a Rust
  // thread; this fetch is cheap and off the render path). The RAF loop then
  // hit-tests this list synchronously every frame.
  useEffect(() => {
    if (!active) { nativeListRef.current = []; return; }
    let alive = true;
    const pull = async () => {
      if (!alive) return;
      nativeListRef.current = (await nativeTargets()).map(([x, y, w, h]) => ({ x, y, w, h }));
    };
    void pull();
    const id = window.setInterval(pull, 110);
    return () => { alive = false; window.clearInterval(id); nativeListRef.current = []; };
  }, [active]);

  useEffect(() => {
    if (!active) { setDisp(null); setProgress(0); setRect(null); return; }
    let raf = 0;
    const fire = (now: number, sx: number, sy: number) => {
      lastClickRef.current = now; dwellStartRef.current = now; setProgress(0);
      setFlash(true); setRipple({ x: sx, y: sy, id: now });
      window.setTimeout(() => setFlash(false), 200);
      // The click is done → lift magnet-fatigue suppression (per the spec: suppress
      // only until the following click lands) and reset rejection tracking.
      suppressRef.current.clear(); rejectRef.current.clear(); lastSnapRef.current = null;
    };
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const p = posRef.current;
      if (!p || now - lastGazeRef.current > STALE_MS) {
        setDisp(null); setProgress(0); progressRef.current = 0; setRect(null);
        dispSmoothRef.current = null; return;
      }
      const px = p.x * window.innerWidth, py = p.y * window.innerHeight;

      // Gaze velocity (normalized units/sec) — computed up front so it feeds BOTH
      // intent-biased target selection and the settle/release decision. While the
      // eyes move between targets, snapping releases so the cursor isn't "stuck"
      // being pulled back to a control when you try to leave.
      let vx = 0, vy = 0, speed = 0;
      if (lastPtRef.current) {
        const dt = Math.max(1e-3, (now - lastPtRef.current.t) / 1000);
        vx = (p.x - lastPtRef.current.x) / dt;
        vy = (p.y - lastPtRef.current.y) / dt;
        speed = Math.hypot(vx, vy);
      }
      lastPtRef.current = { x: p.x, y: p.y, t: now };
      const settling = speed < SNAP_VELOCITY;

      // Confidence-scaled snap radius: when tracking is shaky, widen the catch so
      // the UI structure compensates for the noisier signal.
      const conf = clamp01(confRef.current ?? 0);
      const radiusN = SNAP_FRAC * (1 + CONF_RADIUS_GAIN * (1 - conf)); // normalized snap radius
      const radiusPx = radiusN * Math.min(window.innerWidth, window.innerHeight);
      let target = nearestClickable(px, py, radiusPx, vx, vy, suppressRef.current);

      // Sticky commit: once a dwell has begun, keep the SAME target even if gaze
      // jitter makes a neighbor momentarily nearest — only release when the gaze
      // clearly leaves the committed target's bounds. Stops the "dwell keeps
      // resetting between two adjacent buttons" problem.
      const sticky = targetRef.current;
      if (sticky && sticky !== target && progressRef.current > 0.12 && document.contains(sticky)) {
        const r = sticky.getBoundingClientRect();
        if (r.width > 0) {
          const dx = Math.max(r.left - px, 0, px - r.right);
          const dy = Math.max(r.top - py, 0, py - r.bottom);
          if (Math.hypot(dx, dy) < radiusPx * STICKY_MARGIN) target = sticky;
        }
      }

      // System-wide magnetic snap: when no control of OUR app is near, hit-test
      // the scanner's cached clickables LOCALLY (instant — no async wait), so
      // targets and their boxes appear the moment you look, just like the HUD.
      // Locked once a dwell has committed so gaze noise can't switch the target.
      let nativeSnap: P | null = null;
      if (armed && !target) {
        // Sticky commit for system-wide targets too: keep the current hit while a
        // dwell is underway and the gaze is still within its bounds + margin.
        const cur = nativeHitRef.current;
        let keep = false;
        if (cur && progressRef.current > 0.12) {
          const dx = Math.max(Math.abs(p.x - cur.x) - cur.w / 2, 0);
          const dy = Math.max(Math.abs(p.y - cur.y) - cur.h / 2, 0);
          if (Math.hypot(dx, dy) < radiusN * STICKY_MARGIN) keep = true;
        }
        const hit = keep ? cur : nearestNativeTarget(p.x, p.y, radiusN, vx, vy, nativeListRef.current, suppressRef.current);
        nativeHitRef.current = hit;
        if (hit) nativeSnap = { x: hit.x, y: hit.y };
      } else {
        nativeHitRef.current = null;
      }

      // Magnet-fatigue bookkeeping. `progressRef.current` still holds LAST frame's
      // dwell on LAST frame's snap target (branches below mutate it). If the snap
      // target changed while a dwell was underway, the previous one was abandoned
      // → count a rejection; two rejections suppress it until the next click.
      let curKey: string | null = null;
      if (target) {
        const rr = target.getBoundingClientRect();
        curKey = keyOf((rr.left + rr.width / 2) / window.innerWidth, (rr.top + rr.height / 2) / window.innerHeight);
      } else if (nativeSnap && nativeHitRef.current) {
        curKey = keyOf(nativeHitRef.current.x, nativeHitRef.current.y);
      }
      if (lastSnapRef.current && lastSnapRef.current !== curKey && progressRef.current >= REJECT_MIN_PROG) {
        const k = lastSnapRef.current;
        const rj = rejectRef.current.get(k);
        if (rj && now - rj.t < REJECT_WINDOW) {
          rj.count++; rj.t = now;
          if (rj.count >= REJECT_COUNT) suppressRef.current.add(k);
        } else {
          rejectRef.current.set(k, { count: 1, t: now });
        }
      }
      lastSnapRef.current = curKey;

      // Reticle + OS cursor position: a magnetic GRAVITY WELL toward a nearby
      // control's center — continuous (pulls harder the closer you are), released
      // the instant the gaze moves, and pulled fully to center once a dwell starts
      // to commit (so the click is rock-steady). Clicks on OUR controls fire via
      // target.click() regardless of the reticle; native clicks aim at the center.
      let dispN = p;
      if (settling && target) {
        const r = target.getBoundingClientRect();
        const center = { x: (r.left + r.width / 2) / window.innerWidth, y: (r.top + r.height / 2) / window.innerHeight };
        dispN = gravityWell(p, center, radiusN, conf, progressRef.current > COMMIT_LOCK);
      } else if (settling && nativeSnap) {
        dispN = gravityWell(p, nativeSnap, radiusN, conf, progressRef.current > COMMIT_LOCK);
      }
      // Adaptive render smoothing: ease the visible cursor toward dispN — smooth
      // on small moves, snappy on saccades. This is the smoothing "delay".
      const prevS = dispSmoothRef.current ?? dispN;
      const gap = Math.hypot(dispN.x - prevS.x, dispN.y - prevS.y);
      const a = Math.min(1, SMOOTH_MIN + SMOOTH_GAIN * gap);
      const sm = { x: prevS.x + a * (dispN.x - prevS.x), y: prevS.y + a * (dispN.y - prevS.y) };
      dispSmoothRef.current = sm;
      setDisp(sm);

      // Drive the real OS cursor only while armed (else the mouse owns it).
      if (armed && now - lastWarpRef.current > WARP_MS) { warpCursor(sm.x, sm.y); lastWarpRef.current = now; }

      // Clear re-arm guards once the gaze has moved on.
      if (armedElRef.current && target !== armedElRef.current) armedElRef.current = null;
      if (armedPosRef.current && (target || Math.hypot(p.x - armedPosRef.current.x, p.y - armedPosRef.current.y) > FREE_LEAVE)) armedPosRef.current = null;

      // Disarmed (paused, or mouse-in-control): don't drive the OS cursor or
      // click into other apps — but STILL allow dwell on OUR OWN controls, so
      // the control bar (incl. Resume) is always gaze-operable and pausing can
      // never deadlock the app.
      if (!armed && !target) { setRect(null); setProgress(0); targetRef.current = null; freeAnchorRef.current = null; return; }

      // Edge-gaze scrolling / hands-free reading: hold gaze in the top/bottom
      // band (over empty space) to scroll the page. A short delay before it
      // starts prevents accidental scroll from a glance.
      const inTop = p.y > SCROLL_TOP[0] && p.y < SCROLL_TOP[1];
      const inBottom = p.y > SCROLL_BOTTOM[0] && p.y < SCROLL_BOTTOM[1];
      if (armed && !target && !nativeSnap && (inTop || inBottom)) {
        if (!scrollDwellRef.current) scrollDwellRef.current = now;
        setRect(null); setProgress(0); progressRef.current = 0; targetRef.current = null; freeAnchorRef.current = null;
        if (now - scrollDwellRef.current > SCROLL_DELAY && now - lastScrollRef.current > SCROLL_TICK_MS) {
          lastScrollRef.current = now;
          nativeScroll(inBottom ? -SCROLL_STEP : SCROLL_STEP);
        }
        return;
      }
      scrollDwellRef.current = 0;

      const canClick = now - lastClickRef.current > COOLDOWN_MS;

      if (target) {
        freeAnchorRef.current = null;
        const r = target.getBoundingClientRect();
        setRect(r);
        if (target !== targetRef.current) { targetRef.current = target; dwellStartRef.current = now; }
        if (target === armedElRef.current) { setProgress(0); progressRef.current = 0; return; }
        // Per-element dwell override (e.g. keyboard keys) + optional SETTLE gate:
        // the fill only begins after the gaze has rested on the element for
        // `data-dwell-settle` ms, so keys you merely pass over never fire. The
        // armedEl guard above already blocks re-firing the SAME element.
        const dwellMs = Number(target.dataset.dwellMs) || DWELL_MS;
        const settleMs = Number(target.dataset.dwellSettle) || 0;
        const prog = Math.min(1, Math.max(0, now - dwellStartRef.current - settleMs) / dwellMs);
        setProgress(prog); progressRef.current = prog;
        if (prog >= 1 && canClick) {
          target.click(); armedElRef.current = target; armedPosRef.current = null;
          if (armed) calibrateRef.current?.(p, dispN); // dispN = DOM target center
          fire(now, r.left + r.width / 2, r.top + r.height / 2);
        }
      } else {
        targetRef.current = null;
        // Highlight box for a system-wide clickable (other app), identical to the
        // box drawn on our own HUD controls — so "on something clickable → box,
        // on empty space → just the reticle" holds EVERYWHERE. Skip absurdly large
        // hits (containers, not buttons); the reticle carries those.
        const nt = nativeHitRef.current;
        // Draw the box for wide targets too (search bars); filter mainly on height.
        if (nativeSnap && nt && nt.h < 0.4 && nt.w < 0.98) {
          const rw = nt.w * window.innerWidth, rh = nt.h * window.innerHeight;
          setRect(new DOMRect(nt.x * window.innerWidth - rw / 2, nt.y * window.innerHeight - rh / 2, rw, rh));
        } else {
          setRect(null);
        }
        const aim = nativeSnap ?? p; // where the click actually lands
        const a = freeAnchorRef.current;
        if (!a || Math.hypot(p.x - a.x, p.y - a.y) > FREE_TOL) { freeAnchorRef.current = { ...p }; dwellStartRef.current = now; }
        else freeAnchorRef.current = { x: a.x + ANCHOR_EMA * (p.x - a.x), y: a.y + ANCHOR_EMA * (p.y - a.y) };
        if (armedPosRef.current) { setProgress(0); progressRef.current = 0; return; }
        // A registered clickable (native snap) opens on the normal dwell; truly
        // empty space needs a longer, deliberate hold — cuts accidental pop-ups.
        const dwellNeeded = nativeSnap ? DWELL_MS : FREE_DWELL_MS;
        const prog = Math.min(1, (now - dwellStartRef.current) / dwellNeeded);
        setProgress(prog); progressRef.current = prog;
        if (prog >= 1 && canClick && !menuOpenRef.current) {
          // Open the radial action menu at the aim point; the chosen petal
          // dispatches the actual click type. (Direct left-click still available
          // via the "Click" petal — kept as one glance.)
          requestMenuRef.current?.(aim.x, aim.y);
          // Automatic drift-learning: only from a SMALL detected target, where
          // the gaze was genuinely on it, so (center − gaze) is a clean sample.
          const nr = nativeHitRef.current;
          if (nativeSnap && nr && nr.w < SMALL_TARGET && nr.h < SMALL_TARGET) {
            calibrateRef.current?.(p, nativeSnap);
          }
          armedPosRef.current = { ...p }; armedElRef.current = null;
          fire(now, aim.x * window.innerWidth, aim.y * window.innerHeight);
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, armed]);

  if (!active || !disp) return null;
  const px = disp.x * window.innerWidth, py = disp.y * window.innerHeight;
  const R = 20, C = 2 * Math.PI * R;
  const ring = !armed ? "rgba(160,170,190,0.7)" : flash ? "#34d399" : confidenceLook(confidence ?? 0).color;
  // Confidence-aware reticle: dim + shrink slightly when tracking is uncertain,
  // so a bright, full-size reticle signals "trust me" and a faint one says "hold
  // still". Kept visible (not invisible) so you never lose the cursor.
  const conf = Math.max(0, Math.min(1, confidence ?? 0));
  const reticleOpacity = !armed ? 0.8 : 0.4 + 0.6 * conf;
  const reticleScale = (flash ? 1.25 : 0.9 + 0.1 * conf);

  return (
    <>
      {ripple && (
        <div key={ripple.id} style={{ position: "fixed", left: ripple.x, top: ripple.y,
          width: 60, height: 60, borderRadius: 999, border: "3px solid #34d399",
          zIndex: 96, pointerEvents: "none", animation: "gaze-ripple 420ms ease-out forwards" }} />
      )}
      {rect && (
        <div style={{ position: "fixed", left: rect.left - 6, top: rect.top - 6,
          width: rect.width + 12, height: rect.height + 12, borderRadius: 14,
          border: `2px solid ${flash ? "#34d399" : "var(--accent)"}`,
          boxShadow: `0 0 16px ${flash ? "#34d399" : "var(--accent)"}66`,
          background: `${flash ? "#34d399" : "var(--accent)"}14`,
          zIndex: 95, pointerEvents: "none", transition: "all 90ms linear" }} />
      )}
      <div style={{ position: "absolute", left: px, top: py, transform: "translate(-50%,-50%)",
        zIndex: 97, pointerEvents: "none", opacity: reticleOpacity, transition: "opacity 200ms" }}>
        <svg width={52} height={52} viewBox="0 0 52 52" style={{ display: "block",
          transform: `scale(${reticleScale})`, transition: "transform 120ms" }}>
          <circle cx="26" cy="26" r={R} fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="3" />
          <circle cx="26" cy="26" r={R} fill="none" stroke={ring} strokeWidth="3.5" strokeLinecap="round"
            strokeDasharray={C} strokeDashoffset={C * (1 - progress)} transform="rotate(-90 26 26)"
            style={{ transition: "stroke-dashoffset 60ms linear, stroke 200ms" }} />
          <circle cx="26" cy="26" r="4.5" fill={ring} style={{ transition: "fill 200ms" }} />
        </svg>
      </div>
    </>
  );
}
