#!/usr/bin/env node
// Convert Gaze pixel-error logs (key=value lines) to CSV, next to each source file.
//   node scripts/logs-to-csv.mjs [dir ...]
// Default dirs: ./public and the app's native log dir (~/.local/share/<id>/logs).
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const dirs = process.argv.slice(2);
if (!dirs.length) dirs.push("public", path.join(homedir(), ".local/share/com.rohanchunduri.eyeapp/logs"));

const pair = (v) => (v?.match(/^\(([-\d.]+),([-\d.]+)\)$/) ?? []).slice(1);
const num = (v) => (v == null ? "" : String(parseFloat(v)).replace("NaN", ""));

function parse(text) {
  const rows = []; let kind = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const kv = Object.fromEntries([...line.matchAll(/(\w+)=(\([^)]*\)|\S+)/g)].map((m) => [m[1], m[2]]));
    const k = "target" in kv ? "test" : "dwell";
    kind ??= k;
    if (k === "test") {
      const [tx, ty] = pair(kv.target), [px, py] = pair(kv.predicted);
      rows.push([tx, ty, px, py, num(kv.error), num(kv.samples), num(kv.round), num(kv.t)]);
    } else {
      const [px, py] = pair(kv.predicted), [ax, ay] = pair(kv.actual);
      rows.push([px, py, ax ?? "", ay ?? "", num(kv.distance)]);
    }
  }
  const header = kind === "test"
    ? ["target_x", "target_y", "predicted_x", "predicted_y", "error_norm", "samples", "round", "elapsed_s"]
    : ["predicted_x_px", "predicted_y_px", "actual_x_px", "actual_y_px", "distance_px"];
  return rows.length ? [header, ...rows].map((r) => r.join(",")).join("\n") + "\n" : null;
}

let n = 0;
for (const d of dirs) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d).filter((f) => f.endsWith(".log"))) {
    const csv = parse(readFileSync(path.join(d, f), "utf8"));
    if (!csv) { console.log(`skip (empty): ${path.join(d, f)}`); continue; }
    const out = path.join(d, f.replace(/\.log$/, ".csv"));
    writeFileSync(out, csv); n++; console.log(`wrote ${out}`);
  }
}
console.log(`${n} file(s) converted`);
