# Gaze

Native macOS webcam **eye-tracking** app. It estimates where you're looking,
calibrates that to your screen, and drives the real OS cursor by gaze — clicking
by dwell, with an on-screen keyboard, a radial action wheel, and magnetic
snapping onto buttons/links/fields in any app. All vision runs **on-device**;
video never leaves your computer.

> **This is a Tauri (JavaScript + Rust) app, not a Python app.** Dependencies are
> declared in `package.json` (JS) and `src-tauri/Cargo.toml` (Rust). There is no
> `requirements.txt`/`pip` step.

## Prerequisites

- **macOS** (Apple Silicon or Intel). The app uses macOS Accessibility + Core
  Graphics, so it does not run on Windows/Linux.
- **Node.js 18+** (includes `npm`) — https://nodejs.org
- **Rust toolchain** (`rustc` + `cargo`) — https://rustup.rs
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  ```
- **Xcode Command Line Tools** (for the native build):
  ```bash
  xcode-select --install
  ```

## Install

```bash
git clone https://github.com/Chundurirohan/Tracker-app.git
cd Tracker-app
npm install
```

`npm install` pulls in both the JS dependencies and the Tauri CLI. MediaPipe
vision assets are vendored automatically on first run (`npm run setup:assets`).

## Run (development)

```bash
npm run tauri dev
```

This launches the full desktop app. On first launch macOS will prompt for:

- **Camera** — to see your eyes (used only locally).
- **Accessibility** — required to move the cursor and click into other apps.
  Grant it in **System Settings › Privacy & Security › Accessibility**, then
  relaunch. Without it the reticle moves but clicks are ignored.

To run just the frontend in a browser (camera + tracking work, no native cursor
control):

```bash
npm run dev        # http://localhost:1420
```

## Build a distributable app / DMG

```bash
npm run tauri build
```

Produces `Gaze.app` and `Gaze_<version>_<arch>.dmg` under
`src-tauri/target/release/bundle/`.

For a **signed + notarized** DMG that opens without Gatekeeper warnings on other
Macs, use the helper (requires an Apple Developer ID certificate + credentials —
see the script header):

```bash
./scripts/release-macos.sh
```

## Tests

```bash
npm test
```

## Project layout

- `src/` — React + TypeScript frontend (vision engine, calibration, tracking UI).
- `src-tauri/` — Rust/Tauri desktop shell (cursor control, clicks, Accessibility
  magnet, on-screen keyboard input).
- `scripts/` — asset setup + macOS release/notarization.
- `specs/` — design specs.

See `CLAUDE.md` for a deeper architecture guide.
