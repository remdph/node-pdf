import { app, BrowserWindow } from 'electron';
import { updateElectronApp, UpdateSourceType } from 'update-electron-app';

import { IPC_CHANNELS } from '~shared/types/ipc.js';
import type { UpdateInfo } from '~shared/types/ipc.js';

const GH_OWNER = 'remdph';
const GH_REPO = 'node-pdf';
/** How often the Linux checker re-polls the GitHub API while the app is
 * running. Single check at startup catches the common case; periodic
 * re-checks pick up releases shipped mid-session without the user
 * relaunching. Generous enough to stay well under the 60 req/hour
 * unauthenticated rate limit even with many open windows. */
const LINUX_RECHECK_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Two-track updater:
 *  - Win + macOS use `update-electron-app`, which calls
 *    update.electronjs.org (an Electron-team-hosted proxy on top of the
 *    repo's GitHub Releases). It downloads the new artifact via Squirrel
 *    in the background and triggers a native "Restart to update" dialog.
 *  - Linux is intentionally not supported by that service (distros own
 *    update flow via apt / dnf / pacman / AppImage). We instead poll the
 *    GitHub API for the latest release and forward the result to the
 *    renderer as an `app:update-available` push, which surfaces a
 *    dismissable banner with a "View release" link.
 *
 * Called once from main after the first window is created. Bails in dev
 * (no point in checking when the version is the working-tree version).
 *
 * Debug overrides via NODEPDF_UPDATER_DEBUG env var:
 *   - `fake`         → broadcast a synthetic UpdateInfo (v99.0.0) ~1.5s
 *                      after start, no network, bypasses packaged gate.
 *                      Use to iterate on the banner UI.
 *   - `<semver>` like `0.1.0` → run the real Linux GH-API check using
 *                      this string as the "current version" for the
 *                      comparison, bypassing the packaged gate. Use to
 *                      smoke-test the full check flow without editing
 *                      package.json or shipping a new release.
 */
export function setupUpdater(): void {
  const debug = process.env.NODEPDF_UPDATER_DEBUG?.trim();

  if (debug === 'fake' || debug === '1') {
    setTimeout(() => {
      broadcastUpdateAvailable({
        version: '99.0.0',
        htmlUrl: `https://github.com/${GH_OWNER}/${GH_REPO}/releases/latest`,
      });
    }, 1500);
    return;
  }

  const debugCurrent = debug && /^\d+\.\d+\.\d+/.test(debug) ? debug : undefined;

  if (!app.isPackaged && !debugCurrent) return;

  if ((process.platform === 'win32' || process.platform === 'darwin') && !debugCurrent) {
    try {
      updateElectronApp({
        updateSource: {
          type: UpdateSourceType.ElectronPublicUpdateService,
          repo: `${GH_OWNER}/${GH_REPO}`,
        },
        updateInterval: '1 hour',
        notifyUser: true,
        logger: {
          log: (m) => console.log('[updater]', m),
          info: (m) => console.info('[updater]', m),
          warn: (m) => console.warn('[updater]', m),
          error: (m) => console.error('[updater]', m),
        },
      });
    } catch (err) {
      console.error('[updater] failed to start auto-updater', err);
    }
    return;
  }

  // Linux real flow, or any platform in debug mode with a fake current
  // version. Skip the periodic re-check when debugging — one shot is
  // enough to verify the wiring.
  void runLinuxCheck(debugCurrent);
  if (!debugCurrent) {
    setInterval(() => void runLinuxCheck(), LINUX_RECHECK_MS);
  }
}

async function runLinuxCheck(fakeCurrent?: string): Promise<void> {
  try {
    const info = await fetchLatestRelease();
    if (!info) {
      if (fakeCurrent) console.warn('[updater] debug: fetch returned no release');
      return;
    }
    const current = fakeCurrent ?? app.getVersion();
    if (!isNewerVersion(info.version, current)) {
      if (fakeCurrent) {
        console.info(
          `[updater] debug: latest ${info.version} not newer than ${current}; no broadcast`,
        );
      }
      return;
    }
    if (fakeCurrent) {
      console.info(`[updater] debug: broadcasting ${info.version} (vs fake current ${current})`);
    }
    broadcastUpdateAvailable(info);
  } catch (err) {
    console.error('[updater] linux check failed', err);
  }
}

async function fetchLatestRelease(): Promise<UpdateInfo | null> {
  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases/latest`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub rejects requests without a UA. Identifying as the app
      // also makes our traffic easy to filter from their abuse logs.
      'User-Agent': `node-pdf/${app.getVersion()}`,
    },
  });
  if (!res.ok) {
    console.warn('[updater] github API responded', res.status, res.statusText);
    return null;
  }
  const body = (await res.json()) as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean };
  if (body.draft || body.prerelease) return null;
  if (typeof body.tag_name !== 'string' || typeof body.html_url !== 'string') return null;
  return {
    version: body.tag_name.replace(/^v/, ''),
    htmlUrl: body.html_url,
  };
}

function broadcastUpdateAvailable(info: UpdateInfo): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC_CHANNELS.app.updateAvailable, info);
  }
}

/**
 * Strict numeric semver compare (major.minor.patch). Returns true when
 * `latest` is strictly newer than `current`. Doesn't handle pre-release
 * tags (`-rc.1` etc.) — the release pipeline doesn't emit those.
 */
function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): [number, number, number] => {
    const parts = v.replace(/^v/, '').split('.');
    return [
      Number.parseInt(parts[0] ?? '0', 10) || 0,
      Number.parseInt(parts[1] ?? '0', 10) || 0,
      Number.parseInt(parts[2] ?? '0', 10) || 0,
    ];
  };
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}
