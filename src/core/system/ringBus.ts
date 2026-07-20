// Cross-window bus for the follower cursor-ring window. The main window emits
// ring STATE (not per-frame progress): the ring animates its own fill locally
// from `start`/`durationMs`, so its motion is decoupled from event cadence.
// `start` is a Date.now() epoch — comparable across windows, unlike
// performance.now() which has a per-window origin.

import { emit } from "@tauri-apps/api/event";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface RingState {
  /** hidden: no gaze / disarmed. active: tracking, no dwell. dwell: filling. */
  mode: "hidden" | "active" | "dwell";
  /** Dwell epoch start (Date.now()) and duration — ring animates locally. */
  start?: number;
  durationMs?: number;
  /** Ring color (confidence / drag / precision tint). */
  color: string;
}

let last = "";

/** Emit ring state, deduped — only actual changes cross the window boundary. */
export function sendRingState(s: RingState): void {
  if (!inTauri) return;
  const key = `${s.mode}|${s.color}|${s.start ?? 0}|${s.durationMs ?? 0}`;
  if (key === last) return;
  last = key;
  void emit("ring:state", s).catch(() => {});
}

/** Brief success flash on the ring (click fired). */
export function sendRingFlash(): void {
  if (!inTauri) return;
  void emit("ring:flash", {}).catch(() => {});
}
