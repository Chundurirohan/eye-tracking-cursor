// Bridge to the native macOS input layer (see src-tauri/src/lib.rs). Lets the
// gaze drive the REAL OS cursor and click into any app. All calls are guarded so
// they no-op in a plain browser (npm run dev) where Tauri isn't present.

import { invoke } from "@tauri-apps/api/core";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Let mouse input pass THROUGH the overlay (true) so the user can use their
 * computer, or capture it (false). Done via a Rust command so it isn't blocked
 * by the JS permission ACL. */
export async function setClickThrough(on: boolean): Promise<void> {
  if (!inTauri) return;
  try { await invoke("set_click_through", { on }); } catch { /* ignore */ }
}

/** Move the real OS cursor to the gaze point (normalized 0–1 of the window).
 * Rust converts to global screen coordinates from the real window geometry. */
export function warpCursor(nx: number, ny: number): void {
  if (!inTauri) return;
  void invoke("warp_cursor", { nx, ny }).catch(() => {});
}

/** Inject a real left click at the gaze point (clicks whatever app is there). */
export function nativeClick(nx: number, ny: number): void {
  if (!inTauri) return;
  void invoke("mouse_click", { nx, ny }).catch(() => {});
}
