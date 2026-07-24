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

/** Pipe a perf-telemetry line to the terminal (diagnostics; no-op in browser). */
export function logPerf(msg: string): void {
  if (!inTauri) return;
  void invoke("log_perf", { msg }).catch(() => {});
}

/** Set the menu-bar (tray) status text shown next to the icon. */
export async function setTrayStatus(text: string): Promise<void> {
  if (!inTauri) return;
  try { await invoke("set_tray_status", { text }); } catch { /* ignore */ }
}

/** Open the macOS Accessibility settings pane so the user can grant/re-grant. */
export async function openAccessibilitySettings(): Promise<void> {
  if (!inTauri) return;
  try { await invoke("open_accessibility_settings"); } catch { /* ignore */ }
}

/** Re-trigger the native Accessibility permission prompt / registration. */
export async function requestAccessibility(): Promise<boolean> {
  if (!inTauri) return false;
  try { return (await invoke("request_accessibility")) as boolean; } catch { return false; }
}

/** Begin a gaze-driven drag (press & hold left button) at a normalized point. */
export function nativeDragStart(nx: number, ny: number): void {
  if (!inTauri) return;
  void invoke("mouse_drag_start", { nx, ny }).catch(() => {});
}

/** Continue a gaze-driven drag to a normalized point. */
export function nativeDragTo(nx: number, ny: number): void {
  if (!inTauri) return;
  void invoke("mouse_drag_to", { nx, ny }).catch(() => {});
}

/** Finish a gaze-driven drag (release left button) at a normalized point. */
export function nativeDragEnd(nx: number, ny: number): void {
  if (!inTauri) return;
  void invoke("mouse_drag_end", { nx, ny }).catch(() => {});
}

/** Type a Unicode string into the focused app (on-screen keyboard). */
export function typeText(text: string): void {
  if (!inTauri) return;
  void invoke("type_text", { text }).catch(() => {});
}

/** Tap a virtual key by macOS keycode (51 delete, 36 return, 49 space, …). */
export function keyTap(code: number): void {
  if (!inTauri) return;
  void invoke("key_tap", { code }).catch(() => {});
}

/** Capture the current window geometry as the gaze space. Call at the moment
 * tracking starts, while the main window still spans the calibrated screen. */
export async function captureGazeSpace(): Promise<void> {
  if (!inTauri) return;
  try { await invoke("capture_gaze_space"); } catch { /* ignore */ }
}

/** Gaze space + current window rect (physical px) — converts gaze-normalized
 * points to window-local CSS px and back once the window is a HUD capsule. */
export interface GazeMapping {
  gsx: number; gsy: number; gsw: number; gsh: number;
  wx: number; wy: number; scale: number;
}

export async function getGazeMapping(): Promise<GazeMapping | null> {
  if (!inTauri) return null;
  try { return (await invoke("gaze_mapping")) as GazeMapping; } catch { return null; }
}

/** Set the main window shape: "full" (setup/panels) or "hud" (compact tracking
 * HUD). Opaque, instant frame-set — no animated zoom. */
export async function setWindowMode(mode: "full" | "hud"): Promise<void> {
  if (!inTauri) return;
  try { await invoke("set_window_mode", { mode }); } catch { /* ignore */ }
}

/** Show an overlay window (wheel/keyboard) centered on a gaze point. */
export async function showOverlayAt(label: string, nx: number, ny: number): Promise<void> {
  if (!inTauri) return;
  try { await invoke("show_overlay_at", { label, nx, ny }); } catch { /* ignore */ }
}

/** Show an overlay window docked bottom-center of the gaze space. */
export async function showOverlayBottom(label: string): Promise<void> {
  if (!inTauri) return;
  try { await invoke("show_overlay_bottom", { label }); } catch { /* ignore */ }
}

/** Hide an overlay window. */
export async function hideOverlay(label: string): Promise<void> {
  if (!inTauri) return;
  try { await invoke("hide_overlay", { label }); } catch { /* ignore */ }
}

/** List connected displays by name (for the multi-monitor picker). */
export async function listMonitors(): Promise<string[]> {
  if (!inTauri) return [];
  try { return (await invoke("list_monitors")) as string[]; } catch { return []; }
}

/** Move the overlay to cover a chosen display (recalibrate after switching). */
export async function moveToMonitor(index: number): Promise<void> {
  if (!inTauri) return;
  try { await invoke("move_to_monitor", { index }); } catch { /* ignore */ }
}

/** The set of gaze actions the radial menu can dispatch. "drag" is stateful
 * (press → move → release) and handled by the app, not this one-shot dispatcher. */
export type GazeAction = "left" | "right" | "double" | "drag";

/** Dispatch a one-shot gaze action at a normalized point. "drag" is a no-op here
 * (the app arms a two-step drag gesture instead). */
export function dispatchAction(action: GazeAction, nx: number, ny: number): void {
  if (action === "right") nativeRightClick(nx, ny);
  else if (action === "double") nativeDoubleClick(nx, ny);
  else if (action === "drag") { /* handled by the app's drag gesture */ }
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
