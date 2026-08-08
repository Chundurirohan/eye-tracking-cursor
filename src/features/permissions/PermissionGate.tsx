import { useState } from "react";
import { Glass } from "@/features/shared/Glass";

export function PermissionGate({ error, onRequest }: { error: string | null; onRequest: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }} className="fade-enter">
      <Glass radius="lg" style={{ padding: "var(--s-7)", maxWidth: 380, textAlign: "center" }}>
        <div style={{ width: 56, height: 56, margin: "0 auto var(--s-4)", borderRadius: 16,
          background: "var(--accent-soft)", display: "grid", placeItems: "center", fontSize: 26 }}>👁</div>
        <h2 style={{ fontSize: 19 }}>Allow camera access</h2>
        <p style={{ color: "var(--text-2)", fontSize: 14, margin: "var(--s-2) 0 var(--s-5)", lineHeight: 1.5 }}>
          Gaze uses your camera locally to estimate where you're looking. Video never leaves your device.
        </p>
        {error && <p style={{ color: "var(--bad)", fontSize: 13, marginBottom: "var(--s-3)" }}>{error}</p>}
        <button disabled={busy}
          onClick={async () => { setBusy(true); try { await onRequest(); } finally { setBusy(false); } }}
          style={{ width: "100%", padding: "12px 16px", borderRadius: "var(--radius-md)",
            background: "var(--accent)", color: "#fff", fontSize: 15, fontWeight: 500,
            opacity: busy ? 0.6 : 1, transition: "opacity var(--dur-fast)" }}>
          {busy ? "Requesting…" : "Continue"}
        </button>
      </Glass>
    </div>
  );
}
