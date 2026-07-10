#!/usr/bin/env bash
# Build the desktop app, package it unsigned, ad-hoc sign, and install to
# /Applications so the latest build is always a double-click away.
set -euo pipefail

cd "$(dirname "$0")/.."

pnpm turbo run build --filter @pi-desktop/desktop
# Build the Apple Foundation Models Swift helper (pi-afm) so it exists for
# electron-builder to bundle (extraUnpackedDir via asarUnpack). No-op-safe on
# non-arm64: the build just produces the mach-o under swift/.build/release.
pnpm --filter @pi-desktop/afm build:swift
# Build the Mac computer-use Swift helper (pi-mac) the same way — it is
# asarUnpack'd and spawned by main (pi-mac --serve). arm64/macOS-only.
pnpm --filter @pi-desktop/pi-mac build:swift
pnpm --filter @pi-desktop/desktop exec electron-builder --dir --config electron-builder.yml

APP_SRC="apps/desktop/release/mac-arm64/Pi Desktop.app"
[ -d "$APP_SRC" ] || APP_SRC="apps/desktop/release/mac/Pi Desktop.app"
[ -d "$APP_SRC" ] || { echo "ship-local: packaged app not found under apps/desktop/release" >&2; exit 1; }

# Sign the pi-afm mach-o FIRST (codesign requires inner code signed before the
# enclosing bundle). It is unpacked to app.asar.unpacked; ad-hoc is fine locally.
# (Developer-ID signing + notarizing this helper as a separate mach-o is W11.)
AFM_HELPER="$APP_SRC/Contents/Resources/app.asar.unpacked/node_modules/@pi-desktop/afm/swift/.build/release/pi-afm"
if [ -f "$AFM_HELPER" ]; then
  codesign --force --sign - "$AFM_HELPER"
  echo "ship-local: signed pi-afm helper"
else
  echo "ship-local: WARNING pi-afm helper not bundled at $AFM_HELPER" >&2
fi

# Sign the pi-mac mach-o (Mac computer-use helper) before the enclosing bundle,
# same as pi-afm. The Accessibility + Screen-Recording TCC grants attribute to
# the signed identity; ad-hoc is fine locally (stable Developer-ID signing is W11).
MAC_HELPER="$APP_SRC/Contents/Resources/app.asar.unpacked/node_modules/@pi-desktop/pi-mac/swift/.build/release/pi-mac"
if [ -f "$MAC_HELPER" ]; then
  codesign --force --sign - "$MAC_HELPER"
  echo "ship-local: signed pi-mac helper"
else
  echo "ship-local: WARNING pi-mac helper not bundled at $MAC_HELPER" >&2
fi

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
