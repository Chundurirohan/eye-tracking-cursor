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

function copyWasm() {
  if (!existsSync(wasmSrc)) {
    console.warn("[assets] @mediapipe/tasks-vision wasm not found — run npm install first");
    return;
  }
  mkdirSync(outWasm, { recursive: true });
  for (const f of readdirSync(wasmSrc)) copyFileSync(join(wasmSrc, f), join(outWasm, f));
  console.log("[assets] wasm vendored");
}

async function fetchModel() {
  if (existsSync(outModel)) return;
  mkdirSync(dirname(outModel), { recursive: true });
  try {
    const res = await fetch(MODEL_URL);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await new Promise((resolve, reject) => {
      const out = createWriteStream(outModel);
      Readable.fromWeb(res.body).pipe(out).on("finish", resolve).on("error", reject);
    });
    console.log("[assets] model downloaded");
  } catch (err) {
    console.warn(`[assets] model download failed (${err.message}); runtime will use the CDN fallback`);
  }
}

copyWasm();
await fetchModel();
