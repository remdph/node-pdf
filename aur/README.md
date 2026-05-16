# AUR packaging — `nodepdf-bin`

This folder holds the AUR recipe for shipping NodePDF to Arch Linux users.
The package downloads the official `.deb` from the GitHub Release and
repackages it as a pacman-native `.pkg.tar.zst`.

## Files

- **`PKGBUILD`** — the recipe (`pkgname=nodepdf-bin`).
- **`.SRCINFO`** — machine-readable metadata, regenerated from PKGBUILD.
- **`bump.sh`** — helper to bump version, refresh sha256, regenerate .SRCINFO.

## One-time AUR setup

1. Create an AUR account at https://aur.archlinux.org/register and add
   your SSH public key under "My Account → Edit Account".
2. Clone the (empty) AUR repo for our package:
   ```bash
   git clone ssh://aur@aur.archlinux.org/nodepdf-bin.git ~/aur/nodepdf-bin
   ```
3. Copy the initial recipe and push:
   ```bash
   cp PKGBUILD .SRCINFO ~/aur/nodepdf-bin/
   cd ~/aur/nodepdf-bin
   git add PKGBUILD .SRCINFO
   git commit -m 'Initial import of nodepdf-bin 0.1.8-1'
   git push origin master
   ```
4. The package goes live within a minute. Users install with:
   ```bash
   yay -S nodepdf-bin   # or paru -S nodepdf-bin
   ```

## Releasing a new version

**Automated** — the `publish-aur` job in `.github/workflows/release.yml`
runs after every `v*.*.*` tag push. It downloads the freshly-published
`.deb`, computes its sha256, rewrites `pkgver`/`sha256sums` in the
PKGBUILD, regenerates `.SRCINFO`, and pushes to `ssh://aur@aur.archlinux.org/nodepdf-bin.git`.

So a new release is just:

```bash
# In the main project:
git tag v0.2.0
git push origin v0.2.0
# Wait ~10 min — the AUR will have the new version automatically.
```

### Manual fallback (when CI fails or for hot fixes)

```bash
cd aur
./bump.sh 0.2.0          # updates PKGBUILD + .SRCINFO
# bump.sh prints the next commands; basically:
cp PKGBUILD .SRCINFO ~/aur/nodepdf-bin/
cd ~/aur/nodepdf-bin
git add PKGBUILD .SRCINFO
git commit -m 'upgpkg: nodepdf-bin 0.2.0-1'
git push origin master
```

## CI publishing — setup (one-time)

The `publish-aur` job needs an SSH key dedicated to the runner. Don't
reuse your personal AUR key — a separate one limits blast radius if a
CI run is compromised.

1. **Generate a CI-only keypair (no passphrase)** locally:
   ```bash
   ssh-keygen -t ed25519 -f /tmp/aur-ci -N "" -C "github-actions@nodepdf"
   ```
2. **Add the public key to your AUR account** (https://aur.archlinux.org → My Account → SSH Public Key field). You can list multiple keys separated by newlines; keep your personal one and add this CI one underneath.
3. **Add the private key as a GitHub secret**:
   - `Settings → Secrets and variables → Actions → New repository secret`
   - Name: `AUR_SSH_PRIVATE_KEY`
   - Value: paste the full contents of `/tmp/aur-ci` (the private key, including the `-----BEGIN OPENSSH PRIVATE KEY-----` / `-----END OPENSSH PRIVATE KEY-----` lines).
4. **Delete the local copy** of the private key — GitHub now has the only canonical copy:
   ```bash
   rm /tmp/aur-ci
   ```

The job will fail until both pieces are in place. The first
`v*.*.*` tag push after configuring secrets pushes the initial AUR
import (so you can skip the manual `Initial import` commit below).

## Testing the recipe locally before publishing

```bash
cd aur
makepkg -sri --noconfirm    # builds + installs the package on your system
# verify it works:
node-pdf
# clean up afterwards:
sudo pacman -R nodepdf-bin
```

## Why `-bin`?

The `-bin` suffix in AUR convention signals that the package ships a
prebuilt binary instead of compiling from source. Building Electron apps
from source via npm is fragile and takes ~10 min — for end users the
download-prebuilt path is much better.

If a `nodepdf` (source) variant is wanted later we can publish it
alongside; the `provides=('nodepdf')` + `conflicts=('nodepdf')` lines
already prepare the slot.
