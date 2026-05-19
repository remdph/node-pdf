import { useEffect, useState } from 'react';

import { ipc } from '../lib/ipc.js';
import type { UpdaterState } from '~shared/types/ipc.js';

/**
 * Persistent status row pinned to the bottom of the home sidebar. Six
 * states (idle / checking / current / available / ready / error) drive
 * one of three visual variants:
 *
 *   "Up to date"    — checkmark + version (current)
 *   "Update v…"     — accent download icon + action
 *                     (available on Linux → "View release";
 *                      available on Win/Mac → "Downloading…" passive;
 *                      ready on Win/Mac    → "Restart" button)
 *   "Checking…"     — muted spinner-text (idle / checking)
 *   "Check failed"  — muted (error; rare, doesn't shout)
 */
export function UpdaterStatus(): JSX.Element {
  const [state, setState] = useState<UpdaterState | null>(null);

  useEffect(() => {
    void ipc.app.updaterState().then(setState);
    return ipc.app.onUpdaterStateChange(setState);
  }, []);

  if (!state) return <div className="updater-status updater-status-muted" aria-hidden />;

  const isLinux = ipc.platform === 'linux';
  const { status, currentVersion, latestVersion, htmlUrl } = state;

  if (status === 'available') {
    return (
      <div className="updater-status updater-status-accent" role="status">
        <span className="updater-status-icon" aria-hidden>
          <DownloadIcon />
        </span>
        <div className="updater-status-body">
          <div className="updater-status-title">Update available</div>
          <div className="updater-status-sub">v{latestVersion ?? '?'}</div>
        </div>
        {isLinux ? (
          <a
            className="updater-status-action"
            href={htmlUrl ?? '#'}
            target="_blank"
            rel="noreferrer"
          >
            View release
          </a>
        ) : (
          <span className="updater-status-action updater-status-action-muted" aria-live="polite">
            Downloading…
          </span>
        )}
      </div>
    );
  }

  if (status === 'ready') {
    return (
      <div className="updater-status updater-status-accent" role="status">
        <span className="updater-status-icon" aria-hidden>
          <DownloadIcon />
        </span>
        <div className="updater-status-body">
          <div className="updater-status-title">Ready to install</div>
          <div className="updater-status-sub">v{latestVersion ?? '?'}</div>
        </div>
        <button
          type="button"
          className="updater-status-action updater-status-action-primary"
          onClick={() => void ipc.app.installUpdate()}
        >
          Restart
        </button>
      </div>
    );
  }

  if (status === 'current') {
    return (
      <div className="updater-status updater-status-muted" role="status">
        <span className="updater-status-icon" aria-hidden>
          <CheckIcon />
        </span>
        <div className="updater-status-body">
          <div className="updater-status-title">Up to date</div>
          <div className="updater-status-sub">v{currentVersion}</div>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="updater-status updater-status-muted" role="status">
        <span className="updater-status-icon" aria-hidden>
          <CheckIcon dimmed />
        </span>
        <div className="updater-status-body">
          <div className="updater-status-title">Update check failed</div>
          <div className="updater-status-sub">v{currentVersion}</div>
        </div>
      </div>
    );
  }

  // idle / checking
  return (
    <div className="updater-status updater-status-muted" role="status">
      <span className="updater-status-icon" aria-hidden>
        <SpinnerIcon />
      </span>
      <div className="updater-status-body">
        <div className="updater-status-title">Checking for updates…</div>
        <div className="updater-status-sub">v{currentVersion}</div>
      </div>
    </div>
  );
}

function CheckIcon({ dimmed = false }: { dimmed?: boolean }): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.2" opacity={dimmed ? 0.5 : 1} />
      <path
        d="M4.2 7.2 L6.2 9.2 L9.8 5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={dimmed ? 0.5 : 1}
      />
    </svg>
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

function SpinnerIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden className="updater-spinner">
      <circle cx="7" cy="7" r="5.4" stroke="currentColor" strokeWidth="1.4" opacity="0.25" />
      <path
        d="M7 1.6 A5.4 5.4 0 0 1 12.4 7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
