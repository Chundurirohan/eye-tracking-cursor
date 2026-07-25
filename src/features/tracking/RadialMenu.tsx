import type { GazeAction } from "@/core/system/nativeInput";

// The action wheel: after a dwell, this pops up at the gaze point so a single
// glance chooses the action. Left-click sits in the CENTER (where your gaze
// already is) as the fast default — just keep looking to left-click; glance out
// to a ring petal for double/right, or down to the (bigger) cancel. Each petal
// is a real dwell target (`data-dwell` + <button>), selected by the reliable
// DwellCursor DOM path.

// Secondary actions ringed around the center Click.
const RING: { action: GazeAction; label: string; icon: string; deg: number }[] = [
  { action: "double", label: "Double", icon: "⧉", deg: -145 },
  { action: "right", label: "Right", icon: "☰", deg: -35 },
];

const petalBase: React.CSSProperties = {
  position: "fixed", borderRadius: 999, transform: "translate(-50%,-50%)",
  pointerEvents: "auto", display: "grid", placeItems: "center", lineHeight: 1.1,
  border: "1.5px solid var(--stroke, rgba(255,255,255,0.18))",
  boxShadow: "0 6px 24px rgba(0,0,0,0.35)", color: "var(--text, #fff)",
  fontWeight: 600, backdropFilter: "blur(12px)",
};

export function RadialMenu({ center, onSelect, onCancel }: {
  center: { x: number; y: number }; // screen pixels
  onSelect: (a: GazeAction) => void;
  onCancel: () => void;
}) {
  const R = 104;         // ring radius
  const ringSize = 58;   // double / right petals
  const centerSize = 82; // Click (primary, biggest, in the middle)
  const cancelSize = 68;  // X — slightly bigger than the ring petals

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, pointerEvents: "none" }}>
      {/* soft focus ring behind the wheel */}
      <div style={{
        position: "fixed", left: center.x, top: center.y, transform: "translate(-50%,-50%)",
        width: R * 2 + centerSize, height: R * 2 + centerSize, borderRadius: 999,
        border: "1px solid rgba(255,255,255,0.10)", background: "rgba(0,0,0,0.10)",
      }} />

      {/* ring: double / right */}
      {RING.map((a) => {
        const rad = (a.deg * Math.PI) / 180;
        const x = center.x + R * Math.cos(rad);
        const y = center.y + R * Math.sin(rad);
        return (
          <button key={a.action} data-dwell aria-label={a.label} onClick={() => onSelect(a.action)}
            style={{ ...petalBase, left: x, top: y, width: ringSize, height: ringSize, fontSize: 19,
              background: "var(--glass, rgba(30,32,40,0.82))" }}>
            <span>{a.icon}</span>
            <span style={{ fontSize: 10, fontWeight: 500, opacity: 0.85 }}>{a.label}</span>
          </button>
        );
      })}

      {/* cancel — below the center, slightly bigger */}
      <button data-dwell aria-label="Cancel" onClick={onCancel}
        style={{ ...petalBase, left: center.x, top: center.y + R, width: cancelSize, height: cancelSize,
          fontSize: 26, background: "var(--glass, rgba(46,30,34,0.86))" }}>
        <span>✕</span>
      </button>

      {/* center: Click (primary left-click) — right where the gaze already is */}
      <button data-dwell aria-label="Click" onClick={() => onSelect("left")}
        style={{ ...petalBase, left: center.x, top: center.y, width: centerSize, height: centerSize,
          fontSize: 24, background: "var(--accent, rgba(60,130,246,0.92))",
          border: "2px solid rgba(255,255,255,0.35)" }}>
        <span>🖱</span>
        <span style={{ fontSize: 11, fontWeight: 600 }}>Click</span>
      </button>
    </div>
  );
}
