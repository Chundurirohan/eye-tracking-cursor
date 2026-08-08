export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", fontSize: 13.5 }}>
      <span>{label}</span>
      <button onClick={() => onChange(!checked)} role="switch" aria-checked={checked}
        style={{ width: 40, height: 24, borderRadius: 999, padding: 2,
          background: checked ? "var(--accent)" : "var(--stroke)",
          transition: "background var(--dur-med) var(--ease-soft)" }}>
        <span style={{ display: "block", width: 20, height: 20, borderRadius: 999, background: "#fff",
          boxShadow: "0 1px 3px rgba(0,0,0,.3)",
          transform: checked ? "translateX(16px)" : "none",
          transition: "transform var(--dur-med) var(--ease-soft)" }} />
      </button>
    </label>
  );
}
