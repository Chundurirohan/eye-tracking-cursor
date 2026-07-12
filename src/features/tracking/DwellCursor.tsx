import { useEffect, useRef, useState } from "react";
import { confidenceLook } from "@/features/shared/confidenceColor";
import { warpCursor, snapTarget } from "@/core/system/nativeInput";

const DWELL_MS = 800;       // hold gaze on a target this long to click
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
  const nativeRef = useRef<{ x: number; y: number; t: number } | null>(null); // cached system-wide snap
  const nativeQueryRef = useRef(0);

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
        setDisp(null); setProgress(0); setRect(null); return;
      }
      const px = p.x * window.innerWidth, py = p.y * window.innerHeight;
      const target = nearestClickable(px, py);

      // System-wide magnetic snap: when no control of OUR app is near, throttled
      // async lookup of the nearest clickable in ANY app (macOS Accessibility),
      // cached across frames so the 60fps loop never blocks.
      if (armed && !target && now - nativeQueryRef.current > NATIVE_QUERY_MS) {
        nativeQueryRef.current = now;
        snapTarget(p.x, p.y, SNAP_FRAC)
          .then((r) => { nativeRef.current = r ? { x: r[0], y: r[1], t: performance.now() } : null; })
          .catch(() => { nativeRef.current = null; });
      }
      let nativeSnap: P | null = null;
      if (!target) {
        const nt = nativeRef.current;
        if (nt && now - nt.t < NATIVE_FRESH_MS && Math.hypot(nt.x - p.x, nt.y - p.y) < SNAP_FRAC * 3)
          nativeSnap = { x: nt.x, y: nt.y };
      }

      // Reticle + OS cursor position: snap onto a nearby control's center.
      let dispN = p;
      if (target) {
        const r = target.getBoundingClientRect();
        dispN = { x: (r.left + r.width / 2) / window.innerWidth, y: (r.top + r.height / 2) / window.innerHeight };
      } else if (nativeSnap) {
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
      const canClick = now - lastClickRef.current > COOLDOWN_MS;

      if (target) {
        freeAnchorRef.current = null;
        const r = target.getBoundingClientRect();
        setRect(r);
        if (target !== targetRef.current) { targetRef.current = target; dwellStartRef.current = now; }
        if (target === armedElRef.current) { setProgress(0); return; }
        const prog = Math.min(1, (now - dwellStartRef.current) / DWELL_MS);
        setProgress(prog);
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
        if (armedPosRef.current) { setProgress(0); return; }
        const prog = Math.min(1, (now - dwellStartRef.current) / DWELL_MS);
        setProgress(prog);
        if (prog >= 1 && canClick && !menuOpenRef.current) {
          // Open the radial action menu at the aim point; the chosen petal
          // dispatches the actual click type. (Direct left-click still available
          // via the "Click" petal — kept as one glance.)
          requestMenuRef.current?.(aim.x, aim.y);
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
        zIndex: 50, pointerEvents: "none" }}>
        <svg width={52} height={52} viewBox="0 0 52 52" style={{ display: "block",
          transform: flash ? "scale(1.25)" : "scale(1)", transition: "transform 120ms" }}>
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
