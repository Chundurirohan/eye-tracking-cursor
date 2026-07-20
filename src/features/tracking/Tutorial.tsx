import { useState } from "react";
import { Glass } from "@/features/shared/Glass";

// A short, skippable first-run walkthrough shown right after the first
// successful calibration. Its buttons are dwell-operable (data-dwell), so the
// user learns the core gesture — resting their gaze to click — by using it.

const STEPS: { icon: string; title: string; body: string }[] = [
  { icon: "🎯", title: "Rest your gaze to click",
    body: "Hold your gaze on any button and the ring fills to click it. Try it on “Next”." },
  { icon: "📜", title: "Look at the edges to scroll",
    body: "Rest your gaze in the band at the top or bottom of the screen to scroll a page up or down." },
  { icon: "🖱", title: "Right-click, double-click, drag",
    body: "Dwell on empty space to open the action wheel, then pick Click, Right, Double, or Drag." },
  { icon: "⌨️", title: "You're always in control",
    body: "⌃⌥Space hands control back to your mouse. ⌃⌥P pauses, ⌃⌥K opens the keyboard. See Settings → “? Help”." },
];

export function Tutorial({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0);
  const step = STEPS[i]!;
  const last = i === STEPS.length - 1;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 92, display: "grid", placeItems: "center",
      background: "rgba(0,0,0,0.4)", backdropFilter: "blur(2px)" }} className="fade-enter">
      <Glass radius="lg" style={{ width: "min(440px, 92vw)", padding: "var(--s-6)", textAlign: "center" }}>
        <div style={{ fontSize: 40, marginBottom: "var(--s-3)" }}>{step.icon}</div>
        <h2 style={{ fontSize: 20 }}>{step.title}</h2>
        <p className="dim" style={{ margin: "var(--s-2) 0 var(--s-5)", fontSize: 14, lineHeight: 1.5 }}>{step.body}</p>

        <div style={{ display: "flex", justifyContent: "center", gap: 6, marginBottom: "var(--s-5)" }}>
          {STEPS.map((_, k) => (
            <span key={k} style={{ width: 7, height: 7, borderRadius: 999,
              background: k === i ? "var(--accent)" : "var(--text-3)" }} />
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "center", gap: 10 }}>
          <button data-dwell onClick={onDone}
            style={{ padding: "10px 20px", borderRadius: "var(--radius-md)", fontSize: 14, fontWeight: 500,
              background: "var(--accent-soft)", color: "var(--text-2)" }}>
            Skip
          </button>
          <button data-dwell onClick={() => (last ? onDone() : setI(i + 1))}
            style={{ padding: "10px 24px", borderRadius: "var(--radius-md)", fontSize: 14, fontWeight: 500,
              background: "var(--accent)", color: "#fff" }}>
            {last ? "Got it" : "Next"}
          </button>
        </div>
      </Glass>
    </div>
  );
}
