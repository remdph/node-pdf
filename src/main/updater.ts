import { app, autoUpdater, BrowserWindow } from 'electron';

import { IPC_CHANNELS } from '~shared/types/ipc.js';
import type { UpdaterState, UpdaterStatus } from '~shared/types/ipc.js';
import { handle } from './ipc/register.js';
import { getSettings } from './settings/store.js';

const GH_OWNER = 'remdph';
const GH_REPO = 'node-pdf';
/** Hourly polling for Win/macOS when auto-check is enabled. */
const SQUIRREL_POLL_MS = 60 * 60 * 1000;
/** 4-hour polling for the Linux GitHub-API check. Conservative because
 * GitHub's unauthenticated rate limit is 60 req/h per IP. */
const LINUX_RECHECK_MS = 4 * 60 * 60 * 1000;

let state: UpdaterState = {
  status: 'idle',
  currentVersion: '0.0.0',
};

let squirrelInitialized = false;
let squirrelInterval: NodeJS.Timeout | null = null;
let linuxInterval: NodeJS.Timeout | null = null;

function setState(patch: Partial<UpdaterState>): void {
  const next: UpdaterState = { ...state, ...patch };
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
 *  - Win + macOS: Electron's `autoUpdater` (Squirrel) pointed at
 *    update.electronjs.org (an Electron-team-hosted proxy on top of
 *    this repo's GitHub Releases). Download is automatic in the
 *    background; install is gated by the user's explicit click on
 *    our "Restart and install" button — no native dialog.
 *  - Linux: not supported by update.electronjs.org (distros own the
 *    update flow). We poll the GitHub Releases API directly.
 *
 * Listener registration and feed-URL configuration happen once via
 * `ensureSquirrelInitialized()`, lazily. That way the manual
 * "Check for updates now" button works even when the user has opted
 * out of `checkUpdatesOnStartup` (we just don't auto-poll for them).
 *
 * Debug overrides via NODEPDF_UPDATER_DEBUG:
 *   - `fake`         → push a synthetic `available` state ~1.5s after
 *                      start (no network).
 *   - `<semver>`     → run the real Linux GH-API check using that
 *                      string as the "current version" for the
 *                      comparison, bypassing the packaged gate.
 */
export function setupUpdater(): void {
  setState({ currentVersion: app.getVersion() });
  registerUpdaterIpc();
  void bootstrap();
}

async function bootstrap(): Promise<void> {
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
    // Dev build: the running version IS the working tree, so claiming
    // "up to date" is honest. Manual "Check now" will error out with a
    // clear "needs packaged build" message on Win/Mac.
    setState({ status: 'current', latestVersion: state.currentVersion });
    return;
  }

  let optedIn = true;
  try {
    const settings = await getSettings();
    optedIn = settings.checkUpdatesOnStartup;
  } catch (err) {
    console.warn('[updater] settings read failed; defaulting to check enabled', err);
  }

  // Linux path
  if (process.platform === 'linux' || debugCurrent) {
    if (!optedIn && !debugCurrent) {
      setState({ status: 'disabled' });
      return;
    }
    void runLinuxCheck(debugCurrent);
    if (!debugCurrent) {
      linuxInterval = setInterval(() => void runLinuxCheck(), LINUX_RECHECK_MS);
    }
    return;
  }

  // Win/Mac path
  if (process.platform === 'win32' || process.platform === 'darwin') {
    if (!optedIn) {
      // Don't poll, but don't claim "up to date" either — we never
      // contacted the network. Manual check still works (it'll
      // lazily initialize when the user clicks).
      setState({ status: 'disabled' });
      return;
    }
    try {
      ensureSquirrelInitialized();
      autoUpdater.checkForUpdates();
      squirrelInterval = setInterval(() => autoUpdater.checkForUpdates(), SQUIRREL_POLL_MS);
    } catch (err) {
      console.error('[updater] squirrel init/check failed', err);
      setState({ status: 'error', error: (err as Error)?.message ?? 'Setup failed' });
    }
  }
}

/**
 * Idempotent: registers the autoUpdater event listeners + sets the
 * feed URL exactly once. Called from both the auto-bootstrap path
 * (when opted in) and the manual check (when opted out — so the
 * user can still trigger a check from Settings without re-enabling
 * the periodic poll).
 */
function ensureSquirrelInitialized(): void {
  if (squirrelInitialized) return;
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking' }));
  autoUpdater.on('update-available', () => setState({ status: 'available' }));
  autoUpdater.on('update-not-available', () =>
    setState({ status: 'current', latestVersion: state.currentVersion }),
  );
  autoUpdater.on(
    'update-downloaded',
    (_event, releaseNotes: string, releaseName: string) => {
      const version = pickVersionFromSquirrel(releaseName, releaseNotes);
      setState({ status: 'ready', latestVersion: version ?? state.latestVersion });
    },
  );
  autoUpdater.on('error', (err) => {
    const msg = err?.message ?? 'Update check failed';
    console.error('[updater] autoUpdater error:', msg);
    setState({ status: 'error', error: msg });
  });

  // update.electronjs.org URL convention:
  //   https://update.electronjs.org/<owner>/<repo>/<platform>-<arch>/<currentVersion>
  // The service replies 204 when there's no newer release and 200 with
  // a JSON pointer when there is. Squirrel.Mac follows the JSON to a
  // signed .zip; Squirrel.Win uses its own RELEASES/.nupkg dance from
  // the embedded release URL.
  const platform = process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const url = `https://update.electronjs.org/${GH_OWNER}/${GH_REPO}/${platform}-${arch}/${app.getVersion()}`;
  console.info(`[updater] feed URL: ${url}`);
  try {
    autoUpdater.setFeedURL({ url });
  } catch (err) {
    console.error('[updater] setFeedURL failed', err);
    throw err;
  }

  squirrelInitialized = true;
}

async function runLinuxCheck(fakeCurrent?: string): Promise<void> {
  setState({ status: 'checking' });
  try {
    const info = await fetchLatestRelease();
    if (!info) {
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

/**
 * Manual / forced check, fired by the "Check for updates now" button
 * in Settings. Works regardless of the `checkUpdatesOnStartup` flag —
 * the flag only controls automatic polling. On Win/Mac in dev (not
 * packaged) it surfaces a clear error since autoUpdater requires a
 * real installed bundle.
 */
function checkForUpdatesNow(): void {
  if (process.platform === 'linux') {
    void runLinuxCheck();
    return;
  }
  if (process.platform === 'win32' || process.platform === 'darwin') {
    if (!app.isPackaged) {
      setState({
        status: 'error',
        error: 'Auto-update only runs in a packaged build. Try the installed app.',
      });
      return;
    }
    try {
      ensureSquirrelInitialized();
      autoUpdater.checkForUpdates();
    } catch (err) {
      console.error('[updater] manual check failed', err);
      setState({ status: 'error', error: (err as Error)?.message ?? 'Check failed' });
    }
  }
}

function registerUpdaterIpc(): void {
  handle<[], UpdaterState>(IPC_CHANNELS.app.updaterStateGet, () => getState());
  handle<[], void>(IPC_CHANNELS.app.updaterInstall, () => {
    if (state.status !== 'ready') return;
    if (process.platform !== 'win32' && process.platform !== 'darwin') return;
    autoUpdater.quitAndInstall();
  });
  handle<[], void>(IPC_CHANNELS.app.updaterCheckNow, () => checkForUpdatesNow());
}

function pickVersionFromSquirrel(releaseName?: string, releaseNotes?: string): string | undefined {
  const fromName = releaseName?.match(/\d+\.\d+\.\d+/)?.[0];
  if (fromName) return fromName;
  const fromNotes = releaseNotes?.match(/\d+\.\d+\.\d+/)?.[0];
  return fromNotes;
}

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
