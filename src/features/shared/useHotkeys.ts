import { useEffect } from "react";

export interface Hotkeys {
  onRecalibrate: () => void;
  onPauseToggle: () => void;
  onToggleDiagnostics: () => void;
}

export function useHotkeys(h: Hotkeys) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      if (mod && e.shiftKey && e.code === "KeyC") { e.preventDefault(); h.onRecalibrate(); }
      else if (mod && e.shiftKey && e.code === "KeyD") { e.preventDefault(); h.onToggleDiagnostics(); }
      else if (e.code === "Space" && !target?.matches("input,textarea,button")) { e.preventDefault(); h.onPauseToggle(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [h]);
}
