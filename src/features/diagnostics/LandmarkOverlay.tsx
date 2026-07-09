import { useEffect, useRef } from "react";
import {
  FilesetResolver, PoseLandmarker, FaceLandmarker, DrawingUtils,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import type { IGazeEngine } from "@/core/engine/IGazeEngine";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const POSE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

const FACE = "rgba(125,200,255,0.85)";
const MESH = "rgba(125,200,255,0.22)";
const IRIS = "#ffffff";
const BODY = "rgba(74,222,128,0.95)";

/** Live skeleton view: draws the mirrored camera frame with face mesh + iris
 * (reused from the gaze engine) and body pose (shoulders, arms, torso, derived
 * neck) from a PoseLandmarker. Self-contained — it draws the video itself so
 * landmarks always align, regardless of how the page lays the panel out. */
export function LandmarkOverlay({
  engine, video, width = 300,
}: { engine: IGazeEngine; video: HTMLVideoElement; width?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 16:9 to match the requested 1280x720 capture; full-stretch draw keeps the
  // engine's normalized landmarks perfectly aligned with the drawn frame.
  const height = Math.round((width * 9) / 16);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const drawer = new DrawingUtils(ctx);

    let pose: PoseLandmarker | null = null;
    let raf = 0;
    let disposed = false;
    let lastTs = -1;

    const drawFace = () => {
      const face = engine.getLandmarks?.();
      if (!face) return;
      const lm = face as unknown as NormalizedLandmark[];
      drawer.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_TESSELATION, { color: MESH, lineWidth: 0.5 });
      drawer.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, { color: FACE, lineWidth: 1.5 });
      drawer.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, { color: FACE, lineWidth: 1.5 });
      drawer.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE, { color: FACE, lineWidth: 1.5 });
      drawer.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS, { color: IRIS, lineWidth: 2 });
      drawer.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS, { color: IRIS, lineWidth: 2 });
    };

    const drawBody = (lms: NormalizedLandmark[], w: number, h: number) => {
      drawer.drawConnectors(lms, PoseLandmarker.POSE_CONNECTIONS, { color: BODY, lineWidth: 2 });
      drawer.drawLandmarks(lms, { color: "#bbf7d0", fillColor: BODY, radius: 2.5, lineWidth: 1 });
      // Derived neck: shoulder midpoint up to the nose, which PoseLandmarker
      // doesn't connect on its own.
      const ls = lms[11], rs = lms[12], nose = lms[0];
      if (ls && rs && nose) {
        const mx = ((ls.x + rs.x) / 2) * w, my = ((ls.y + rs.y) / 2) * h;
        ctx.beginPath();
        ctx.moveTo(mx, my);
        ctx.lineTo(nose.x * w, nose.y * h);
        ctx.strokeStyle = BODY; ctx.lineWidth = 2; ctx.stroke();
      }
    };

    (async () => {
      try {
        const fileset = await FilesetResolver.forVisionTasks(WASM);
        if (disposed) return;
        pose = await PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: POSE_MODEL, delegate: "GPU" },
          runningMode: "VIDEO", numPoses: 1,
        });
      } catch (err) {
        console.warn("[gaze] pose model failed to load; showing face only:", err);
      }

      const loop = () => {
        if (disposed) return;
        raf = requestAnimationFrame(loop);
        const w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        if (video.readyState < 2) return;

        ctx.save();
        ctx.translate(w, 0); ctx.scale(-1, 1); // mirror, selfie-style
        ctx.drawImage(video, 0, 0, w, h);
        ctx.filter = "none";
        drawFace();
        const ts = performance.now();
        if (pose && ts > lastTs) {
          lastTs = ts;
          try {
            const res = pose.detectForVideo(video, ts);
            const body = res.landmarks?.[0];
            if (body) drawBody(body, w, h);
          } catch { /* pose can throw on the first few frames */ }
        }
        ctx.restore();
      };
      loop();
    })();

    return () => { disposed = true; cancelAnimationFrame(raf); pose?.close(); };
  }, [engine, video]);

  return (
    <canvas ref={canvasRef} width={width} height={height}
      style={{ position: "absolute", bottom: "var(--s-5)", left: "var(--s-5)",
        width, height, borderRadius: "var(--radius-md)", zIndex: 6, pointerEvents: "none",
        boxShadow: "var(--shadow-soft)", border: "1px solid var(--stroke)",
        background: "#000" }} />
  );
}
