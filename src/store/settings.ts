import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// How the user triggers a "click" once their gaze is on a target.
//  - dwell:  rest the gaze until the ring fills (default, no extra hardware)
//  - blink:  a deliberate long blink / wink fires the click
//  - switch: an external key / switch (⌃⌥Return global shortcut) fires the click
export type ActivationMode = "dwell" | "blink" | "switch";

// What a dwell over EMPTY space (no clickable under the gaze) does.
//  - click: immediately left-click there (fast, the common case)
//  - menu:  open the radial action wheel (choose left / right / double / drag)
export type EmptyDwellAction = "click" | "menu";

// A dwell-speed preset maps to concrete millisecond values; "custom" leaves the
// numeric fields under direct user control.
export type DwellPreset = "relaxed" | "normal" | "fast" | "custom";

export interface SettingsData {
  // --- Display / layout ---
  cameraPreview: boolean;
  controlSide: "left" | "right" | "center";

  // --- Startup ---
  pauseOnStartup: boolean;
  autoLaunchCalibration: boolean;

  // --- Activation / dwell timing ---
  activationMode: ActivationMode;
  dwellPreset: DwellPreset;
  dwellMs: number;          // hold time over a control to click (ms)
  freeDwellMs: number;      // longer, deliberate hold over empty space (ms)
  cooldownMs: number;       // minimum gap between clicks (ms)
  emptyDwellAction: EmptyDwellAction;
  stabilityTolerance: number; // multiplier on jitter tolerance (0.5 strict → 2 loose)
  snapStrength: number;       // 0 (off) → 1 (strong) magnetic snapping

  // --- Scrolling ---
  edgeScroll: boolean;
  scrollSpeed: number;      // multiplier on the base scroll step

  // --- Feedback ---
  soundOnClick: boolean;
  soundVolume: number;      // 0 → 1

  // --- Idle / power ---
  idleAutoPause: boolean;
  idleTimeoutS: number;     // seconds with no face before auto-pausing

  // --- Onboarding ---
  hasSeenTutorial: boolean;
}

export interface Settings extends SettingsData {
  set: (p: Partial<SettingsData>) => void;
  reset: () => void;
}

// Dwell-speed presets. "custom" is intentionally absent — selecting it just
// stops the preset from overwriting the user's manual numbers.
export const DWELL_PRESETS: Record<Exclude<DwellPreset, "custom">, { dwellMs: number; freeDwellMs: number }> = {
  relaxed: { dwellMs: 1100, freeDwellMs: 1900 },
  normal: { dwellMs: 800, freeDwellMs: 1500 },
  fast: { dwellMs: 550, freeDwellMs: 1050 },
};

export const DEFAULTS: SettingsData = {
  cameraPreview: true,
  controlSide: "center",
  pauseOnStartup: false,
  autoLaunchCalibration: true,

  activationMode: "dwell",
  dwellPreset: "normal",
  dwellMs: 800,
  freeDwellMs: 1500,
  cooldownMs: 600,
  emptyDwellAction: "menu",
  stabilityTolerance: 1,
  snapStrength: 1,

  edgeScroll: true,
  scrollSpeed: 1,

  soundOnClick: true,
  soundVolume: 0.5,

  idleAutoPause: true,
  idleTimeoutS: 45,

  hasSeenTutorial: false,
};

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      set: (p) => set(p),
      reset: () => set({ ...DEFAULTS }),
    }),
    {
      name: "gaze.settings",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // Never persist the action methods.
      partialize: (s) =>
        Object.fromEntries(
          Object.entries(s).filter(([k]) => k !== "set" && k !== "reset"),
        ) as SettingsData,
      // Shallow-merge over DEFAULTS so a settings file written by an older build
      // (missing new keys) is forward-compatible instead of leaving holes.
      merge: (persisted, current) => ({
        ...current,
        ...DEFAULTS,
        ...(persisted as Partial<SettingsData>),
      }),
    },
  ),
);

/** Resolve the effective dwell numbers, honoring a preset unless it's "custom". */
export function resolveDwell(s: SettingsData): { dwellMs: number; freeDwellMs: number } {
  if (s.dwellPreset === "custom") return { dwellMs: s.dwellMs, freeDwellMs: s.freeDwellMs };
  return DWELL_PRESETS[s.dwellPreset];
}
