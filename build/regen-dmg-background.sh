#!/usr/bin/env bash
# Regenerates build/dmg-background.svg (re-embeds icon.png as base64) and
# rasterizes the @1x + @2x PNGs that MakerDMG consumes.
set -euo pipefail
cd "$(dirname "$0")/.."
ICON_B64=$(base64 -i icon.png)
cat > build/dmg-background.svg <<SVG
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" width="600" height="400" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs>
    <linearGradient id="bodyBg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#f1f2f5"/>
    </linearGradient>
    <marker id="arrowhead" viewBox="0 0 12 12" refX="6" refY="6"
            markerWidth="11" markerHeight="11" orient="auto">
      <path d="M0,0 L12,6 L0,12 L4,6 Z" fill="#1a1a1a"/>
    </marker>
  </defs>
  <rect x="0" y="0" width="600" height="400" fill="url(#bodyBg)"/>
  <image x="30" y="26" width="44" height="44" xlink:href="data:image/png;base64,${ICON_B64}"/>
  <text x="84" y="58"
        font-family="-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif"
        font-size="22" font-weight="700" fill="#1a1a1a" letter-spacing="-0.2">NodePDF</text>
  <path d="M 215,220 C 270,140 350,140 405,210"
        fill="none" stroke="#1a1a1a" stroke-width="4.5"
        stroke-linecap="round" marker-end="url(#arrowhead)"/>
</svg>
SVG
/opt/homebrew/bin/rsvg-convert -w 600 -h 400 build/dmg-background.svg -o build/dmg-background.png
/opt/homebrew/bin/rsvg-convert -w 1200 -h 800 build/dmg-background.svg -o build/dmg-background@2x.png
echo "Regenerated build/dmg-background.{svg,png,@2x.png}"
