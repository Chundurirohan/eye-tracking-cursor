import type { GazeAction } from "@/core/system/nativeInput";

// The action wheel: after a dwell in free space, this pops up at the gaze point
// so a single glance chooses left / double / right click (and cancel). Each
// petal is a real dwell target (`data-dwell` + <button>), so the existing
// DwellCursor DOM path selects it — the same path that already works reliably.

const ACTIONS: { action: GazeAction; label: string; icon: string }[] = [
  { action: "left", label: "Click", icon: "🖱" },
  { action: "double", label: "Double", icon: "⧉" },
  { action: "right", label: "Right", icon: "☰" },
];

export function RadialMenu({ center, onSelect, onCancel }: {
  center: { x: number; y: number }; // screen pixels
  onSelect: (a: GazeAction) => void;
  onCancel: () => void;
}) {
  const R = 96;       // petal ring radius
  const petal = 66;   // petal diameter
  const n = ACTIONS.length;

  const petalStyle: React.CSSProperties = {
    position: "fixed", width: petal, height: petal, borderRadius: 999,
    transform: "translate(-50%,-50%)", pointerEvents: "auto",
    display: "grid", placeItems: "center", gap: 0, lineHeight: 1.1,
    background: "var(--glass, rgba(30,32,40,0.82))",
    border: "1.5px solid var(--stroke, rgba(255,255,255,0.18))",
    boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
    color: "var(--text, #fff)", fontSize: 20, fontWeight: 600,
    backdropFilter: "blur(12px)",
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, pointerEvents: "none" }}>
      {/* soft focus ring at the anchor point */}
      <div style={{
        position: "fixed", left: center.x, top: center.y, transform: "translate(-50%,-50%)",
        width: R * 2 + petal, height: R * 2 + petal, borderRadius: 999,
        border: "1px solid rgba(255,255,255,0.10)", background: "rgba(0,0,0,0.10)",
      }} />
      {ACTIONS.map((a, i) => {
        // Spread the petals in an arc across the top of the anchor.
        const deg = -90 + (i - (n - 1) / 2) * 52;
        const rad = (deg * Math.PI) / 180;
        const x = center.x + R * Math.cos(rad);
        const y = center.y + R * Math.sin(rad);
        return (
          <button key={a.action} data-dwell aria-label={a.label}
            onClick={() => onSelect(a.action)}
            style={{ ...petalStyle, left: x, top: y }}>
            <span>{a.icon}</span>
            <span style={{ fontSize: 11, fontWeight: 500, opacity: 0.85 }}>{a.label}</span>
          </button>
        );
      })}
      {/* cancel below the anchor */}
      <button data-dwell aria-label="Cancel" onClick={onCancel}
        style={{ ...petalStyle, left: center.x, top: center.y + R,
          width: petal * 0.8, height: petal * 0.8, fontSize: 18,
          background: "var(--glass, rgba(40,30,34,0.82))" }}>
        <span>✕</span>
      </button>
    </div>
  );
}
