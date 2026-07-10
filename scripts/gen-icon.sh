#!/usr/bin/env bash
# Rasterize the Pi Desktop app icon (apps/desktop/build/icon.svg) into the
# icon set electron-builder wants:
#   apps/desktop/build/icon.png   (1024 master PNG)
#   apps/desktop/build/icon.icns  (multi-resolution macOS icon)
#
# SVG->PNG uses whatever this Mac has. Preference order:
#   rsvg-convert > resvg > inkscape > cairosvg > qlmanage (QuickLook/WebKit).
# `sips` CANNOT read SVG, so it is only used to DOWNSCALE the 1024 master PNG
# into the smaller iconset sizes (high-quality Lanczos). `iconutil` packs the
# .iconset into .icns.
set -euo pipefail

cd "$(dirname "$0")/.."
BUILD="apps/desktop/build"
SVG="$BUILD/icon.svg"
MASTER="$BUILD/icon.png"
ICONSET="$BUILD/icon.iconset"
ICNS="$BUILD/icon.icns"

[ -f "$SVG" ] || { echo "gen-icon: missing $SVG" >&2; exit 1; }

echo "gen-icon: rendering 1024px master from $SVG"
rendered=""
render_1024() {
  if command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert -w 1024 -h 1024 "$SVG" -o "$MASTER" && rendered="rsvg-convert"; return
  fi
  if command -v resvg >/dev/null 2>&1; then
    resvg -w 1024 -h 1024 "$SVG" "$MASTER" && rendered="resvg"; return
  fi
  if command -v inkscape >/dev/null 2>&1; then
    inkscape "$SVG" --export-type=png -w 1024 -h 1024 -o "$MASTER" && rendered="inkscape"; return
  fi
  if command -v cairosvg >/dev/null 2>&1; then
    cairosvg "$SVG" -W 1024 -H 1024 -o "$MASTER" && rendered="cairosvg"; return
  fi
  if command -v qlmanage >/dev/null 2>&1; then
    # QuickLook writes "<name>.png" into -o dir; render large then normalize.
    tmp="$(mktemp -d)"
    qlmanage -t -s 1024 -o "$tmp" "$SVG" >/dev/null 2>&1 || true
    out="$(/bin/ls "$tmp"/*.png 2>/dev/null | head -1 || true)"
    if [ -n "$out" ]; then
      # QuickLook may return <1024 on a side; pad/scale to an exact 1024 square.
      sips -z 1024 1024 "$out" --out "$MASTER" >/dev/null
      rendered="qlmanage"
    fi
    rm -rf "$tmp"
    return
  fi
}
render_1024

if [ -z "$rendered" ] || [ ! -f "$MASTER" ]; then
  cat >&2 <<EOF
gen-icon: no SVG rasterizer produced a PNG.
Install one, then re-run this script. Fastest:
  brew install librsvg     # provides rsvg-convert
Then:
  rsvg-convert -w 1024 -h 1024 "$SVG" -o "$MASTER"
  bash scripts/gen-icon.sh
EOF
  exit 1
fi
echo "gen-icon: master rendered via $rendered -> $MASTER"

echo "gen-icon: building $ICONSET"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
# name:size pairs electron-builder / iconutil expect
for pair in \
  icon_16x16:16 icon_16x16@2x:32 \
  icon_32x32:32 icon_32x32@2x:64 \
  icon_128x128:128 icon_128x128@2x:256 \
  icon_256x256:256 icon_256x256@2x:512 \
  icon_512x512:512 icon_512x512@2x:1024
do
  name="${pair%%:*}"; size="${pair##*:}"
  sips -z "$size" "$size" "$MASTER" --out "$ICONSET/$name.png" >/dev/null
done

echo "gen-icon: packing $ICNS"
iconutil -c icns "$ICONSET" -o "$ICNS"
rm -rf "$ICONSET"

echo "gen-icon: done"
echo "  $MASTER   ($(sips -g pixelWidth "$MASTER" | awk '/pixelWidth/{print $2}')px)"
echo "  $ICNS     ($(du -h "$ICNS" | awk '{print $1}'))"
