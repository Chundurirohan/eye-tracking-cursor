import { useEffect } from "react";
import { useWindowDwell, DwellHighlight } from "./useWindowDwell";
import { sendWheelSelect } from "@/core/system/overlayBus";
import "@/styles/global.css";

// The action menu, as its OWN window positioned at the gaze point (never resizes
// the main window — that per-click resize was the "slide to the corner" warp).
// A compact opaque glass panel of large dwell targets; the local dwell (fed by
// the main window's broadcast gaze) fires a button, which reports the choice
// back to main to dispatch the native action.

type Action = "left" | "right" | "double" | "drag" | "cancel";

const BTN: { action: Action; label: string; icon: string; primary?: boolean }[] = [
  { action: "left", label: "Click", icon: "🖱", primary: true },
  { action: "right", label: "Right", icon: "☰" },
  { action: "double", label: "Double", icon: "⧉" },
  { action: "drag", label: "Drag", icon: "✥" },
  { action: "cancel", label: "Cancel", icon: "✕" },
];

export function WheelWindow() {
  const dwell = useWindowDwell();

  useEffect(() => {
    document.body.style.background = "transparent";
    document.documentElement.style.background = "transparent";
  }, []);

  const btn = (a: (typeof BTN)[number], style: React.CSSProperties): React.ReactNode => (
    <button key={a.action} data-dwell onClick={() => sendWheelSelect(a.action)}
      style={{ display: "grid", placeItems: "center", gap: 2, borderRadius: 16, lineHeight: 1.1,
        fontWeight: 600, color: a.primary ? "#fff" : "var(--text)",
        background: a.primary ? "var(--accent)" : a.action === "cancel" ? "rgba(255,80,80,0.14)" : "var(--accent-soft)",
        border: "1px solid var(--stroke)", ...style }}>
      <span style={{ fontSize: a.primary ? 24 : 20 }}>{a.icon}</span>
      <span style={{ fontSize: 12, fontWeight: 600 }}>{a.label}</span>
    </button>
  );

  return (
    <div style={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none" }}>
      <div className="glass fade-enter" style={{ pointerEvents: "auto", borderRadius: 22, padding: 14,
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, width: 260 }}>
        {btn(BTN[0]!, { gridColumn: "1 / span 2", height: 66 })}
        {btn(BTN[1]!, { height: 64 })}
        {btn(BTN[2]!, { height: 64 })}
        {btn(BTN[3]!, { height: 64 })}
        {btn(BTN[4]!, { height: 64 })}
      </div>
      <DwellHighlight {...dwell} />
    </div>
  );
}
