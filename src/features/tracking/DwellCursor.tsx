import { useEffect, useRef, useState } from "react";
import { confidenceLook } from "@/features/shared/confidenceColor";
import { warpCursor, snapTarget, nativeScroll, nativeDragTo, type GazeMapping } from "@/core/system/nativeInput";
import { sendRingState, sendRingFlash } from "@/core/system/ringBus";
import type { ActivationMode } from "@/store/settings";

// Offset that converts a performance.now() timestamp to a Date.now() epoch —
// stable for the session, so the ring window (a different JS context with a
// different performance origin) can animate dwell fill deterministically.
const EPOCH_OFFSET = Date.now() - performance.now();

const DWELL_MS = 800;       // hold gaze on a registered clickable this long to act
const FREE_DWELL_MS = 1500; // longer, deliberate dwell where NO clickable is detected
                            // (empty space) — cuts accidental activations
const COOLDOWN_MS = 600;    // min gap between clicks
// Fixation stability (spec §C): "settled" is judged by the SPREAD of gaze over a
// short window — not instantaneous speed — because jitter has high frame-to-
// frame speed but low net movement. This lets magnetic snapping engage THROUGH
// jitter and release on a genuine saccade (which blows the spread up).
const FIX_WINDOW_MS = 180;  // rolling fixation window
const FIX_MIN_SAMPLES = 4;  // need this many samples before judging
const FIX_SPREAD = 0.030;   // mean spread (normalized) below which gaze is settled
// Sticky target lock: once a dwell is underway, keep the engaged target until
// the gaze centroid clearly leaves it — clutter can't flip the target or reset
// the ring from gaze noise.
const STICKY_MARGIN = 0.04; // leave radius beyond the target's own bounds (normalized)
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

/** Nearest clickable in THIS app within `limit` CSS px of window-local (px,py). */
function nearestClickable(px: number, py: number, limit: number): HTMLElement | null {
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
export function DwellCursor({ active, armed, confidence, onNativeClick, onCalibrate, menuOpen = false, onRequestMenu,
  dwellMs = DWELL_MS, freeDwellMs = FREE_DWELL_MS, cooldownMs = COOLDOWN_MS,
  emptyDwellAction = "menu", edgeScroll = true, scrollSpeed = 1, snapStrength = 1, stabilityTolerance = 1,
  activationMode = "dwell", dragPhase = null, onDragCommit, precision = false, mapping = null, onClickSound }: {
  active: boolean; armed: boolean; confidence: number | null;
  onNativeClick?: (nx: number, ny: number) => void;
  /** Called on a confirmed click onto a known target center (gaze, target) —
   *  feeds the self-healing drift corrector. Both points are normalized. */
  onCalibrate?: (gaze: P, target: P) => void;
  /** Whether the radial action menu is currently open (suppresses re-opening). */
  menuOpen?: boolean;
  /** A free-space dwell requests the radial action menu at this normalized point. */
  onRequestMenu?: (nx: number, ny: number) => void;
  /** Dwell/cooldown timing (ms). Default to the module constants. */
  dwellMs?: number;
  freeDwellMs?: number;
  cooldownMs?: number;
  /** What a dwell over empty space does: "click" left-clicks there, "menu" opens
   *  the radial action wheel. Defaults to "menu" (v1.1 behavior). */
  emptyDwellAction?: "click" | "menu";
  /** Edge-gaze scrolling on/off and its speed multiplier. */
  edgeScroll?: boolean;
  scrollSpeed?: number;
  /** Magnetic snap strength (0 = off) — scales the system-wide snap radius. */
  snapStrength?: number;
  /** Free-space dwell jitter tolerance multiplier (raise for tremor/fatigue). */
  stabilityTolerance?: number;
  /** How a click fires: dwell (hold), or blink/switch (external `gaze:trigger`). */
  activationMode?: ActivationMode;
  /** Gaze-drag gesture phase: null = idle, "arming" = next commit presses down,
   *  "dragging" = cursor emits drag events and next commit releases. */
  dragPhase?: null | "arming" | "dragging";
  /** Called on a commit while a drag is armed/active, at the aim point. */
  onDragCommit?: (aim: P) => void;
  /** Precision (fine-targeting) mode: steadier cursor + longer dwell for small
   *  targets. Off by default (crisp v1.1 behavior). */
  precision?: boolean;
  /** Gaze-space → window mapping, so gaze coordinates stay screen-absolute after
   *  the window morphs into the HUD capsule. Null = window IS the gaze space. */
  mapping?: GazeMapping | null;
  /** Play the click-confirmation sound (already gated by settings by the app). */
  onClickSound?: () => void;
}) {
  const [progress, setProgress] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const posRef = useRef<P | null>(null);
  const lastGazeRef = useRef(0);
  const lastWarpRef = useRef(0);
  const lastWarpPtRef = useRef<P | null>(null); // last point actually warped to
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
  // Live copy of the tuning props so the long-lived RAF loop reads the latest
  // without re-subscribing (which would reset dwell timers on every change).
  const cfgRef = useRef({ dwellMs, freeDwellMs, cooldownMs, emptyDwellAction, edgeScroll, scrollSpeed, snapStrength, stabilityTolerance, activationMode, dragPhase, precision });
  cfgRef.current = { dwellMs, freeDwellMs, cooldownMs, emptyDwellAction, edgeScroll, scrollSpeed, snapStrength, stabilityTolerance, activationMode, dragPhase, precision };
  const soundRef = useRef(onClickSound);
  soundRef.current = onClickSound;
  const dragCommitRef = useRef(onDragCommit);
  dragCommitRef.current = onDragCommit;
  const mappingRef = useRef(mapping);
  mappingRef.current = mapping;
  const confRef = useRef(confidence);
  confRef.current = confidence;
  const triggerRef = useRef(false); // external activation (blink / switch) pending
  const renderRef = useRef<P | null>(null); // eased reticle/cursor position (precision mode)
  const nativeRef = useRef<{ x: number; y: number; w: number; h: number; t: number } | null>(null); // cached system-wide snap
  const nativeQueryRef = useRef(0);
  const fixRef = useRef<{ x: number; y: number; t: number }[]>([]); // rolling fixation window
  const scrollDwellRef = useRef(0); // when gaze entered a scroll band
  const lastScrollRef = useRef(0);
  const progressRef = useRef(0); // live dwell progress, to lock the target mid-commit

  useEffect(() => {
    const onGaze = (e: Event) => { posRef.current = (e as CustomEvent<P>).detail; lastGazeRef.current = performance.now(); };
    const onTrigger = () => { triggerRef.current = true; };
    window.addEventListener("gaze:point", onGaze as EventListener);
    window.addEventListener("gaze:trigger", onTrigger);
    return () => {
      window.removeEventListener("gaze:point", onGaze as EventListener);
      window.removeEventListener("gaze:trigger", onTrigger);
    };
  }, []);

  useEffect(() => {
    if (!active) {
      setProgress(0); setRect(null);
      sendRingState({ mode: "hidden", color: "#3c82f6" });
      return;
    }
    let raf = 0;
    const fire = (now: number) => {
      lastClickRef.current = now; dwellStartRef.current = now; setProgress(0);
      sendRingFlash();
      soundRef.current?.();
    };
    /** Ring color for the current modifiers: drag > precision > confidence. */
    const ringColor = () => {
      const cfg = cfgRef.current;
      if (cfg.dragPhase) return "#a855f7";
      if (cfg.precision) return "#22d3ee";
      return confidenceLook(confRef.current ?? 0).color;
    };
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const cfg = cfgRef.current;
      const m = mappingRef.current;
      // Gaze-space normalized ⇄ window-local CSS px. Without a mapping the
      // window IS the gaze space (calibration / browser dev) — identity.
      const toLocalX = (nx: number) => (m ? (m.gsx + nx * m.gsw - m.wx) / m.scale : nx * window.innerWidth);
      const toLocalY = (ny: number) => (m ? (m.gsy + ny * m.gsh - m.wy) / m.scale : ny * window.innerHeight);
      const toNormX = (lx: number) => (m ? (lx * m.scale + m.wx - m.gsx) / m.gsw : lx / window.innerWidth);
      const toNormY = (ly: number) => (m ? (ly * m.scale + m.wy - m.gsy) / m.gsh : ly / window.innerHeight);
      const domLimit = SNAP_FRAC * (m ? Math.min(m.gsw, m.gsh) / m.scale : Math.min(window.innerWidth, window.innerHeight));
      const p = posRef.current;
      if (!p || now - lastGazeRef.current > STALE_MS) {
        setProgress(0); progressRef.current = 0; setRect(null); renderRef.current = null;
        fixRef.current.length = 0;
        sendRingState({ mode: "hidden", color: ringColor() });
        return;
      }
      const px = toLocalX(p.x), py = toLocalY(p.y);

      // Fixation stability: centroid + mean spread of gaze over a short window.
      // "Settled" = holding a point (even a jittery hold); a real saccade blows
      // the spread up and releases instantly.
      const fw = fixRef.current;
      fw.push({ x: p.x, y: p.y, t: now });
      while (fw.length && now - fw[0]!.t > FIX_WINDOW_MS) fw.shift();
      let cx = p.x, cy = p.y, spread = 1;
      if (fw.length >= FIX_MIN_SAMPLES) {
        cx = fw.reduce((s, q) => s + q.x, 0) / fw.length;
        cy = fw.reduce((s, q) => s + q.y, 0) / fw.length;
        spread = fw.reduce((s, q) => s + Math.hypot(q.x - cx, q.y - cy), 0) / fw.length;
      }
      const settled = spread < FIX_SPREAD * Math.max(0.5, cfg.stabilityTolerance);

      // While dragging we treat everything as free movement so our own controls
      // and app snaps don't hijack the drag.
      const dragging = cfg.dragPhase !== null;
      let target = dragging ? null : nearestClickable(px, py, domLimit);

      // Sticky target lock: while a dwell is underway on one of our own controls,
      // keep it engaged until the gaze CENTROID clearly leaves its bounds —
      // neighboring controls can't steal it and jitter can't reset the ring.
      const held = targetRef.current;
      if (!dragging && held && held !== target && held.isConnected && progressRef.current > 0) {
        const hr = held.getBoundingClientRect();
        const hx = toNormX(hr.left + hr.width / 2), hy = toNormY(hr.top + hr.height / 2);
        const halfDiag = Math.hypot(toNormX(hr.right) - toNormX(hr.left), toNormY(hr.bottom) - toNormY(hr.top)) / 2;
        if (Math.hypot(cx - hx, cy - hy) < halfDiag + STICKY_MARGIN) target = held;
      }
      // System-wide snap radius scales with snapStrength (0 disables native snap,
      // but our own controls always snap via nearestClickable above).
      const nativeRadius = SNAP_FRAC * Math.max(0, cfg.snapStrength);

      // System-wide magnetic snap: when no control of OUR app is near, throttled
      // async lookup of the nearest clickable in ANY app (macOS Accessibility),
      // cached across frames so the 60fps loop never blocks.
      // Target lock: once a dwell has meaningfully committed, stop re-querying so
      // the snap target can't switch under you from gaze noise ("which thing am I
      // even clicking"). Resumes once the dwell resets (you look away).
      if (armed && cfg.snapStrength > 0 && !dragging && !target && progressRef.current < 0.25 && now - nativeQueryRef.current > NATIVE_QUERY_MS) {
        nativeQueryRef.current = now;
        snapTarget(p.x, p.y, nativeRadius)
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
      if (!target && cfg.snapStrength > 0 && !dragging) {
        const nt = nativeRef.current;
        // Dwell-stickiness: while a dwell on this snap target is underway, the
        // cached target stays engaged even past its normal freshness — releasing
        // mid-commit is what made small targets nearly unclickable.
        const fresh = nt && (now - nt.t < NATIVE_FRESH_MS || progressRef.current > 0.2);
        if (nt && fresh && Math.hypot(nt.x - cx, nt.y - cy) < nativeRadius * 3)
          nativeSnap = { x: nt.x, y: nt.y };
      }

      // OS cursor position (spec §C fixation lock): once the gaze has settled,
      // snap onto the engaged control's center — or, with nothing to snap to,
      // PARK the cursor at the fixation centroid so it sits dead-still through
      // jitter. While the eyes are genuinely moving, follow the live gaze so
      // snapping releases the instant you look away.
      let dispN = p;
      if (settled && target) {
        const r = target.getBoundingClientRect();
        dispN = { x: toNormX(r.left + r.width / 2), y: toNormY(r.top + r.height / 2) };
      } else if (settled && nativeSnap) {
        dispN = nativeSnap;
      } else if (settled) {
        dispN = { x: cx, y: cy };
      }
      // Precision mode: ease the OS cursor toward the target for a steadier
      // pointer on small elements. Default (non-precision) stays crisp/direct.
      // Click/targeting always use the true gaze/target.
      let out = dispN;
      if (cfg.precision) {
        const prev = renderRef.current ?? dispN;
        out = { x: prev.x + 0.3 * (dispN.x - prev.x), y: prev.y + 0.3 * (dispN.y - prev.y) };
        renderRef.current = out;
      } else renderRef.current = null;

      // Drive the real OS cursor only while armed (else the mouse owns it). While
      // dragging, emit drag events so the underlying app updates its selection.
      // Dedupe: a parked (fixation-locked or snapped) cursor doesn't re-warp to
      // the same spot — the hot path goes fully quiet while you hold a point.
      if (armed && now - lastWarpRef.current > WARP_MS) {
        const lw = lastWarpPtRef.current;
        if (!lw || Math.hypot(out.x - lw.x, out.y - lw.y) > 0.0012) {
          if (cfg.dragPhase === "dragging") nativeDragTo(out.x, out.y);
          else warpCursor(out.x, out.y);
          lastWarpPtRef.current = { x: out.x, y: out.y };
          lastWarpRef.current = now;
        }
      }

      // Clear re-arm guards once the gaze has moved on.
      if (armedElRef.current && target !== armedElRef.current) armedElRef.current = null;
      if (armedPosRef.current && (target || Math.hypot(p.x - armedPosRef.current.x, p.y - armedPosRef.current.y) > FREE_LEAVE)) armedPosRef.current = null;

      // Disarmed (paused, or mouse-in-control): don't drive the OS cursor or
      // click into other apps — but STILL allow dwell on OUR OWN controls, so
      // the control bar (incl. Resume) is always gaze-operable and pausing can
      // never deadlock the app.
      if (!armed && !target) {
        setRect(null); setProgress(0); targetRef.current = null; freeAnchorRef.current = null;
        sendRingState({ mode: "hidden", color: ringColor() });
        return;
      }

      // Edge-gaze scrolling / hands-free reading: hold gaze in the top/bottom
      // band (over empty space) to scroll the page. A short delay before it
      // starts prevents accidental scroll from a glance.
      const inTop = p.y > SCROLL_TOP[0] && p.y < SCROLL_TOP[1];
      const inBottom = p.y > SCROLL_BOTTOM[0] && p.y < SCROLL_BOTTOM[1];
      if (armed && cfg.edgeScroll && !target && !nativeSnap && (inTop || inBottom)) {
        if (!scrollDwellRef.current) scrollDwellRef.current = now;
        setRect(null); setProgress(0); progressRef.current = 0; targetRef.current = null; freeAnchorRef.current = null;
        if (now - scrollDwellRef.current > SCROLL_DELAY && now - lastScrollRef.current > SCROLL_TICK_MS) {
          lastScrollRef.current = now;
          const step = SCROLL_STEP * Math.max(0.25, cfg.scrollSpeed);
          nativeScroll(inBottom ? -step : step);
        }
        sendRingState({ mode: "active", color: ringColor() });
        return;
      }
      scrollDwellRef.current = 0;

      const canClick = now - lastClickRef.current > cfg.cooldownMs;
      const precMul = cfg.precision ? 1.5 : 1; // longer dwell / steadier hold when precise
      // In blink/switch modes a click fires on an external `gaze:trigger` instead
      // of a completed dwell. Clear stale triggers in dwell mode so a later mode
      // switch can't fire an old one.
      const externalMode = cfg.activationMode !== "dwell";
      if (!externalMode) triggerRef.current = false;
      const triggered = externalMode && triggerRef.current;
      if (triggered) triggerRef.current = false;

      // Emit ring state for the follower window: dwell (fill animating from a
      // shared-epoch start) when a hold is in progress, else active. The bus
      // dedupes, so only real changes cross the window boundary. A hold must be
      // ~120ms old before it counts — otherwise gaze scanning (which resets the
      // free anchor almost every frame) would emit a new start per frame.
      const emitRing = (dwellDurationMs: number | null) => {
        if (dwellDurationMs != null && now - dwellStartRef.current < 120) dwellDurationMs = null;
        if (dwellDurationMs != null) {
          sendRingState({
            mode: "dwell",
            start: dwellStartRef.current + EPOCH_OFFSET,
            durationMs: dwellDurationMs,
            color: ringColor(),
          });
        } else {
          sendRingState({ mode: "active", color: ringColor() });
        }
      };

      if (target) {
        freeAnchorRef.current = null;
        const r = target.getBoundingClientRect();
        setRect(r);
        if (target !== targetRef.current) { targetRef.current = target; dwellStartRef.current = now; }
        if (target === armedElRef.current) { setProgress(0); progressRef.current = 0; emitRing(null); return; }
        const dwellNeeded = cfg.dwellMs * precMul;
        const prog = Math.min(1, (now - dwellStartRef.current) / dwellNeeded);
        setProgress(prog); progressRef.current = prog;
        emitRing(externalMode ? null : dwellNeeded);
        if ((externalMode ? triggered : prog >= 1) && canClick) {
          target.click(); armedElRef.current = target; armedPosRef.current = null;
          if (armed) calibrateRef.current?.({ x: cx, y: cy }, dispN); // dispN = DOM target center
          fire(now);
        }
      } else {
        targetRef.current = null; setRect(null);
        // Click lands at the snap target, else the FIXATION CENTROID (not the
        // instantaneous sample) — the click goes where you're holding, not where
        // the last jittery frame happened to land.
        const aim = nativeSnap ?? (settled ? { x: cx, y: cy } : p);
        const a = freeAnchorRef.current;
        const freeTol = FREE_TOL * Math.max(0.4, cfg.stabilityTolerance) * precMul;
        // Anchor the free-space dwell to the centroid so jitter can't reset it.
        if (!a || Math.hypot(cx - a.x, cy - a.y) > freeTol) { freeAnchorRef.current = { x: cx, y: cy }; dwellStartRef.current = now; }
        else freeAnchorRef.current = { x: a.x + ANCHOR_EMA * (cx - a.x), y: a.y + ANCHOR_EMA * (cy - a.y) };
        if (armedPosRef.current) { setProgress(0); progressRef.current = 0; emitRing(null); return; }
        // A registered clickable (native snap) opens on the normal dwell; truly
        // empty space needs a longer, deliberate hold — cuts accidental pop-ups.
        const dwellNeeded = (nativeSnap ? cfg.dwellMs : cfg.freeDwellMs) * precMul;
        const prog = Math.min(1, (now - dwellStartRef.current) / dwellNeeded);
        setProgress(prog); progressRef.current = prog;
        emitRing(externalMode ? null : dwellNeeded);
        if ((externalMode ? triggered : prog >= 1) && canClick && !menuOpenRef.current) {
          // Empty-space commit: a drag step (down / release), a direct left-click,
          // or open the radial action wheel for right/double/drag.
          if (dragging) dragCommitRef.current?.(aim);
          else if (cfg.emptyDwellAction === "click") clickRef.current?.(aim.x, aim.y);
          else requestMenuRef.current?.(aim.x, aim.y);
          // Automatic drift-learning: only from a SMALL detected target, where
          // the gaze was genuinely on it, so (center − centroid) is a clean sample.
          const nr = nativeRef.current;
          if (!dragging && nativeSnap && nr && nr.w < SMALL_TARGET && nr.h < SMALL_TARGET) {
            calibrateRef.current?.({ x: cx, y: cy }, nativeSnap);
          }
          armedPosRef.current = { ...p }; armedElRef.current = null;
          fire(now);
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, armed]);

  // The pointer + dwell ring live in the follower cursor-ring window now (see
  // CursorRing). This component's only remaining visual is the highlight around
  // an in-app target being dwelled — window-local, so it's correct in both the
  // capsule and expanded shapes. The dwell fill on the highlight border tracks
  // `progress` subtly via opacity.
  if (!active || !rect) return null;
  const glow = 0.35 + 0.65 * progress;
  return (
    <div style={{ position: "fixed", left: rect.left - 6, top: rect.top - 6,
      width: rect.width + 12, height: rect.height + 12, borderRadius: 14,
      border: "2px solid var(--accent)",
      boxShadow: `0 0 16px var(--accent)`,
      background: "var(--accent-soft)",
      opacity: glow,
      zIndex: 49, pointerEvents: "none", transition: "all 90ms linear" }} />
  );
}
