import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { setClickThrough } from "@/core/system/nativeInput";
import type { RingState } from "@/core/system/ringBus";

// The follower cursor-ring window: a tiny always-on-top, click-through,
// non-activating window that Rust rides along at the OS cursor (repositioned in
// the same native call as each cursor warp). It draws the dwell-fill ring,
// animating the fill LOCALLY at display refresh rate from start/duration — so
// the fill is butter-smooth regardless of event cadence — and stays fully
// transparent when idle.

const R = 20;
const C = 2 * Math.PI * R;

export function CursorRing() {
  const [state, setState] = useState<RingState>({ mode: "hidden", color: "#3c82f6" });
  const [progress, setProgress] = useState(0);
  const [flash, setFlash] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    // This window must never eat clicks and never show a background.
    document.body.style.background = "transparent";
    document.documentElement.style.background = "transparent";
    void setClickThrough(true);
    const iv = window.setInterval(() => void setClickThrough(true), 2000);

    const unState = listen<RingState>("ring:state", (e) => setState(e.payload));
    const unFlash = listen("ring:flash", () => {
      setFlash(true);
      window.setTimeout(() => setFlash(false), 220);
    });
    return () => {
      window.clearInterval(iv);
      void unState.then((f) => f());
      void unFlash.then((f) => f());
    };
  }, []);

  // Local fill animation — deterministic from the shared epoch clock. The RAF
  // only runs while a dwell is actually filling; otherwise this webview is
  // completely idle (zero per-frame work when hidden or merely hovering).
  useEffect(() => {
    if (state.mode !== "dwell") { setProgress(0); return; }
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const s = stateRef.current;
      if (s.mode === "dwell" && s.start && s.durationMs) {
        setProgress(Math.max(0, Math.min(1, (Date.now() - s.start) / s.durationMs)));
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state.mode]);

  const visible = state.mode !== "hidden" || flash;
  const color = flash ? "#34d399" : state.color;

  return (
    <div style={{ position: "fixed", inset: 0, display: "grid", placeItems: "center",
      pointerEvents: "none", opacity: visible ? 1 : 0, transition: "opacity 180ms" }}>
      <svg width={52} height={52} viewBox="0 0 52 52"
        style={{ transform: `scale(${flash ? 1.2 : 1})`, transition: "transform 140ms" }}>
        <circle cx="26" cy="26" r={R} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="3" />
        <circle cx="26" cy="26" r={R} fill="none" stroke={color} strokeWidth="3.5" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={C * (1 - progress)} transform="rotate(-90 26 26)"
          style={{ transition: "stroke 200ms" }} />
        <circle cx="26" cy="26" r="4.5" fill={color} style={{ transition: "fill 200ms" }} />
      </svg>
    </div>
  );
}
