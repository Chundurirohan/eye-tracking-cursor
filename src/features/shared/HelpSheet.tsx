import { Glass } from "./Glass";

// A compact reference of gestures + global shortcuts. Opened from Settings, it
// makes the (otherwise hidden) interaction model discoverable.

const GESTURES: [string, string][] = [
  ["Rest your gaze on a control", "Dwell-click it (the ring fills)"],
  ["Rest on empty space", "Open the action wheel (or click, per settings)"],
  ["Look at the top / bottom edge", "Scroll the page up / down"],
  ["Action wheel → Drag", "Dwell to start the drag, dwell again to drop"],
];

const SHORTCUTS: [string, string][] = [
  ["⌃⌥Space", "Hand control between eyes and mouse"],
  ["⌃⌥P", "Pause / resume tracking"],
  ["⌃⌥R", "Re-center (look at the dot ~1s)"],
  ["⌃⌥Return", "Click now (switch / external trigger)"],
  ["⌃⌥K", "Toggle the on-screen keyboard"],
  ["⌃⌥Z", "Toggle precision (fine-targeting) mode"],
  ["⌃⌥T", "Run / close the accuracy test"],
];

export function HelpSheet({ onClose }: { onClose: () => void }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 95, display: "grid", placeItems: "center",
      background: "rgba(0,0,0,0.45)", backdropFilter: "blur(3px)" }} className="fade-enter">
      <Glass radius="lg" style={{ width: "min(460px, 92vw)", maxHeight: "86vh", overflowY: "auto",
        padding: "var(--s-6)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--s-4)" }}>
          <h2 style={{ fontSize: 19 }}>Gestures &amp; shortcuts</h2>
          <button onClick={onClose} aria-label="Close" data-dwell
            style={{ width: 30, height: 30, borderRadius: 999, fontSize: 15, color: "var(--text-2)",
              background: "var(--accent-soft)" }}>✕</button>
        </div>
        <Section title="Gestures" rows={GESTURES} />
        <div style={{ height: "var(--s-4)" }} />
        <Section title="Keyboard shortcuts" rows={SHORTCUTS} mono />
      </Glass>
    </div>
  );
}

function Section({ title, rows, mono }: { title: string; rows: [string, string][]; mono?: boolean }) {
  return (
    <div>
      <h3 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: "0.04em",
        color: "var(--text-3)", marginBottom: "var(--s-2)" }}>{title}</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
            <span className={mono ? "mono" : undefined}
              style={{ flexShrink: 0, minWidth: mono ? 92 : 176, fontSize: 12.5, fontWeight: 600,
                color: "var(--text)" }}>{k}</span>
            <span style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.4 }}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
