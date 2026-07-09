import { create } from "zustand";

export interface Settings {
  cameraPreview: boolean;
  controlSide: "left" | "right" | "center";
  pauseOnStartup: boolean;
  autoLaunchCalibration: boolean;
  set: (p: Partial<Omit<Settings, "set">>) => void;
}

export const useSettings = create<Settings>((set) => ({
  cameraPreview: true,
  controlSide: "center",
  pauseOnStartup: false,
  autoLaunchCalibration: true,
  set: (p) => set(p),
}));
