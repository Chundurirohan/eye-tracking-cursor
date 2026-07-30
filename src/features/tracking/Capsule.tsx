import { useState } from "react";
import { Glass } from "@/features/shared/Glass";
import { SettingsPopover } from "./SettingsPopover";
import type { AppState } from "@/core/session/machine";

const STATUS_LABEL: Partial<Record<AppState, string>> = {
  tracking: "Tracking", reacquiring: "Reacquiring…", paused: "Paused",
};
const STATUS_COLOR: Partial<Record<AppState, string>> = {
  tracking: "var(--good)", reacquiring: "var(--warn)", paused: "var(--text-3)",
};

export function Capsule({ state, side, armed = true, onPauseToggle, onRecalibrate, settingsSlot,
  keyboardOn = false, onToggleKeyboard, zoomOn = false, onToggleZoom }: {
  state: AppState;
  side: "left" | "right" | "center";
  armed?: boolean;
  onPauseToggle: () => void;
  onRecalibrate: () => void;
  settingsSlot: React.ReactNode;
  /** On-screen keyboard toggle (dwell-clickable). */
  keyboardOn?: boolean;
  onToggleKeyboard?: () => void;
  /** macOS Zoom magnifier toggle (dwell-clickable). */
  zoomOn?: boolean;
  onToggleZoom?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const paused = state === "paused";
  const pos: React.CSSProperties =
    side === "left" ? { left: "var(--s-5)" } : side === "right" ? { right: "var(--s-5)" }
      : { left: "50%", transform: "translateX(-50%)" };
  // The control bar is large by default so its buttons are easy dwell-click
  // targets with imperfect gaze accuracy. Bumped up because tightly-packed small
  // icons were indistinguishable to gaze — a look at Pause/Settings could snap to
  // the neighbouring keyboard toggle ("buttons open the keyboard" bug).
  const s = 1.8;

  return (
    <div style={{ position: "absolute", bottom: "var(--s-5)", zIndex: 10, ...pos }}>
      {open && <SettingsPopover side={side} onClose={() => setOpen(false)}>{settingsSlot}</SettingsPopover>}
      <Glass radius="pill" style={{ display: "flex", alignItems: "center", gap: 11 * s, padding: `${8 * s}px ${10 * s}px ${8 * s}px ${14 * s}px`,
        transition: "padding var(--dur-med) var(--ease-soft)" }}>
        <span style={{ width: 8 * s, height: 8 * s, borderRadius: 999, background: STATUS_COLOR[state] ?? "var(--text-3)",
          boxShadow: state === "tracking" ? "0 0 8px var(--good)" : "none", transition: "background var(--dur-med)" }} />
        <span style={{ fontSize: 13 * s, fontWeight: 500, minWidth: 78 * s }}>{STATUS_LABEL[state] ?? "Idle"}</span>
        <span title="Toggle with ⌃⌥Space" style={{ fontSize: 11 * s, fontWeight: 500, padding: `${3 * s}px ${8 * s}px`,
          borderRadius: 999, whiteSpace: "nowrap",
          background: armed ? "var(--accent-soft)" : "var(--stroke)",
          color: armed ? "var(--accent)" : "var(--text-3)" }}>
          {armed ? "Eye control ⌃⌥Space" : "Mouse ⌃⌥Space"}
        </span>
        <span style={{ width: 1, height: 18 * s, background: "var(--stroke)" }} />
        <IconBtn size={s} label={paused ? "Resume" : "Pause"} onClick={onPauseToggle}>{paused ? "▶" : "❙❙"}</IconBtn>
        <IconBtn size={s} label="Recalibrate" onClick={onRecalibrate}>⟳</IconBtn>
        <IconBtn size={s} label="Settings" onClick={() => setOpen((o) => !o)}>⚙</IconBtn>
        {(onToggleKeyboard || onToggleZoom) && (
          <span style={{ width: 1, height: 22 * s, background: "var(--stroke)" }} />
        )}
        {onToggleZoom && (
          <IconBtn size={s} label={zoomOn ? "Turn off magnifier" : "Magnifier (zoom around reticle)"}
            active={zoomOn} onClick={onToggleZoom}>🔍</IconBtn>
        )}
        {onToggleKeyboard && (
          <IconBtn size={s} label={keyboardOn ? "Hide keyboard" : "On-screen keyboard"}
            active={keyboardOn} onClick={onToggleKeyboard}>⌨</IconBtn>
        )}
      </Glass>
    </div>
  );
}

function IconBtn({ children, label, onClick, size = 1, active = false }: { children: React.ReactNode; label: string; onClick: () => void; size?: number; active?: boolean }) {
  return (
    <button data-dwell onClick={onClick} title={label} aria-label={label}
      style={{ width: 34 * size, height: 34 * size, borderRadius: 999, fontSize: 14 * size, display: "grid", placeItems: "center",
        background: active ? "var(--accent-soft)" : "transparent",
        color: active ? "var(--accent)" : "var(--text-2)",
        transition: "background var(--dur-fast), color var(--dur-fast), width var(--dur-med), height var(--dur-med)" }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--accent-soft)"; e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = active ? "var(--accent-soft)" : "transparent"; e.currentTarget.style.color = active ? "var(--accent)" : "var(--text-2)"; }}>
      {children}
    </button>
  );
}
