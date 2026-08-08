import { Glass } from "@/features/shared/Glass";
import { confidenceLook } from "@/features/shared/confidenceColor";

/** Always-visible accuracy readout pinned to the top-right corner. Shows the
 * live confidence score so the user can tell, at a glance, how good the current
 * reading is during calibration and tracking. */
export function ConfidenceMeter({ value }: { value: number | null }) {
  const v = value == null ? 0 : Math.max(0, Math.min(1, value));
  const { label, color } = confidenceLook(v);
  const pct = Math.round(v * 100);

  return (
    <Glass radius="lg" className="fade-enter"
      style={{ position: "absolute", top: "var(--s-5)", right: "var(--s-5)",
        width: 168, padding: "var(--s-3) var(--s-4)", zIndex: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 11.5, letterSpacing: "0.04em", textTransform: "uppercase",
          color: "var(--text-3)" }}>Confidence</span>
        <span className="mono" style={{ fontSize: 18, fontWeight: 600, color }}>{pct}%</span>
      </div>
      <div style={{ marginTop: 8, height: 6, borderRadius: 999, background: "var(--accent-soft)",
        overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 999,
          transition: "width 120ms linear, background 200ms" }} />
      </div>
      <div style={{ marginTop: 6, fontSize: 12, color, fontWeight: 500 }}>{label}</div>
    </Glass>
  );
}
