type Listener = (ev: "interrupted" | "restored" | "error") => void;

/** Turn a getUserMedia failure into an actionable, human-readable reason. */
export function describeCameraError(err: unknown): string {
  if (!navigator.mediaDevices?.getUserMedia) {
    return "Camera API unavailable in this context (the webview did not expose getUserMedia).";
  }
  const name = err instanceof DOMException ? err.name : (err as { name?: string })?.name;
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera permission denied. Enable it in System Settings → Privacy & Security → Camera, then retry.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No camera found. Connect a webcam and retry.";
    case "NotReadableError":
    case "TrackStartError":
      return "Camera is in use by another app. Close it (Zoom, FaceTime, Photo Booth…) and retry.";
    case "OverconstrainedError":
      return "Requested camera settings aren't supported by this device.";
    default:
      return err instanceof Error ? `Camera error: ${err.message}` : "Camera unavailable or permission denied.";
  }
}

/** Pick a built-in webcam over a Continuity (iPhone/iPad) camera, which can be
 * selected by default on macOS but only yields black frames when idle. Returns
 * the chosen deviceId, or null to keep whatever getUserMedia already picked. */
async function pickPreferredCamera(): Promise<string | null> {
  try {
    const cams = (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === "videoinput");
    if (cams.length <= 1) return null;
    const isContinuity = (l: string) => /iphone|ipad|continuity/i.test(l);
    const builtin = cams.find((d) => /facetime|built-?in/i.test(d.label));
    const nonContinuity = cams.find((d) => !isContinuity(d.label));
    return (builtin ?? nonContinuity ?? cams[0]).deviceId || null;
  } catch {
    return null;
  }
}

export class CameraManager {
  private stream: MediaStream | null = null;
  private listeners = new Set<Listener>();
  readonly video: HTMLVideoElement;

  constructor() {
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
  }

  on(fn: Listener) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(e: Parameters<Listener>[0]) { this.listeners.forEach((l) => l(e)); }

  async requestPermissionAndStart(): Promise<void> {
    // Initial request also unlocks device labels for enumerateDevices().
    let stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      audio: false,
    });

    // On macOS, getUserMedia often defaults to the iPhone Continuity Camera,
    // which delivers black frames (no error) when the phone isn't actively
    // streaming. Prefer a real built-in webcam if one is available.
    const preferred = await pickPreferredCamera();
    const current = stream.getVideoTracks()[0]?.getSettings().deviceId;
    if (preferred && preferred !== current) {
      stream.getTracks().forEach((t) => t.stop());
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, deviceId: { exact: preferred } },
        audio: false,
      });
    }
    this.attach(stream);
  }

  private attach(stream: MediaStream) {
    this.stream = stream;
    this.video.srcObject = stream;
    const track = stream.getVideoTracks()[0];
    track?.addEventListener("ended", () => this.emit("interrupted"));
    track?.addEventListener("mute", () => this.emit("interrupted"));
    track?.addEventListener("unmute", () => this.emit("restored"));
    void this.video.play().catch(() => this.emit("error"));
  }

  async restart(): Promise<boolean> {
    try { this.stop(); await this.requestPermissionAndStart(); this.emit("restored"); return true; }
    catch { this.emit("error"); return false; }
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}
