/** A compact segmented control for choosing one of a small set of options.
 * Mirrors the inline "control bar position" picker so settings stay consistent. */
export function Segmented<T extends string>({
  label, value, options, onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: "flex", padding: "9px 0", alignItems: "center", justifyContent: "space-between",
      gap: 10, flexWrap: "wrap" }}>
      <span style={{ fontSize: 13.5 }}>{label}</span>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
        {options.map((o) => (
          <button key={o.value} onClick={() => onChange(o.value)}
            aria-pressed={value === o.value}
            style={{ padding: "4px 9px", borderRadius: 8, fontSize: 11.5, whiteSpace: "nowrap",
              background: value === o.value ? "var(--accent)" : "var(--accent-soft)",
              color: value === o.value ? "#fff" : "var(--text-2)",
              transition: "background var(--dur-fast)" }}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
