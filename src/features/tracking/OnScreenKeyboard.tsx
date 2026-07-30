import { useRef, useState } from "react";
import { typeText, keyTap } from "@/core/system/nativeInput";
import { suggest } from "./predict";

// A hands-free dwell keyboard. Keys are data-dwell targets, so the DwellCursor
// activates them; each key types into whatever app currently has focus (our
// overlay is click-through and never steals focus). Letters type via a Unicode
// string; Backspace / Return / Space use virtual keycodes.

const KEY_DELETE = 51, KEY_RETURN = 36, KEY_SPACE = 49;
// Keys need DELIBERATE dwell so a glance doesn't type gibberish. A "settle gate"
// (data-dwell-settle) means the fill only begins after your gaze has rested on a
// key briefly — so keys you merely pass OVER on the way never fire. Together with
// the longer dwell this trades a little speed for far fewer accidental keystrokes.
const KEY_DWELL_MS = 850;
const KEY_SETTLE_MS = 160;

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

  // Word prediction: track the word being typed THROUGH this keyboard (we can't
  // read other apps' fields) and offer frequency-ranked completions as chips.
  const wordRef = useRef("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const setWord = (w: string) => {
    wordRef.current = w;
    setSuggestions(suggest(w));
  };

  // A local echo of what's been typed through the keyboard, shown in a bar on top
  // so the user gets feedback without having to see the (often far-away) target
  // field. Approximate: it mirrors keys pressed HERE, not the real field.
  const [typed, setTyped] = useState("");

  const press = (fn: () => void) => { fn(); onKeyFeedback?.(); };
  const typeChar = (ch: string) => press(() => {
    const out = shift && !symbols ? ch.toUpperCase() : ch;
    typeText(out);
    setTyped((t) => t + out);
    // Letters (and apostrophes) extend the current word; punctuation ends it.
    if (/[a-zA-Z']/.test(out)) setWord(wordRef.current + out);
    else setWord("");
  });
  const acceptSuggestion = (w: string) => press(() => {
    // Type only the remainder plus a trailing space — the prefix is already in
    // the target field.
    const rest = w.slice(wordRef.current.length) + " ";
    typeText(rest);
    setTyped((t) => t + rest);
    setWord("");
  });

  return (
    <div style={{ position: "fixed", left: "50%", bottom: "calc(var(--s-4) + 40px)", transform: "translateX(-50%)",
      zIndex: 88, width: "min(1600px, 99vw)" }}>
      <div className="glass" style={{ borderRadius: "var(--radius-lg)", padding: "22px 24px",
        display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Typed-text echo bar: shows what you've typed through the keyboard so
            you don't need to watch the (often distant) target field. The tail is
            kept visible (flex-end + overflow) so the caret is always in view. */}
        <div style={{ display: "flex", alignItems: "center",
          justifyContent: typed ? "flex-end" : "center", height: 76, padding: "0 26px",
          borderRadius: 16, overflow: "hidden", background: "var(--accent-soft)",
          border: "1px solid var(--stroke)" }}>
          {typed ? (
            <span style={{ whiteSpace: "pre", fontSize: 36, fontWeight: 500, color: "var(--text)" }}>
              {typed}<span style={{ opacity: 0.5 }}>▏</span>
            </span>
          ) : (
            <span style={{ fontSize: 22, color: "var(--text-3)" }}>Your typing appears here</span>
          )}
        </div>
        {/* Word-prediction chips: fixed-height row (no layout jump), each a
            dwell-friendly completion of the word being typed. */}
        <div style={{ display: "flex", justifyContent: "center", gap: 16, height: 72 }}>
          {suggestions.length === 0 ? (
            <span style={{ alignSelf: "center", fontSize: 12, color: "var(--text-3)" }}>
              {wordRef.current ? "…" : "suggestions appear as you type"}
            </span>
          ) : (
            suggestions.map((w) => (
              <button key={w} data-dwell data-dwell-ms={KEY_DWELL_MS} data-dwell-settle={KEY_SETTLE_MS} onClick={() => acceptSuggestion(w)}
                style={{ padding: "0 38px", borderRadius: 999, fontSize: 28, fontWeight: 600,
                  background: "var(--accent-soft)", color: "var(--accent)",
                  border: "1px solid var(--stroke)" }}>
                {/[A-Z]/.test(wordRef.current[0] ?? "") ? w[0]!.toUpperCase() + w.slice(1) : w}
              </button>
            ))
          )}
        </div>
        {rows.map((row, ri) => (
          <div key={ri} style={{ display: "flex", justifyContent: "center", gap: 16 }}>
            {ri === rows.length - 1 && !symbols && (
              <Key wide onClick={() => press(() => setShift((v) => !v))} active={shift}>⇧</Key>
            )}
            {row.map((ch) => (
              <Key key={ch} onClick={() => typeChar(ch)}>{shift && !symbols ? ch.toUpperCase() : ch}</Key>
            ))}
            {ri === rows.length - 1 && (
              <Key wide onClick={() => press(() => { keyTap(KEY_DELETE); setWord(wordRef.current.slice(0, -1)); setTyped((t) => t.slice(0, -1)); })}>⌫</Key>
            )}
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "center", gap: 16 }}>
          <Key wide onClick={() => press(() => setSymbols((v) => !v))} active={symbols}>{symbols ? "ABC" : "123"}</Key>
          <Key grow onClick={() => press(() => { keyTap(KEY_SPACE); setWord(""); setTyped((t) => t + " "); })}>space</Key>
          <Key wide onClick={() => press(() => { keyTap(KEY_RETURN); setWord(""); setTyped(""); })}>⏎</Key>
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
    <button data-dwell data-dwell-ms={KEY_DWELL_MS} data-dwell-settle={KEY_SETTLE_MS} onClick={onClick}
      style={{ height: 108, minWidth: wide ? 152 : 98, flex: grow ? 1 : undefined,
        padding: "0 20px", borderRadius: 18, fontSize: 38, fontWeight: 600,
        background: active ? "var(--accent)" : "var(--accent-soft)",
        color: active ? "#fff" : "var(--text)",
        border: "1px solid var(--stroke)" }}>
      {children}
    </button>
  );
}
