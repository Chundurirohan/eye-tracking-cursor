import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { CursorRing } from "./features/tracking/CursorRing";
import { WheelWindow } from "./features/tracking/WheelWindow";
import { KeyboardWindow } from "./features/tracking/KeyboardWindow";

// Multi-window entry: the same bundle serves the main app AND the auxiliary
// widget windows (cursor ring, action wheel, keyboard); route by the Tauri
// window label. In plain-browser dev (no Tauri) there is only ever the main app.
function windowLabel(): string {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return "main";
  try {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__;
    return internals.metadata?.currentWindow?.label ?? "main";
  } catch {
    return "main";
  }
}

function Root() {
  switch (windowLabel()) {
    case "ring": return <CursorRing />;
    case "wheel": return <WheelWindow />;
    case "keyboard": return <KeyboardWindow />;
    default: return <App />;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><Root /></React.StrictMode>
);
