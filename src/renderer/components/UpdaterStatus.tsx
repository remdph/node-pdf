import { useEffect, useState } from 'react';

import { ipc } from '../lib/ipc.js';
import type { UpdaterState } from '~shared/types/ipc.js';

/**
 * Minimal single-line status pinned to the bottom of the home sidebar.
 * No border, no background — just a muted text row that turns into an
 * inline link/button when there's something actionable (View release on
 * Linux available, Restart on Win/Mac ready). The sidebar's own padding
 * provides the gap from the bottom edge.
 */
export function UpdaterStatus(): JSX.Element | null {
  const [state, setState] = useState<UpdaterState | null>(null);

  useEffect(() => {
    void ipc.app.updaterState().then(setState);
    return ipc.app.onUpdaterStateChange(setState);
  }, []);

  if (!state) return null;

  const isLinux = ipc.platform === 'linux';
  const { status, currentVersion, latestVersion, htmlUrl } = state;

  if (status === 'available') {
    return (
      <div className="updater-status updater-status-accent" role="status">
        <span className="updater-status-text">
          Update v{latestVersion ?? '?'} available
        </span>
        {isLinux ? (
          <a
            className="updater-status-link"
            href={htmlUrl ?? '#'}
            target="_blank"
            rel="noreferrer"
          >
            View release
          </a>
        ) : (
          <span className="updater-status-link updater-status-link-muted">Downloading…</span>
        )}
      </div>
    );
  }

  if (status === 'ready') {
    return (
      <div className="updater-status updater-status-accent" role="status">
        <span className="updater-status-text">v{latestVersion ?? '?'} ready</span>
        <button
          type="button"
          className="updater-status-link"
          onClick={() => void ipc.app.installUpdate()}
        >
          Restart
        </button>
      </div>
    );
  }

  if (status === 'error') {
    // Show the underlying autoUpdater / fetch error in a native tooltip
    // so the user can read it without opening Settings — surfaces
    // useful hints on Win/Mac like "Code signing identity does not
    // match" or "Could not load update".
    return (
      <div className="updater-status" role="status" title={state.error ?? undefined}>
        <span className="updater-status-text">Update check failed · v{currentVersion}</span>
      </div>
    );
  }

  if (status === 'idle' || status === 'checking') {
    return (
      <div className="updater-status" role="status">
        <span className="updater-status-text">Checking for updates…</span>
      </div>
    );
  }

  if (status === 'disabled') {
    // User opted out of auto-checks — don't claim "up to date" since
    // we never verified. Just print the version.
    return (
      <div className="updater-status" role="status">
        <span className="updater-status-text">v{currentVersion}</span>
      </div>
    );
  }

  // current
  return (
    <div className="updater-status" role="status">
      <span className="updater-status-text">Up to date · v{currentVersion}</span>
    </div>
  );
}
