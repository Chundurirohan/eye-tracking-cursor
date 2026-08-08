import { Glass } from "@/features/shared/Glass";
import type { ConfidenceFactors } from "@/core/engine/types";

export interface Diagnostics {
  confidence: number;
  factors: ConfidenceFactors | null;
  quality: number;
  fps: number;
  headPose: { yaw: number; pitch: number } | null;
  engine: string;
}

const deg = (r: number) => Math.round((r * 180) / Math.PI);
const pct = (v: number) => `${Math.round(v * 100)}%`;

export function AdvancedView({ d, onClose }: { d: Diagnostics; onClose: () => void }) {
  return (
    <Glass radius="lg" className="fade-enter"
      style={{ position: "absolute", top: 132, right: "var(--s-5)", width: 240, padding: "var(--s-4)", zIndex: 9 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "var(--s-3)" }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Diagnostics</span>
        <button onClick={onClose} aria-label="Close" style={{ color: "var(--text-3)", fontSize: 13 }}>✕</button>
      </div>
      <Row label="Confidence" value={pct(d.confidence)} />
      {d.factors && <>
        <Row label="• Eyes (openness)" value={pct(d.factors.openness)} />
        <Row label="• Head (pose)" value={pct(d.factors.pose)} />
        <Row label="• Face" value={pct(d.factors.face)} />
        {d.factors.fit != null && <Row label="• Fit" value={pct(d.factors.fit)} />}
      </>}
      <Row label="Calibration quality" value={pct(d.quality)} />
      <Row label="Frame rate" value={`${d.fps.toFixed(0)} fps`} />
      <Row label="Head yaw / pitch" value={d.headPose ? `${deg(d.headPose.yaw)}° / ${deg(d.headPose.pitch)}°` : "—"} />
      <Row label="Engine" value={d.engine} />
    </Glass>
  );
}

const Row = ({ label, value }: { label: string; value: string }) => (
  <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 12.5 }}>
    <span style={{ color: "var(--text-2)" }}>{label}</span>
    <span className="mono">{value}</span>
  </div>
);
