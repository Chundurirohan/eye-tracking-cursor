// Bridge to the native input layer (macOS CoreGraphics / Linux XTest + portal) (see src-tauri/src/lib.rs). Lets the
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

/** What the native layer can do on this OS/session (mirrors `Capabilities` in Rust). */
export interface PlatformCaps {
  os: "macos" | "linux" | "other" | "web";
  session: string;
  input_backend: string;
  input: boolean;
  magnet: boolean;
  zoom: boolean;
  text_focus: boolean;
}

const WEB_CAPS: PlatformCaps = { os: "web", session: "none", input_backend: "none", input: false, magnet: false, zoom: false, text_focus: false };

/** Platform capabilities, so the UI can hide controls that cannot work here. */
export async function platformInfo(): Promise<PlatformCaps> {
  if (!inTauri) return WEB_CAPS;
  try { return (await invoke("platform_info")) as PlatformCaps; } catch { return WEB_CAPS; }
}

/** Start the platform's input-permission flow (macOS Accessibility prompt; on
 * Linux/Wayland, the RemoteDesktop portal consent). Resolves to the new state. */
export async function requestAccess(): Promise<boolean> {
  if (!inTauri) return false;
  try { return (await invoke("request_accessibility")) as boolean; } catch { return false; }
}

/** Whether the app currently has effective permission to inject input (macOS
 * Accessibility; on Linux, a ready input backend). Synthetic clicks silently
 * no-op when this is false. */
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
 * second; the caller hit-tests it locally every frame for instant magnetism.
 *
 * `nx`/`ny` must be the RAW gaze point, NOT the snapped reticle — it re-aims the
 * background scanner. Passing the snapped point makes the magnet feed on its own
 * output and the reticle judders between unrelated targets. */
export async function nativeTargets(
  nx: number, ny: number,
): Promise<[number, number, number, number, number][]> {
  if (!inTauri) return [];
  try {
    return (await invoke("nearby_targets", { nx, ny })) as
      [number, number, number, number, number][];
  } catch {
    return [];
  }
}

/** Display the app is on: `[widthPt, heightPt, scale, monitorCount, isExternal]`.
 * Used to size gaze UI to the actual device — a 13" laptop panel and a 27"
 * external differ enormously in both point size and viewing distance. */
export async function screenInfo(): Promise<
  [number, number, number, number, boolean] | null
> {
  if (!inTauri) return null;
  try {
    return (await invoke("screen_info")) as [number, number, number, number, boolean];
  } catch {
    return null;
  }
}

/** Toggle the macOS built-in Zoom magnifier on/off (⌥⌘8). The magnifier follows
 * the system pointer, which the app drives to the gaze reticle. Requires "Use
 * keyboard shortcuts to zoom" enabled in System Settings › Accessibility › Zoom. */
export function zoomToggle(): void {
  if (!inTauri) return;
  void invoke("zoom_toggle").catch(() => {});
}

/** Zoom the macOS magnifier in one step (⌥⌘=). */
export function zoomIn(): void {
  if (!inTauri) return;
  void invoke("zoom_in").catch(() => {});
}

/** Zoom the macOS magnifier out one step (⌥⌘-). */
export function zoomOut(): void {
  if (!inTauri) return;
  void invoke("zoom_out").catch(() => {});
}

/** Type a Unicode string into the focused app (on-screen keyboard). */
export function typeText(text: string): void {
  if (!inTauri) return;
  void invoke("type_text", { text }).catch(() => {});
}

/** Print a diagnostic line to the app's stdout (release builds have no console). */
export function devLog(line: string): void {
  if (!inTauri) return;
  void invoke("dev_log", { line }).catch(() => {});
}

export type TapKey = "backspace" | "return" | "space";

/** Tap a named key; the native layer maps it to the platform's keycode. */
export function keyTap(key: TapKey): void {
  if (!inTauri) return;
  void invoke("key_tap", { key }).catch(() => {});
}
