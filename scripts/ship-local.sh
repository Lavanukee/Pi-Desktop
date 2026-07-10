#!/usr/bin/env bash
# Build the desktop app, package it unsigned, ad-hoc sign, and install to
# /Applications so the latest build is always a double-click away.
set -euo pipefail

cd "$(dirname "$0")/.."

pnpm turbo run build --filter @pi-desktop/desktop
pnpm --filter @pi-desktop/desktop exec electron-builder --dir --config electron-builder.yml

APP_SRC="apps/desktop/release/mac-arm64/Pi Desktop.app"
[ -d "$APP_SRC" ] || APP_SRC="apps/desktop/release/mac/Pi Desktop.app"
[ -d "$APP_SRC" ] || { echo "ship-local: packaged app not found under apps/desktop/release" >&2; exit 1; }

# Ad-hoc signature: required for locally-built binaries on Apple Silicon.
codesign --force --deep --sign - "$APP_SRC"

DEST="/Applications/Pi Desktop.app"
rm -rf "$DEST"
ditto "$APP_SRC" "$DEST"

# Boot/theme smoke, then the packaging smoke: proves the SHIPPED bundle loads
# its 3 pi extensions, spawns pi from the bundled cli.js, and serves the
# pd-preview canvas harness (the old ship regressed to `count: 0` extensions and
# dev-only chat). Set SMOKE_MODEL=1 to also stream a real Gemma completion when
# the model + llama.cpp are cached at ~/.cache/pi-desktop.
(cd apps/desktop && node tests/e2e/packaged-probe.mjs "$DEST")
(cd apps/desktop && node tests/e2e/packaged-smoke.mjs "$DEST")

echo "ship-local: installed $(defaults read "$DEST/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo '?') → $DEST"
