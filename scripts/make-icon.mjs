// Generates the Gaze app icon as a 1024×1024 PNG, procedurally.
//
// Kept as code rather than a checked-in binary so the mark stays tweakable —
// change a constant below, re-run, and regenerate every size with:
//   node scripts/make-icon.mjs && npx tauri icon src-tauri/app-icon.png
//
// The mark: a rounded-square (Apple squircle) in an indigo→cyan gradient, with a
// white almond eye outline, a solid white iris, and the background knocked back
// out for the pupil. Three shapes total — it stays legible down to 16px.
//
// No dependencies: the PNG is encoded by hand with node:zlib.

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const SS = 4; // supersampling factor per axis (16 samples/px) for clean edges

// ── Design constants (all in 1024-space, relative to center) ─────────────────
const SQUIRCLE_HALF = 420; // half-width of the rounded square (≈92px margin)
const SQUIRCLE_N = 5; // superellipse exponent — 5 is close to Apple's squircle
const EYE_HALF_W = 300; // almond half-width
const EYE_HALF_H = 168; // almond half-height
const EYE_STROKE = 34; // almond outline thickness
const IRIS_R = 104; // white iris radius
const PUPIL_R = 42; // knocked-out pupil radius

// Gradient stops, sampled diagonally (top-left → bottom-right).
const C0 = [0x4c, 0x1d, 0x95]; // violet-900
const C1 = [0x06, 0xb6, 0xd4]; // cyan-500
const WHITE = [0xff, 0xff, 0xff];

const C = SIZE / 2;

// Almond = intersection of two equal circles offset vertically. Solve for the
// offset k and radius R that produce exactly EYE_HALF_W × EYE_HALF_H.
const K = (EYE_HALF_W * EYE_HALF_W - EYE_HALF_H * EYE_HALF_H) / (2 * EYE_HALF_H);
const R = K + EYE_HALF_H;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Background gradient colour at a point, sampled along the TL→BR diagonal. */
function bgAt(x, y) {
  const t = clamp01((x + y) / (2 * SIZE));
  return [lerp(C0[0], C1[0], t), lerp(C0[1], C1[1], t), lerp(C0[2], C1[2], t)];
}

/** Signed distance to the squircle edge (negative = inside). Approximated by
 * scaling the superellipse field, which is accurate enough at this resolution. */
function squircleSD(x, y) {
  const ax = Math.abs(x - C) / SQUIRCLE_HALF;
  const ay = Math.abs(y - C) / SQUIRCLE_HALF;
  const f = Math.pow(Math.pow(ax, SQUIRCLE_N) + Math.pow(ay, SQUIRCLE_N), 1 / SQUIRCLE_N);
  return (f - 1) * SQUIRCLE_HALF;
}

/** Signed distance to the almond (intersection of the two circles). */
function almondSD(x, y) {
  const dx = x - C;
  const dy = y - C;
  const dA = Math.hypot(dx, dy + K) - R; // circle centred below
  const dB = Math.hypot(dx, dy - K) - R; // circle centred above
  return Math.max(dA, dB);
}

const circleSD = (x, y, r) => Math.hypot(x - C, y - C) - r;

/** Colour + alpha for one sample point, composited front-to-back. */
function sample(x, y) {
  if (squircleSD(x, y) > 0) return null; // outside the icon → transparent

  // Pupil: the background gradient shows through the iris.
  if (circleSD(x, y, PUPIL_R) < 0) return bgAt(x, y);
  // Iris.
  if (circleSD(x, y, IRIS_R) < 0) return WHITE;
  // Almond outline.
  if (Math.abs(almondSD(x, y)) < EYE_STROKE / 2) return WHITE;
  return bgAt(x, y);
}

// ── Render with supersampling ────────────────────────────────────────────────
const px = Buffer.alloc(SIZE * SIZE * 4);
const step = 1 / SS;
const off = step / 2;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const s = sample(x + sx * step + off, y + sy * step + off);
        if (s) { r += s[0]; g += s[1]; b += s[2]; a += 255; }
      }
    }
    const n = SS * SS;
    const i = (y * SIZE + x) * 4;
    // Premultiply-free: average colour over COVERED samples only, so edge pixels
    // keep their true hue instead of darkening toward black.
    const cov = a / 255;
    px[i] = cov ? Math.round(r / cov) : 0;
    px[i + 1] = cov ? Math.round(g / cov) : 0;
    px[i + 2] = cov ? Math.round(b / cov) : 0;
    px[i + 3] = Math.round(a / n);
  }
}

// ── Encode PNG ───────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
// 10–12: deflate / adaptive filtering / no interlace — all zero.

// Prefix each scanline with filter byte 0 (None).
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "app-icon.png");
writeFileSync(out, png);
console.log(`[icon] wrote ${out} (${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(0)} KB)`);
