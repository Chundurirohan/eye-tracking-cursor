import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { CursorRing } from "./features/tracking/CursorRing";

// Multi-window entry: the same bundle serves the main app AND the tiny follower
// cursor-ring window; route by the Tauri window label. In plain-browser dev
// (no Tauri) there is only ever the main app.
function windowLabel(): string {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return "main";
  try {
    // Avoid importing the window API at module scope for the browser path.
    const internals = (window as unknown as { __TAURI_INTERNALS__: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__;
    return internals.metadata?.currentWindow?.label ?? "main";
  } catch {
    return "main";
  }
}

const isRing = windowLabel() === "ring";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{isRing ? <CursorRing /> : <App />}</React.StrictMode>
);
