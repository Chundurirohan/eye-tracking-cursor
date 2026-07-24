import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { resolveDwell, useSettings } from "@/store/settings";
import type { GazeGlobal } from "@/core/system/overlayBus";

// Local gaze-dwell for an OVERLAY window (wheel, keyboard). Gaze-dwell is
// DOM-based and can't see other windows, so each overlay window runs its own:
// it receives global gaze px broadcast by the main window, converts to its own
// window-local px, finds the nearest `[data-dwell]` element, fills a dwell, and
// clicks it. Returns the current dwell target rect + progress so the window can
// draw the fill ring itself.

const STALE_MS = 400;
const SNAP_PX = 44;      // dwell-hit radius around an element's bounds
const COOLDOWN_MS = 500; // min gap between activations
const CLICKABLE = "[data-dwell]";

export interface DwellVisual { rect: DOMRect | null; progress: number }

function nearest(px: number, py: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestD = SNAP_PX;
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

export function useWindowDwell(): DwellVisual {
  const settings = useSettings();
  const [visual, setVisual] = useState<DwellVisual>({ rect: null, progress: 0 });

  const gazeRef = useRef<{ x: number; y: number; t: number } | null>(null);
  // This window's top-left in logical px (updated on move).
  const originRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const targetRef = useRef<HTMLElement | null>(null);
  const dwellStartRef = useRef(0);
  const lastFireRef = useRef(0);
  const dwellMsRef = useRef(resolveDwell(settings).dwellMs);
  dwellMsRef.current = resolveDwell(settings).dwellMs;

  // Track this window's own origin (its position changes when main re-shows it).
  useEffect(() => {
    const w = getCurrentWindow();
    let un: (() => void) | undefined;
    const refresh = async () => {
      try {
        const pos = await w.outerPosition();
        const scale = await w.scaleFactor();
        originRef.current = { x: pos.x / scale, y: pos.y / scale };
      } catch { /* ignore */ }
    };
    void refresh();
    void w.onMoved(() => void refresh()).then((f) => { un = f; });
    return () => un?.();
  }, []);

  // Receive global gaze from the main window.
  useEffect(() => {
    const un = listen<GazeGlobal>("gaze:global", (e) => {
      gazeRef.current = { x: e.payload.gx, y: e.payload.gy, t: performance.now() };
    });
    return () => { void un.then((f) => f()); };
  }, []);

  // Local dwell loop.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const g = gazeRef.current;
      if (!g || now - g.t > STALE_MS) {
        targetRef.current = null;
        setVisual((v) => (v.rect ? { rect: null, progress: 0 } : v));
        return;
      }
      // Global logical px → this window's local CSS px.
      const lx = g.x - originRef.current.x;
      const ly = g.y - originRef.current.y;
      const target = nearest(lx, ly);
      if (!target) {
        targetRef.current = null;
        setVisual((v) => (v.rect ? { rect: null, progress: 0 } : v));
        return;
      }
      if (target !== targetRef.current) { targetRef.current = target; dwellStartRef.current = now; }
      const prog = Math.min(1, (now - dwellStartRef.current) / dwellMsRef.current);
      setVisual({ rect: target.getBoundingClientRect(), progress: prog });
      if (prog >= 1 && now - lastFireRef.current > COOLDOWN_MS) {
        lastFireRef.current = now;
        dwellStartRef.current = now;
        target.click();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return visual;
}

/** The dwell-fill highlight drawn around the element currently being dwelled. */
export function DwellHighlight({ rect, progress }: DwellVisual) {
  if (!rect) return null;
  return (
    <div style={{ position: "fixed", left: rect.left - 4, top: rect.top - 4,
      width: rect.width + 8, height: rect.height + 8, borderRadius: 14,
      border: "2px solid var(--accent)", boxShadow: "0 0 14px var(--accent)",
      background: "var(--accent-soft)", opacity: 0.3 + 0.7 * progress,
      zIndex: 0, pointerEvents: "none", transition: "opacity 60ms linear" }} />
  );
}
