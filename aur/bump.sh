#!/usr/bin/env bash
#
# Bumps the PKGBUILD to a new version, downloads the matching .deb to
# refresh the sha256sum, regenerates .SRCINFO and prints the git commands
# needed to push to the AUR.
#
# Usage:  ./bump.sh 0.2.0

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <new-version>" >&2
  exit 1
fi

NEW_VER="$1"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

URL="https://github.com/remdph/node-pdf/releases/download/v${NEW_VER}/node-pdf_${NEW_VER}_amd64.deb"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "› Downloading $URL"
curl -fsSL -o "$TMP/pkg.deb" "$URL"

SHA=$(sha256sum "$TMP/pkg.deb" | awk '{print $1}')
echo "› SHA256: $SHA"

sed -i "s/^pkgver=.*/pkgver=${NEW_VER}/" PKGBUILD
sed -i "s/^pkgrel=.*/pkgrel=1/" PKGBUILD
sed -i "s/^sha256sums=.*/sha256sums=('${SHA}')/" PKGBUILD

makepkg --printsrcinfo > .SRCINFO

echo
echo "✓ Bumped to $NEW_VER. Next steps:"
echo
echo "  cd <your-aur-checkout>"
echo "  cp $HERE/PKGBUILD $HERE/.SRCINFO ."
echo "  git add PKGBUILD .SRCINFO"
echo "  git commit -m 'upgpkg: nodepdf-bin ${NEW_VER}-1'"
echo "  git push origin master"
