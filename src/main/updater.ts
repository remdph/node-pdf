import { app, autoUpdater, BrowserWindow } from 'electron';
import { updateElectronApp, UpdateSourceType } from 'update-electron-app';

import { IPC_CHANNELS } from '~shared/types/ipc.js';
import type { UpdaterState, UpdaterStatus } from '~shared/types/ipc.js';
import { handle } from './ipc/register.js';

const GH_OWNER = 'remdph';
const GH_REPO = 'node-pdf';
/** How often the Linux checker re-polls the GitHub API while the app is
 * running. Single check at startup catches the common case; periodic
 * re-checks pick up releases shipped mid-session without the user
 * relaunching. Generous enough to stay well under the 60 req/hour
 * unauthenticated rate limit even with many open windows. */
const LINUX_RECHECK_MS = 4 * 60 * 60 * 1000;

// Module-level state. The renderer reads it via `app:updater-state-get`
// (snapshot) and `app:updater-state-change` (push). Always exported as
// a defensive copy through getState() so consumers can't mutate it.
let state: UpdaterState = {
  status: 'idle',
  currentVersion: '0.0.0', // overwritten in setupUpdater() once app is ready
};

function setState(patch: Partial<UpdaterState>): void {
  const next: UpdaterState = { ...state, ...patch };
  // Drop fields that no longer apply to the new status so the renderer
  // doesn't see stale values (e.g. an htmlUrl after we transition back
  // to `current`).
  if (next.status !== 'available' && next.status !== 'ready') {
    delete next.htmlUrl;
    if (next.status !== 'current') delete next.latestVersion;
  }
  if (next.status !== 'error') delete next.error;
  state = next;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC_CHANNELS.app.updaterStateChange, state);
  }
}

function getState(): UpdaterState {
  return { ...state };
}

/**
 * Two-track updater + state machine:
 *
 *  - Win + macOS: `update-electron-app` configures Electron's
 *    `autoUpdater` to talk to update.electronjs.org (an Electron-team-
 *    hosted proxy on top of this repo's GitHub Releases). Download is
 *    automatic in the background; install is gated by the user's
 *    explicit click on our own "Restart and install" button — we set
 *    `notifyUser: false` so the library doesn't pop the native dialog,
 *    and we drive the lifecycle ourselves by listening to the same
 *    autoUpdater events the library would.
 *  - Linux: not supported by update.electronjs.org (distros own update
 *    flow). We poll the GitHub Releases API and update state directly.
 *
 * Both tracks land in the same `UpdaterState`, which the renderer
 * consumes from the home sidebar indicator (persistent status) and the
 * toast banner (transient call-to-action).
 *
 * Debug overrides via NODEPDF_UPDATER_DEBUG env var:
 *   - `fake`         → push a synthetic `available` state ~1.5s after
 *                      start, no network, bypasses packaged gate.
 *                      Use to iterate on the sidebar / banner UI.
 *   - `<semver>` like `0.1.0` → run the real Linux GH-API check using
 *                      this string as the "current version" for the
 *                      comparison, bypassing the packaged gate. Use to
 *                      smoke-test the full check flow without editing
 *                      package.json or shipping a new release.
 */
export function setupUpdater(): void {
  setState({ currentVersion: app.getVersion() });
  registerUpdaterIpc();

  const debug = process.env.NODEPDF_UPDATER_DEBUG?.trim();

  if (debug === 'fake' || debug === '1') {
    setTimeout(() => {
      setState({
        status: 'available',
        latestVersion: '99.0.0',
        htmlUrl: `https://github.com/${GH_OWNER}/${GH_REPO}/releases/latest`,
      });
    }, 1500);
    return;
  }

  const debugCurrent = debug && /^\d+\.\d+\.\d+/.test(debug) ? debug : undefined;
  if (!app.isPackaged && !debugCurrent) {
    // Dev build: there's no point checking against GitHub when the
    // running version IS the working tree. Settle into `current` so the
    // sidebar shows "Up to date · vX.Y.Z" instead of an infinite
    // spinner from the initial `idle` state.
    setState({ status: 'current', latestVersion: state.currentVersion });
    return;
  }

  if ((process.platform === 'win32' || process.platform === 'darwin') && !debugCurrent) {
    setupSquirrel();
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

function setupSquirrel(): void {
  // Wire our state machine to autoUpdater BEFORE update-electron-app
  // registers its feed URL, so we don't miss the first event burst.
  autoUpdater.on('checking-for-update', () => setState({ status: 'checking' }));
  autoUpdater.on('update-available', () => {
    // At this point the download just started — autoUpdater always
    // downloads automatically. We surface 'available' and will flip to
    // 'ready' once the download is on disk.
    setState({ status: 'available' });
  });
  autoUpdater.on('update-not-available', () =>
    setState({ status: 'current', latestVersion: state.currentVersion }),
  );
  // The exact shape of release info passed here varies by platform.
  // We only need the version string, which Squirrel publishes as a
  // separate arg on macOS and inside an info object on Windows.
  autoUpdater.on(
    'update-downloaded',
    (_event, releaseNotes: string, releaseName: string) => {
      const version = pickVersionFromSquirrel(releaseName, releaseNotes);
      setState({ status: 'ready', latestVersion: version ?? state.latestVersion });
    },
  );
  autoUpdater.on('error', (err) => {
    setState({ status: 'error', error: err?.message ?? 'Update check failed' });
  });

  try {
    updateElectronApp({
      updateSource: {
        type: UpdateSourceType.ElectronPublicUpdateService,
        repo: `${GH_OWNER}/${GH_REPO}`,
      },
      updateInterval: '1 hour',
      // We render the "ready to install" confirmation ourselves (sidebar
      // indicator + banner), so suppress the library's native dialog.
      // The library still calls checkForUpdates on a timer for us.
      notifyUser: false,
      logger: {
        log: (m) => console.log('[updater]', m),
        info: (m) => console.info('[updater]', m),
        warn: (m) => console.warn('[updater]', m),
        error: (m) => console.error('[updater]', m),
      },
    });
  } catch (err) {
    console.error('[updater] failed to start auto-updater', err);
    setState({ status: 'error', error: (err as Error)?.message ?? 'Setup failed' });
  }
}

async function runLinuxCheck(fakeCurrent?: string): Promise<void> {
  setState({ status: 'checking' });
  try {
    const info = await fetchLatestRelease();
    if (!info) {
      // Fetch failed or returned no usable release — stay in 'current'
      // rather than 'error' so we don't scare the user with a red
      // status row over a transient network blip.
      setState({ status: 'current', latestVersion: state.currentVersion });
      return;
    }
    const current = fakeCurrent ?? app.getVersion();
    if (!isNewerVersion(info.version, current)) {
      setState({ status: 'current', latestVersion: info.version });
      return;
    }
    if (fakeCurrent) {
      console.info(`[updater] debug: ${info.version} > fake current ${current}`);
    }
    setState({
      status: 'available',
      latestVersion: info.version,
      htmlUrl: info.htmlUrl,
    });
  } catch (err) {
    console.error('[updater] linux check failed', err);
    setState({ status: 'error', error: (err as Error)?.message ?? 'Network error' });
  }
}

async function fetchLatestRelease(): Promise<{ version: string; htmlUrl: string } | null> {
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
  const body = (await res.json()) as {
    tag_name?: string;
    html_url?: string;
    draft?: boolean;
    prerelease?: boolean;
  };
  if (body.draft || body.prerelease) return null;
  if (typeof body.tag_name !== 'string' || typeof body.html_url !== 'string') return null;
  return {
    version: body.tag_name.replace(/^v/, ''),
    htmlUrl: body.html_url,
  };
}

function registerUpdaterIpc(): void {
  handle<[], UpdaterState>(IPC_CHANNELS.app.updaterStateGet, () => getState());
  handle<[], void>(IPC_CHANNELS.app.updaterInstall, () => {
    if (state.status !== 'ready') return;
    if (process.platform !== 'win32' && process.platform !== 'darwin') return;
    // quitAndInstall closes the app, lets Squirrel swap the bits, and
    // relaunches. There's no "are you sure" prompt — the renderer
    // surfaces the confirmation via its own button.
    autoUpdater.quitAndInstall();
  });
}

/**
 * Squirrel's `update-downloaded` arguments differ across platforms. On
 * macOS the second positional arg is `releaseName` containing the
 * semver tag; on Windows the version usually shows up in
 * `releaseNotes`. Try both, fall back to whatever's there.
 */
function pickVersionFromSquirrel(releaseName?: string, releaseNotes?: string): string | undefined {
  const fromName = releaseName?.match(/\d+\.\d+\.\d+/)?.[0];
  if (fromName) return fromName;
  const fromNotes = releaseNotes?.match(/\d+\.\d+\.\d+/)?.[0];
  return fromNotes;
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
