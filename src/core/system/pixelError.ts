import { invoke } from "@tauri-apps/api/core";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Start a new accuracy-test log; resolves to its file path/name. Compiled app →
 * native app-data dir; dev server → the Vite middleware writes into `public/`. */
export async function startDiagnosticLog(): Promise<string> {
  if (inTauri) return (await invoke("diag_log_start")) as string;
  const response = await fetch("/pixel-error-test/start", { method: "POST" });
  if (!response.ok) throw new Error(`log start failed (${response.status})`);
  return ((await response.json()) as { file: string }).file;
}

/** Append one already-formatted line to a log made by `startDiagnosticLog`. */
export async function appendDiagnosticLog(file: string, line: string): Promise<void> {
  if (inTauri) { await invoke("diag_log_append", { file, line }); return; }
  throw new Error("appendDiagnosticLog is native-only");
}

type Point = { x: number; y: number };

const PIXEL_ERROR_SERVER = "/pixel-error";
let actualCursor: Point | null = null;

if (typeof window !== "undefined") {
  window.addEventListener("mousemove", (event) => {
    actualCursor = { x: event.clientX, y: event.clientY };
  });
}

/** Last mousemove older than this is treated as stale (cursor left our window). */
const FRESH_MS = 1500;
let actualAt = 0;
if (typeof window !== "undefined") window.addEventListener("mousemove", () => { actualAt = performance.now(); });

/** Send one dwell-cycle prediction error to the local log. `predicted` is the
 * normalized (0–1) gaze point. The actual cursor comes from the webview's own
 * pointer events while the cursor is over our window, else from the native layer. */
export async function logPixelError(predicted: Point): Promise<void> {
  if (typeof window === "undefined") return;

  let predictedPx = { x: predicted.x * window.innerWidth, y: predicted.y * window.innerHeight };
  let actual = performance.now() - actualAt < FRESH_MS ? actualCursor : null;
  if (!actual && inTauri) {
    try {
      const c = (await invoke("cursor_norm")) as [number, number, number, number] | null;
      if (c) {
        actual = { x: c[0] * c[2], y: c[1] * c[3] };
        predictedPx = { x: predicted.x * c[2], y: predicted.y * c[3] };
      }
    } catch { /* fall through to "unavailable" */ }
  }
  const distance = actual ? Math.hypot(predictedPx.x - actual.x, predictedPx.y - actual.y) : null;
  const line = [
    `predicted=(${predictedPx.x.toFixed(2)},${predictedPx.y.toFixed(2)})`,
    actual ? `actual=(${actual.x.toFixed(2)},${actual.y.toFixed(2)})` : "actual=unavailable",
    distance === null ? "distance=unavailable" : `distance=${distance.toFixed(2)}px`,
  ].join(" ") + "\n";

  if (inTauri) {
    try { await invoke("diag_log_append", { file: "pixel_error.log", line }); }
    catch (error) { console.error("[gaze] pixel error log failed:", error); }
    return;
  }
  void fetch(PIXEL_ERROR_SERVER, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: line,
  }).catch((error: unknown) => {
    console.error("[gaze] pixel error server unavailable:", error);
  });
}
