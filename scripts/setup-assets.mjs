// Vendors the MediaPipe assets into `public/mediapipe` so the app runs offline.
// - wasm: copied from the installed @mediapipe/tasks-vision package (no network)
// - model: downloaded once from Google's model host
// Idempotent: skips anything already present. Never fails the build — if the
// model can't be fetched (offline), the engine falls back to the CDN at runtime.

import { existsSync, mkdirSync, copyFileSync, readdirSync, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmSrc = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const outWasm = join(root, "public", "mediapipe", "wasm");
const outModel = join(root, "public", "mediapipe", "face_landmarker.task");
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
// Pose model for the diagnostics skeleton view. Vendored too, so the shipped app
// makes NO network requests at runtime — see MediaPipeGazeEngine.init().
const outPose = join(root, "public", "mediapipe", "pose_landmarker.task");
const POSE_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

function copyWasm() {
  if (!existsSync(wasmSrc)) {
    console.warn("[assets] @mediapipe/tasks-vision wasm not found — run npm install first");
    return;
  }
  mkdirSync(outWasm, { recursive: true });
  for (const f of readdirSync(wasmSrc)) copyFileSync(join(wasmSrc, f), join(outWasm, f));
  console.log("[assets] wasm vendored");
}

async function fetchOne(url, out, label) {
  if (existsSync(out)) return;
  mkdirSync(dirname(out), { recursive: true });
  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await new Promise((resolve, reject) => {
      const ws = createWriteStream(out);
      Readable.fromWeb(res.body).pipe(ws).on("finish", resolve).on("error", reject);
    });
    console.log(`[assets] ${label} downloaded`);
  } catch (err) {
    // Hard failure: the app no longer has a CDN fallback (that path was a remote
    // code-execution surface), so a missing asset means a broken build.
    console.error(`[assets] FAILED to fetch ${label}: ${err.message}`);
    process.exitCode = 1;
  }
}

copyWasm();
await fetchOne(MODEL_URL, outModel, "face model");
await fetchOne(POSE_URL, outPose, "pose model");
