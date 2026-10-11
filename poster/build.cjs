const pptxgen = require("pptxgenjs");
const { applyTheme } = require("./apply_theme.cjs");
const A = "../analysis/";
const NAVY = "14213D", BLUE = "2A78D6", ORANGE = "EB6834", INK = "1B1B1B", MUTED = "52514E", TINT = "EEF3FA";
const HEAD = "Cambria", BODY = "Calibri";
const THEME = { name: "Gaze Poster", headFontFace: HEAD, bodyFontFace: BODY,
  colors: { dk1: INK, lt1: "FFFFFF", dk2: NAVY, lt2: TINT, accent1: BLUE, accent2: ORANGE, accent3: "1BAF7A", accent4: "EDA100", accent5: "E87BA4", accent6: "6250D6", hlink: BLUE, folHlink: MUTED } };

const pres = new pptxgen();
pres.defineLayout({ name: "POSTER", width: 36, height: 24 });
pres.layout = "POSTER";
pres.theme = { headFontFace: HEAD, bodyFontFace: BODY };
pres.title = "Gaze: Webcam Eye Tracking for Hands-Free Cursor Control";
const s = pres.addSlide();
s.background = { color: "FFFFFF" };

const X = [0.8, 12.4, 24.0], CW = 11.0, TOP = 5.0;
// header
s.addShape(pres.ShapeType.rect, { x: 0, y: 0, w: 36, h: 4.2, fill: { color: NAVY }, line: { color: NAVY }, objectName: "Header" });
s.addText("Gaze: Hands-Free Cursor Control from a Webcam", { x: 0.8, y: 0.45, w: 34.4, h: 1.6, fontFace: HEAD, fontSize: 60, bold: true, color: "FFFFFF", margin: 0, isTextBox: true, objectName: "Title" });
s.addText("Measuring the on-screen accuracy of a calibrated, webcam-only eye tracker (Linux, Wayland port)", { x: 0.8, y: 2.1, w: 34.4, h: 0.8, fontFace: BODY, fontSize: 30, color: "CADCFC", margin: 0, isTextBox: true, objectName: "Subtitle" });
s.addText("[Author name(s)]  ·  ASDRP  ·  Research poster, due Oct 11", { x: 0.8, y: 3.1, w: 34.4, h: 0.7, fontFace: BODY, fontSize: 26, color: "FFFFFF", margin: 0, isTextBox: true, objectName: "Authors" });

const H = (t, x, y) => s.addText(t, { x, y, w: CW, h: 0.75, fontFace: HEAD, fontSize: 36, bold: true, color: NAVY, margin: 0, isTextBox: true, objectName: "Heading " + t });
const P = (runs, x, y, h, opts = {}) => s.addText(runs, { x, y, w: CW, h, fontFace: BODY, fontSize: 22, color: INK, margin: 0, valign: "top", paraSpaceAfter: 8, isTextBox: true, ...opts });
const bullets = (items) => items.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i < items.length - 1 } }));
const fig = (file, x, y, w, ar, cap) => {
  s.addImage({ path: A + file, x, y, w, h: w / ar, altText: cap });
  s.addText(cap, { x, y: y + w / ar + 0.08, w, h: 0.7, fontFace: BODY, fontSize: 16, italic: true, color: MUTED, margin: 0, valign: "top", isTextBox: true });
  return y + w / ar + 0.85;
};

// ---- column 1 ----
let y = TOP;
H("Abstract", X[0], y); y += 0.95;
P("Eye tracking can give people with limited motor control a way to use a computer without their hands, but most systems need dedicated infrared hardware. Gaze estimates where a user is looking from an ordinary webcam, calibrates that signal to the screen, and drives the real system cursor. We built a Linux (Wayland) port and an accuracy test that logs each target's predicted position. Across 7 valid runs (83 targets) the mean error was 164 px (median 124 px) on a 1920×1080 display, and 70% of targets landed within 200 px.", X[0], y, 5.5, { fontSize: 25 }); y += 5.9;
H("Motivation", X[0], y); y += 0.95;
P("Commercial gaze trackers are costly and tied to specific hardware. A webcam-only tool that runs locally keeps video on the device and works on the laptop a person already owns. The open question is whether its accuracy is good enough to hit real interface targets.", X[0], y, 3.0, { fontSize: 25 }); y += 3.5;
H("Methods", X[0], y); y += 0.95;
P(bullets([
  "Face and iris landmarks from MediaPipe FaceLandmarker (Lugaresi et al., 2019), with head pose.",
  "One-Euro smoothing of the gaze signal.",
  "Calibration: a 5×5 grid, a dwell window per point, then smooth-pursuit passes. A ridge regression maps eye features to screen position.",
  "Accuracy test: 12 shuffled targets per pass, 600 ms settling time per target, mean predicted position logged against the target.",
  "Cursor control: macOS CoreGraphics, Linux X11 XTest, and Wayland RemoteDesktop portal (libei).",
]), X[0], y, 7.6, { fontSize: 24, paraSpaceAfter: 10 });

// ---- column 2 ----
y = TOP;
H("Results", X[1], y); y += 0.95;
y = fig("fig1_spatial_error_map.png", X[1] + 0.5, y, 10.0, 1726 / 1177, "Figure 1. Predicted gaze position for each target (+), all valid runs. Lines join each prediction to its target.");
const stats = [["164 px", "mean error"], ["124 px", "median error"], ["70%", "within 200 px"]];
stats.forEach(([v, l], i) => {
  const cx = X[1] + i * 3.8;
  s.addShape(pres.ShapeType.roundRect, { x: cx, y, w: 3.4, h: 1.75, fill: { color: TINT }, line: { color: TINT }, rectRadius: 0.15, objectName: "Stat card " + l });
  s.addText(v, { x: cx, y: y + 0.15, w: 3.4, h: 0.9, align: "center", fontFace: HEAD, fontSize: 40, bold: true, color: BLUE, margin: 0, isTextBox: true });
  s.addText(l, { x: cx, y: y + 1.1, w: 3.4, h: 0.5, align: "center", fontFace: BODY, fontSize: 20, color: MUTED, margin: 0, isTextBox: true });
});
y += 2.05;
y = fig("fig3_error_cdf.png", X[1] + 2.1, y, 6.8, 1260 / 972, "Figure 2. Cumulative distribution of error. Dashed lines mark 100 px and 200 px.");
P([{ text: "n = 83 targets, 7 runs. ", options: { bold: true } }, { text: "Two runs were excluded: one aborted after 2 points, one never held calibration (predictions stayed near x = 0.43)." }], X[1], y + 0.05, 1.2, { fontSize: 18, color: MUTED });

// ---- column 3 ----
y = TOP;
H("Where the error is", X[2], y); y += 0.95;
y = fig("fig5_regional_error.png", X[2] + 1.7, y, 7.6, 1394 / 873, "Figure 3. Mean error (px) by screen region. The left column is worst.");
y = fig("fig2_per_run_distribution.png", X[2] + 0.7, y + 0.05, 9.6, 1722 / 926, "Figure 4. Per-run error. Orange: earlier build; blue: Linux build. Run-to-run spread is large.");
H("Discussion and limitations", X[2], y + 0.05); y += 1.0;
P(bullets([
  "Error was 100–250 px across most of the screen: enough for large controls, not small ones.",
  "The earlier and Linux builds do not differ beyond run-to-run spread (mean 143 vs 180 px).",
  "Left-edge targets averaged 211–246 px; centre columns 98–136 px.",
  "Few runs, one participant, one display: results are descriptive. Viewing distance was not recorded, so no visual angle.",
]), X[2], y, 4.3, { fontSize: 20, paraSpaceAfter: 6 });

s.addText("Reference: Lugaresi, C. et al. (2019). MediaPipe: A Framework for Building Perception Pipelines. arXiv:1906.08172.  Code and data: the Gaze repository (analysis/).", { x: 0.8, y: 23.2, w: 34.4, h: 0.5, fontFace: BODY, fontSize: 14, color: MUTED, margin: 0, isTextBox: true });

(async () => { await pres.writeFile({ fileName: "gaze_poster.pptx" }); await applyTheme("gaze_poster.pptx", THEME); console.log("ok"); })();
