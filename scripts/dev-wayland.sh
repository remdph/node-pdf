#!/usr/bin/env bash
#
# Convenience wrapper around `electron-forge start` for developers on
# Wayland compositors where the auto-detection in src/main/index.ts
# fails under the forge dev launcher.
#
# The packaged binary (launched from the .desktop entry by the compositor)
# inherits a richer XDG environment and Chromium's
# ozone-platform-hint=auto correctly picks Wayland, so the in-app code
# does the right thing in production. In `electron-forge start` something
# in the spawn pipeline confuses that detection and Chromium silently
# falls back to X11, ignoring WaylandFractionalScaleV1 and giving us a
# tiny UI on Hi-DPI screens.
#
# Workaround: read the actual scale from Hyprland and pass it via the
# NODEPDF_SCALE env var, which the main process honours unconditionally.
# Other Wayland compositors that don't ship hyprctl get the 1.5 fallback,
# which matches the most common Hi-DPI laptop scale and is easy to override
# (`NODEPDF_SCALE=2 pnpm dev:wayland`).
set -euo pipefail

SCALE="${NODEPDF_SCALE:-}"

if [[ -z "$SCALE" ]] && command -v hyprctl >/dev/null && command -v jq >/dev/null; then
  SCALE=$(hyprctl -j monitors 2>/dev/null | jq -r '.[0].scale // empty' 2>/dev/null || true)
fi

if [[ -z "$SCALE" || "$SCALE" == "null" ]]; then
  SCALE=1.5
fi

echo "[dev:wayland] launching with NODEPDF_SCALE=$SCALE"
exec env NODEPDF_SCALE="$SCALE" electron-forge start "$@"
