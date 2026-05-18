import { useEffect, useState } from 'react';

import { ipc } from '../lib/ipc.js';
import type { UpdateInfo } from '~shared/types/ipc.js';

const DISMISSED_KEY = 'nodepdf:update-dismissed-version';

/**
 * Bottom-right corner toast surfaced when the Linux GitHub-Releases
 * checker (see src/main/updater.ts) reports a version newer than the
 * running build. Win/macOS skip this — the native Squirrel update flow
 * shows its own dialog. The user can dismiss a specific version; we
 * record it in localStorage so the next check for the SAME version
 * stays silent. A newer version overrides the dismissal automatically
 * since we only suppress when latest === dismissed.
 */
export function UpdateBanner(): JSX.Element | null {
  const [info, setInfo] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    return ipc.app.onUpdateAvailable((next) => {
      const dismissed = localStorage.getItem(DISMISSED_KEY);
      if (dismissed === next.version) return;
      setInfo(next);
    });
  }, []);

  if (!info) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, info.version);
    setInfo(null);
  };

  return (
    <div className="update-banner" role="alert">
      <div className="update-banner-icon" aria-hidden>
        <DownloadIcon />
      </div>
      <div className="update-banner-body">
        <div className="update-banner-title">Update available</div>
        <div className="update-banner-sub">
          NodePDF v{info.version} is out.
        </div>
      </div>
      {/* target=_blank routes through windows.ts:68 setWindowOpenHandler,
       * which calls shell.openExternal — keeps the link out of an
       * Electron BrowserWindow. */}
      <a
        className="update-banner-cta"
        href={info.htmlUrl}
        target="_blank"
        rel="noreferrer"
      >
        View release
      </a>
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
