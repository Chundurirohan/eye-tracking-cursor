import { Glass } from "@/features/shared/Glass";

export function ReacquiringPill() {
  return (
    <Glass radius="pill" className="fade-enter" style={{ position: "absolute", top: "var(--s-5)", left: "50%",
      transform: "translateX(-50%)", padding: "8px 16px", display: "flex", alignItems: "center", gap: 8, zIndex: 9 }}>
      <span style={{ width: 8, height: 8, borderRadius: 999, background: "var(--warn)",
        animation: "pulse 1.4s var(--ease-soft) infinite" }} />
      <span style={{ fontSize: 13, color: "var(--text-2)" }}>Reacquiring your gaze…</span>
      <style>{`@keyframes pulse { 0%,100% { opacity: 0.4 } 50% { opacity: 1 } }`}</style>
    </Glass>
  );
}
