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

/** Inject a real right click at the gaze point (opens context menus). */
export function nativeRightClick(nx: number, ny: number): void {
  if (!inTauri) return;
  void invoke("mouse_right_click", { nx, ny }).catch(() => {});
}

/** Inject a real double click at the gaze point. */
export function nativeDoubleClick(nx: number, ny: number): void {
  if (!inTauri) return;
  void invoke("mouse_double_click", { nx, ny }).catch(() => {});
}

/** Scroll the app under the cursor vertically by `dy` pixels (sign = direction). */
export function nativeScroll(dy: number): void {
  if (!inTauri) return;
  void invoke("mouse_scroll", { dy: Math.round(dy) }).catch(() => {});
}

/** Whether the app currently has effective macOS Accessibility permission.
 * Synthetic clicks silently no-op when this is false. */
export async function isTrusted(): Promise<boolean> {
  if (!inTauri) return false;
  try { return (await invoke("is_trusted")) as boolean; } catch { return false; }
}

/** The set of gaze actions the radial menu can dispatch. */
export type GazeAction = "left" | "right" | "double";

/** Dispatch a chosen gaze action at a normalized point. */
export function dispatchAction(action: GazeAction, nx: number, ny: number): void {
  if (action === "right") nativeRightClick(nx, ny);
  else if (action === "double") nativeDoubleClick(nx, ny);
  else nativeClick(nx, ny);
}

/** Nearest clickable UI element (in ANY app) within `radius` of the gaze point.
 * Returns [nx, ny, wNorm, hNorm] of the target center (normalized to window
 * content), or null. Powers system-wide magnetic snapping. */
export async function snapTarget(
  nx: number, ny: number, radius: number,
): Promise<[number, number, number, number] | null> {
  if (!inTauri) return null;
  try {
    return (await invoke("snap_target", { nx, ny, radius })) as
      | [number, number, number, number]
      | null;
  } catch {
    return null;
  }
}

/** All nearby clickable targets (from the background scanner cache), each as
 * [nx, ny, wNorm, hNorm] normalized to window content. Fetched a few times a
 * second; the caller hit-tests it locally every frame for instant magnetism. */
export async function nativeTargets(): Promise<[number, number, number, number][]> {
  if (!inTauri) return [];
  try {
    return (await invoke("nearby_targets")) as [number, number, number, number][];
  } catch {
    return [];
  }
}

/** Type a Unicode string into the focused app (on-screen keyboard). */
export function typeText(text: string): void {
  if (!inTauri) return;
  void invoke("type_text", { text }).catch(() => {});
}

/** Tap a virtual key by macOS keycode (backspace 51, return 36, space 49, …). */
export function keyTap(code: number): void {
  if (!inTauri) return;
  void invoke("key_tap", { code }).catch(() => {});
}
