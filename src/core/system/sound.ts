// Lightweight click feedback tone via WebAudio. No assets, no network. A single
// shared AudioContext, created lazily on first use. All calls are safe no-ops if
// audio is unavailable.

let ctx: AudioContext | null = null;

function ac(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/** A short shaped beep. `volume` is 0–1 of an already-conservative ceiling. */
function beep(freq: number, ms: number, volume: number): void {
  const a = ac();
  if (!a) return;
  const vol = Math.max(0, Math.min(1, volume)) * 0.18; // keep it gentle
  if (vol <= 0) return;
  const t0 = a.currentTime;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
  osc.connect(gain).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + ms / 1000 + 0.02);
}

/** Confirmation tone for a completed click. */
export function playClick(volume = 0.5): void {
  beep(880, 70, volume);
}
