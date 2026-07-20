import { invoke } from "@tauri-apps/api/core";
import type { CalibrationModel } from "../calibration/types";

export type SavedCalibration = (CalibrationModel & { quality: number; savedAt: number }) | null;

/** A named calibration profile (e.g. "Glasses" vs "No glasses", or per person). */
export interface Profile {
  name: string;
  calibration: SavedCalibration;
}

export interface PersistedSession {
  version: 1;
  permissionGranted: boolean;
  pauseOnStartup: boolean;
  /** The ACTIVE profile's calibration — kept top-level so the resume logic
   * (machine.ts) works unchanged. Mirrors `profiles[activeProfile]`. */
  calibration: SavedCalibration;
  /** Named profiles. Absent on sessions saved before profiles existed. */
  profiles?: Profile[];
  activeProfile?: string;
}

const DEFAULT: PersistedSession = {
  version: 1, permissionGranted: false, pauseOnStartup: false, calibration: null,
};

export const persistence = {
  async load(): Promise<PersistedSession> {
    try {
      const raw = await invoke<string | null>("load_session");
      if (!raw) return { ...DEFAULT };
      const parsed = JSON.parse(raw) as PersistedSession;
      return parsed.version === 1 ? parsed : { ...DEFAULT };
    } catch {
      try {
        const ls = localStorage.getItem("gaze.session");
        return ls ? (JSON.parse(ls) as PersistedSession) : { ...DEFAULT };
      } catch { return { ...DEFAULT }; }
    }
  },
  async save(s: PersistedSession): Promise<void> {
    const json = JSON.stringify(s);
    try { await invoke("save_session", { json }); }
    catch { try { localStorage.setItem("gaze.session", json); } catch {} }
  },
  async clear(): Promise<void> {
    try { await invoke("clear_session"); }
    catch { try { localStorage.removeItem("gaze.session"); } catch {} }
  },
};
