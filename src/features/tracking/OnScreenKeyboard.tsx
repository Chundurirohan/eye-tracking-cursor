import { useState } from "react";
import { typeText, keyTap } from "@/core/system/nativeInput";

// A hands-free dwell keyboard. Keys are data-dwell targets, so the DwellCursor
// activates them; each key types into whatever app currently has focus (our
// overlay is click-through and never steals focus). Letters type via a Unicode
// string; Backspace / Return / Space use virtual keycodes.

const KEY_DELETE = 51, KEY_RETURN = 36, KEY_SPACE = 49;

const LETTERS = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m"],
];
const SYMBOLS = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["-", "/", ":", ";", "(", ")", "$", "&", "@"],
  [".", ",", "?", "!", "'", "\"", "+"],
];

export function OnScreenKeyboard({ onClose, onKeyFeedback }: {
  onClose: () => void;
  /** Play the shared click feedback (respects the sound setting). */
  onKeyFeedback?: () => void;
}) {
  const [shift, setShift] = useState(false);
  const [symbols, setSymbols] = useState(false);
  const rows = symbols ? SYMBOLS : LETTERS;

  const press = (fn: () => void) => { fn(); onKeyFeedback?.(); };
  const typeChar = (ch: string) => press(() => typeText(shift && !symbols ? ch.toUpperCase() : ch));

  return (
    <div style={{ position: "fixed", left: "50%", bottom: "calc(var(--s-5) + 64px)", transform: "translateX(-50%)",
      zIndex: 88, width: "min(760px, 96vw)" }}>
      <div className="glass" style={{ borderRadius: "var(--radius-lg)", padding: "10px 12px",
        display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((row, ri) => (
          <div key={ri} style={{ display: "flex", justifyContent: "center", gap: 6 }}>
            {ri === rows.length - 1 && !symbols && (
              <Key wide onClick={() => press(() => setShift((v) => !v))} active={shift}>⇧</Key>
            )}
            {row.map((ch) => (
              <Key key={ch} onClick={() => typeChar(ch)}>{shift && !symbols ? ch.toUpperCase() : ch}</Key>
            ))}
            {ri === rows.length - 1 && (
              <Key wide onClick={() => press(() => keyTap(KEY_DELETE))}>⌫</Key>
            )}
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "center", gap: 6 }}>
          <Key wide onClick={() => press(() => setSymbols((v) => !v))} active={symbols}>{symbols ? "ABC" : "123"}</Key>
          <Key grow onClick={() => press(() => keyTap(KEY_SPACE))}>space</Key>
          <Key wide onClick={() => press(() => keyTap(KEY_RETURN))}>⏎</Key>
          <Key wide onClick={onClose}>✕</Key>
        </div>
      </div>
    </div>
  );
}

function Key({ children, onClick, wide, grow, active }: {
  children: React.ReactNode; onClick: () => void; wide?: boolean; grow?: boolean; active?: boolean;
}) {
  return (
    <button data-dwell onClick={onClick}
      style={{ height: 46, minWidth: wide ? 64 : 40, flex: grow ? 1 : undefined,
        padding: "0 10px", borderRadius: 10, fontSize: 16, fontWeight: 600,
        background: active ? "var(--accent)" : "var(--accent-soft)",
        color: active ? "#fff" : "var(--text)",
        border: "1px solid var(--stroke)" }}>
      {children}
    </button>
  );
}
