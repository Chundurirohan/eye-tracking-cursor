import { useEffect, useRef, useState } from "react";
import { confidenceLook } from "@/features/shared/confidenceColor";
import { warpCursor, snapTarget, nativeScroll } from "@/core/system/nativeInput";

const DWELL_MS = 800;       // hold gaze on a registered clickable this long to act
const FREE_DWELL_MS = 1500; // longer, deliberate dwell where NO clickable is detected
                            // (empty space) — cuts accidental activations
const SNAP_VELOCITY = 1.2;  // normalized units/sec: above this the gaze is moving,
                            // so snapping releases (no "gravity" while switching targets)
const COOLDOWN_MS = 600;    // min gap between clicks
const STALE_MS = 400;       // hide reticle if no gaze sample this recently
const WARP_MS = 20;         // OS-cursor warp throttle
const NATIVE_QUERY_MS = 110; // throttle for the async system-wide target lookup
const NATIVE_FRESH_MS = 300; // how long a cached native-snap result stays usable
// Snap radius as a fraction of the smaller screen dimension: gaze only has to
// land within this of a control to lock (magnetically) onto it. Kept modest so
// the cursor doesn't yank to the bar from far away (which reads as "off").
const SNAP_FRAC = 0.06;
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
const SNAP_HYSTERESIS = 0.045; // keep the current native snap unless a new one is this far
const SMALL_TARGET = 0.11;     // only auto-learn drift from targets smaller than this
                               // (normalized), where the gaze was genuinely on it
const CLICKABLE = 'button, a, [role="button"], input, [data-dwell]';

type P = { x: number; y: number };

/** Nearest clickable in THIS app within the snap radius of (px,py). */
function nearestClickable(px: number, py: number): HTMLElement | null {
  const limit = SNAP_FRAC * Math.min(window.innerWidth, window.innerHeight);
  let best: HTMLElement | null = null, bestD = limit;
  document.querySelectorAll<HTMLElement>(CLICKABLE).forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const dx = Math.max(r.left - px, 0, px - r.right);
    const dy = Math.max(r.top - py, 0, py - r.bottom);
    const d = Math.hypot(dx, dy);
    if (d < bestD) { bestD = d; best = el; }
  });
  return best;
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
  const calibrateRef = useRef(onCalibrate);
  calibrateRef.current = onCalibrate;
  const requestMenuRef = useRef(onRequestMenu);
  requestMenuRef.current = onRequestMenu;
  const menuOpenRef = useRef(menuOpen);
  menuOpenRef.current = menuOpen;
  const nativeRef = useRef<{ x: number; y: number; w: number; h: number; t: number } | null>(null); // cached system-wide snap
  const nativeQueryRef = useRef(0);
  const lastPtRef = useRef<{ x: number; y: number; t: number } | null>(null); // for gaze speed
  const scrollDwellRef = useRef(0); // when gaze entered a scroll band
  const lastScrollRef = useRef(0);
  const progressRef = useRef(0); // live dwell progress, to lock the target mid-commit

  useEffect(() => {
    const onGaze = (e: Event) => { posRef.current = (e as CustomEvent<P>).detail; lastGazeRef.current = performance.now(); };
    window.addEventListener("gaze:point", onGaze as EventListener);
    return () => window.removeEventListener("gaze:point", onGaze as EventListener);
  }, []);

  useEffect(() => {
    if (!active) { setDisp(null); setProgress(0); setRect(null); return; }
    let raf = 0;
    const fire = (now: number, sx: number, sy: number) => {
      lastClickRef.current = now; dwellStartRef.current = now; setProgress(0);
      setFlash(true); setRipple({ x: sx, y: sy, id: now });
      window.setTimeout(() => setFlash(false), 200);
    };
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const p = posRef.current;
      if (!p || now - lastGazeRef.current > STALE_MS) {
        setDisp(null); setProgress(0); progressRef.current = 0; setRect(null); return;
      }
      const px = p.x * window.innerWidth, py = p.y * window.innerHeight;
      const target = nearestClickable(px, py);

      // System-wide magnetic snap: when no control of OUR app is near, throttled
      // async lookup of the nearest clickable in ANY app (macOS Accessibility),
      // cached across frames so the 60fps loop never blocks.
      // Target lock: once a dwell has meaningfully committed, stop re-querying so
      // the snap target can't switch under you from gaze noise ("which thing am I
      // even clicking"). Resumes once the dwell resets (you look away).
      if (armed && !target && progressRef.current < 0.25 && now - nativeQueryRef.current > NATIVE_QUERY_MS) {
        nativeQueryRef.current = now;
        snapTarget(p.x, p.y, SNAP_FRAC)
          .then((r) => {
            if (!r) { nativeRef.current = null; return; }
            const prev = nativeRef.current;
            // Hysteresis: in dense clusters the query flickers between adjacent
            // targets. Keep the current snap unless the new one is clearly
            // elsewhere, so it stops jittering between neighbors.
            if (prev && performance.now() - prev.t < NATIVE_FRESH_MS &&
                Math.hypot(r[0] - prev.x, r[1] - prev.y) < SNAP_HYSTERESIS) {
              nativeRef.current = { x: prev.x, y: prev.y, w: prev.w, h: prev.h, t: performance.now() };
            } else {
              nativeRef.current = { x: r[0], y: r[1], w: r[2], h: r[3], t: performance.now() };
            }
          })
          .catch(() => { nativeRef.current = null; });
      }
      let nativeSnap: P | null = null;
      if (!target) {
        const nt = nativeRef.current;
        if (nt && now - nt.t < NATIVE_FRESH_MS && Math.hypot(nt.x - p.x, nt.y - p.y) < SNAP_FRAC * 3)
          nativeSnap = { x: nt.x, y: nt.y };
      }

      // Gaze speed (normalized units/sec). While the eyes are moving between
      // targets, snapping is released so the cursor doesn't get "stuck" being
      // pulled back to a control (e.g. the search bar) when you try to leave.
      let speed = 0;
      if (lastPtRef.current) {
        const dt = Math.max(1e-3, (now - lastPtRef.current.t) / 1000);
        speed = Math.hypot(p.x - lastPtRef.current.x, p.y - lastPtRef.current.y) / dt;
      }
      lastPtRef.current = { x: p.x, y: p.y, t: now };
      const settling = speed < SNAP_VELOCITY;

      // Reticle + OS cursor position: snap onto a nearby control's center — but
      // only once the gaze has SETTLED, so it releases the instant you look away.
      let dispN = p;
      if (settling && target) {
        const r = target.getBoundingClientRect();
        dispN = { x: (r.left + r.width / 2) / window.innerWidth, y: (r.top + r.height / 2) / window.innerHeight };
      } else if (settling && nativeSnap) {
        dispN = nativeSnap;
      }
      setDisp(dispN);

      // Drive the real OS cursor only while armed (else the mouse owns it).
      if (armed && now - lastWarpRef.current > WARP_MS) { warpCursor(dispN.x, dispN.y); lastWarpRef.current = now; }

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
        const prog = Math.min(1, (now - dwellStartRef.current) / DWELL_MS);
        setProgress(prog); progressRef.current = prog;
        if (prog >= 1 && canClick) {
          target.click(); armedElRef.current = target; armedPosRef.current = null;
          if (armed) calibrateRef.current?.(p, dispN); // dispN = DOM target center
          fire(now, r.left + r.width / 2, r.top + r.height / 2);
        }
      } else {
        targetRef.current = null; setRect(null);
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
          const nr = nativeRef.current;
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
          zIndex: 51, pointerEvents: "none", animation: "gaze-ripple 420ms ease-out forwards" }} />
      )}
      {rect && (
        <div style={{ position: "fixed", left: rect.left - 6, top: rect.top - 6,
          width: rect.width + 12, height: rect.height + 12, borderRadius: 14,
          border: `2px solid ${flash ? "#34d399" : "var(--accent)"}`,
          boxShadow: `0 0 16px ${flash ? "#34d399" : "var(--accent)"}66`,
          background: `${flash ? "#34d399" : "var(--accent)"}14`,
          zIndex: 49, pointerEvents: "none", transition: "all 90ms linear" }} />
      )}
      <div style={{ position: "absolute", left: px, top: py, transform: "translate(-50%,-50%)",
        zIndex: 50, pointerEvents: "none", opacity: reticleOpacity, transition: "opacity 200ms" }}>
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
