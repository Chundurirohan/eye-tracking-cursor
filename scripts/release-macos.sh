#!/usr/bin/env bash
#
# Build, sign (Developer ID + Hardened Runtime), and notarize Gaze for direct
# distribution (a notarized .dmg you hand to testers — the TestFlight equivalent
# for an app that can't be sandboxed).
#
# Prerequisites (you provide these — they are account/machine specific and must
# NOT be committed):
#   1. Apple Developer Program membership.
#   2. A "Developer ID Application" certificate installed in your login keychain
#      (verify with: security find-identity -v -p codesigning).
#
# Credentials are read from the environment so nothing secret lives in the repo.
# Tauri v2 signs AND notarizes automatically when these are set:
#
#   export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
#
#   # Notarize with an app-specific password (appleid.apple.com > Sign-In & Security):
#   export APPLE_ID="you@example.com"
#   export APPLE_PASSWORD="abcd-efgh-ijkl-mnop"   # app-specific password, NOT your Apple ID password
#   export APPLE_TEAM_ID="TEAMID"
#
#   # ...OR notarize with an App Store Connect API key instead:
#   # export APPLE_API_ISSUER="....";  export APPLE_API_KEY="KEYID"
#   # export APPLE_API_KEY_PATH="/path/to/AuthKey_KEYID.p8"
#
# Then:  ./scripts/release-macos.sh
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "error: $*" >&2; exit 1; }

# --- preflight -------------------------------------------------------------
[[ -n "${APPLE_SIGNING_IDENTITY:-}" ]] || fail "APPLE_SIGNING_IDENTITY is not set (see header)."

if ! security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
  fail "No 'Developer ID Application' identity found in the keychain. Install your cert first."
fi

have_pw=0; have_key=0
[[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]] && have_pw=1
[[ -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_KEY_PATH:-}" ]] && have_key=1
if [[ $have_pw -eq 0 && $have_key -eq 0 ]]; then
  fail "No notarization credentials. Set APPLE_ID+APPLE_PASSWORD+APPLE_TEAM_ID, or the APPLE_API_* trio."
fi

echo "==> Signing identity: $APPLE_SIGNING_IDENTITY"
echo "==> Notarizing via: $([[ $have_pw -eq 1 ]] && echo 'app-specific password' || echo 'App Store Connect API key')"

# --- build + sign + notarize + staple (all handled by Tauri) --------------
# Tauri reads the APPLE_* env vars, code-signs the .app with Hardened Runtime and
# the entitlements from tauri.conf.json, submits the .dmg to Apple's notary
# service, waits, and staples the ticket on success.
npm run tauri build

echo
echo "==> Done. Artifacts:"
find src-tauri/target/release/bundle -name '*.dmg' -o -name '*.app' | sed 's/^/    /'
echo
echo "Verify the notarization ticket is stapled:"
echo "    xcrun stapler validate 'src-tauri/target/release/bundle/dmg/'*.dmg"
echo "    spctl -a -vvv -t install 'src-tauri/target/release/bundle/macos/Gaze.app'"
