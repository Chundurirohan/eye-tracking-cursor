// Cross-window channel between the main (engine) window and the overlay windows
// (wheel, keyboard). The main window owns the gaze estimate; overlay windows run
// their own local dwell on gaze points it broadcasts here, and report results
// back. Everything is small JSON over Tauri events.

import { emit } from "@tauri-apps/api/event";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Global gaze point in logical screen px (top-left origin). */
export interface GazeGlobal { gx: number; gy: number }

/** Broadcast the current gaze in global logical px. Main emits this only while
 * an overlay window that needs it is open, so it costs nothing otherwise. */
export function sendGazeGlobal(gx: number, gy: number): void {
  if (!inTauri) return;
  void emit("gaze:global", { gx, gy } satisfies GazeGlobal).catch(() => {});
}

/** A wheel petal was chosen (emitted by the wheel window → handled by main). */
export function sendWheelSelect(action: "left" | "right" | "double" | "drag" | "cancel"): void {
  if (!inTauri) return;
  void emit("wheel:select", action).catch(() => {});
}

/** The keyboard window asks main to close it (its ✕ / auto-hide). */
export function sendKeyboardClose(): void {
  if (!inTauri) return;
  void emit("keyboard:close", {}).catch(() => {});
}
