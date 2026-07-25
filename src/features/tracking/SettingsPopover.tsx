import { useEffect, useRef } from "react";
import { Glass } from "@/features/shared/Glass";

export function SettingsPopover({ side, onClose, children }: {
  side: "left" | "right" | "center"; onClose: () => void; children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onClick); document.removeEventListener("keydown", onKey); };
  }, [onClose]);

  const pos: React.CSSProperties =
    side === "left" ? { left: 0 } : side === "right" ? { right: 0 } : { left: "50%", transform: "translateX(-50%)" };

  return (
    <Glass ref={ref} radius="lg" className="fade-enter"
      style={{ position: "absolute", bottom: "calc(100% + 10px)", width: 280, padding: "var(--s-4)", ...pos }}>
      {children}
    </Glass>
  );
}
