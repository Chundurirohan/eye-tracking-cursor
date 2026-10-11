#!/usr/bin/env bash
# Build the Linux release artifacts: .deb, .rpm, .AppImage and a self-hosted
# .flatpak bundle (repackaged from the .deb).
#
#   ./scripts/release-linux.sh            # everything
#   SKIP_FLATPAK=1 ./scripts/release-linux.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

APP_ID=com.rohanchunduri.eyeapp
OUT=dist-linux
rm -rf "$OUT" && mkdir -p "$OUT"

npm ci
npm run tauri build

BUNDLE=src-tauri/target/release/bundle
cp "$BUNDLE"/deb/*.deb "$OUT"/ 2>/dev/null || true
cp "$BUNDLE"/rpm/*.rpm "$OUT"/ 2>/dev/null || true
cp "$BUNDLE"/appimage/*.AppImage "$OUT"/ 2>/dev/null || true

if [ -z "${SKIP_FLATPAK:-}" ]; then
  FP=packaging/flatpak
  cp "$BUNDLE"/deb/*.deb "$FP/gaze.deb"
  flatpak-builder --force-clean --user --install-deps-from=flathub \
    --repo="$OUT/repo" "$OUT/build" "$FP/$APP_ID.yml"
  flatpak build-bundle "$OUT/repo" "$OUT/gaze.flatpak" "$APP_ID"
  rm -f "$FP/gaze.deb"
fi

ls -lh "$OUT"
