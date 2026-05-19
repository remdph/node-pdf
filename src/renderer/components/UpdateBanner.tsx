import { useEffect, useState } from 'react';

import { ipc } from '../lib/ipc.js';
import type { UpdaterState } from '~shared/types/ipc.js';

const DISMISSED_KEY = 'nodepdf:update-dismissed-version';

/**
 * Bottom-right toast that surfaces actionable updater transitions:
 *   - Linux `available`  → "View release" link (the user has to update
 *                          through their package manager or the release).
 *   - Win/Mac `ready`    → "Restart and install" button (calls
 *                          autoUpdater.quitAndInstall via IPC).
 *   - Anything else      → hidden (the sidebar indicator handles
 *                          checking/current/error visibility).
 *
 * The home sidebar's `UpdaterStatus` component is the always-visible
 * status row; this banner is the transient call-to-action shown even
 * when the user is reading a PDF and the home sidebar isn't visible.
 *
 * Dismissal is persisted per-version in localStorage — a newer version
 * supersedes the dismissal automatically.
 */
export function UpdateBanner(): JSX.Element | null {
  const [state, setState] = useState<UpdaterState | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(
    () => localStorage.getItem(DISMISSED_KEY),
  );

  useEffect(() => {
    void ipc.app.updaterState().then(setState);
    return ipc.app.onUpdaterStateChange(setState);
  }, []);

  if (!state) return null;

  const isLinux = ipc.platform === 'linux';
  const shouldShow =
    (state.status === 'ready' && !isLinux) ||
    (state.status === 'available' && isLinux);
  if (!shouldShow) return null;

  const targetVersion = state.latestVersion ?? '';
  if (targetVersion && dismissedVersion === targetVersion) return null;

  const dismiss = () => {
    if (targetVersion) {
      localStorage.setItem(DISMISSED_KEY, targetVersion);
      setDismissedVersion(targetVersion);
    } else {
      setState(null);
    }
  };

  const onInstall = () => {
    void ipc.app.installUpdate();
  };

  return (
    <div className="update-banner" role="alert">
      <div className="update-banner-icon" aria-hidden>
        <DownloadIcon />
      </div>
      <div className="update-banner-body">
        <div className="update-banner-title">
          {state.status === 'ready' ? 'Ready to install' : 'Update available'}
        </div>
        <div className="update-banner-sub">
          NodePDF v{targetVersion || '?'}{' '}
          {state.status === 'ready' ? 'has been downloaded.' : 'is out.'}
        </div>
      </div>
      {state.status === 'ready' ? (
        <button type="button" className="update-banner-cta" onClick={onInstall}>
          Restart and install
        </button>
      ) : (
        <a
          className="update-banner-cta"
          href={state.htmlUrl ?? '#'}
          target="_blank"
          rel="noreferrer"
        >
          View release
        </a>
      )}
      <button
        type="button"
        className="update-banner-close"
        aria-label="Dismiss update notification"
        title="Dismiss"
        onClick={dismiss}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M1,1 L9,9 M9,1 L1,9" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
    </div>
  );
}

function DownloadIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M7 2 V9 M4 6 L7 9 L10 6 M2.5 11.5 H11.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
