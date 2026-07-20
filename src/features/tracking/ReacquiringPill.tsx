import { Glass } from "@/features/shared/Glass";

/** Shown while tracking is lost. `reason`, when given, tells the user what to fix
 * (out of frame, eyes, head pose) instead of a generic "reacquiring". */
export function ReacquiringPill({ reason }: { reason?: string | null }) {
  return (
    <Glass radius="pill" className="fade-enter" style={{ position: "absolute", top: "var(--s-5)", left: "50%",
      transform: "translateX(-50%)", padding: "8px 16px", display: "flex", alignItems: "center", gap: 8, zIndex: 9 }}>
      <span style={{ width: 8, height: 8, borderRadius: 999, background: "var(--warn)",
        animation: "pulse 1.4s var(--ease-soft) infinite" }} />
      <span style={{ fontSize: 13, color: "var(--text-2)" }}>{reason || "Reacquiring your gaze…"}</span>
      <style>{`@keyframes pulse { 0%,100% { opacity: 0.4 } 50% { opacity: 1 } }`}</style>
    </Glass>
  );
}
