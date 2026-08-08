/** A labeled range slider for numeric settings. Shows the live value via
 * `format`. Native <input type="range"> so it's keyboard- and pointer-operable. */
export function Slider({
  label, value, min, max, step = 1, onChange, format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <div style={{ padding: "9px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontSize: 13.5 }}>{label}</span>
        <span className="mono" style={{ fontSize: 12, color: "var(--text-2)" }}>
          {format ? format(value) : value}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        style={{ width: "100%", accentColor: "var(--accent)", cursor: "pointer" }} />
    </div>
  );
}
