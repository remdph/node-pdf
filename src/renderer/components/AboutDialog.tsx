import { useEffect, useState } from 'react';

import { ipc } from '../lib/ipc.js';
import logoUrl from '../assets/logo.png';

interface AboutDialogProps {
  onClose(): void;
}

const GITHUB_URL = 'https://github.com/remdph/node-pdf';
const DONATE_URL = 'https://www.buymeacoffee.com/remdph';

export function AboutDialog({ onClose }: AboutDialogProps): JSX.Element {
  const [version, setVersion] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    ipc?.app
      ?.version()
      .then((v) => {
        if (!cancelled) setVersion(v);
      })
      .catch(() => {
        if (!cancelled) setVersion('');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="password-dialog-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="password-dialog about-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="About NodePDF"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="password-dialog-header about-dialog-header">
          <button
            type="button"
            className="password-dialog-close"
            onClick={onClose}
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <path
                d="M2,2 L12,12 M12,2 L2,12"
                stroke="currentColor"
                strokeWidth="1.4"
                fill="none"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        <div className="password-dialog-body about-dialog-body">
          <img
            src={logoUrl}
            alt="NodePDF"
            className="about-dialog-logo"
            draggable={false}
          />
          {version && (
            <p className="about-dialog-version muted small">
              Version {version}
            </p>
          )}
          <p className="about-dialog-credits">
            Crafted by <strong>Rafael Maldonado</strong>.
          </p>
          <p className="about-dialog-description muted small">
            A lightweight desktop PDF viewer built with Electron and React.
          </p>

          <div className="about-dialog-links">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="about-dialog-link"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="currentColor">
                <path d="M8 .2C3.58.2 0 3.78 0 8.2c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38v-1.34c-2.22.48-2.69-1.07-2.69-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.81.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.83-2.15-.08-.2-.36-1.02.08-2.13 0 0 .67-.22 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.11.16 1.93.08 2.13.52.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.94.29.25.54.74.54 1.49v2.21c0 .21.15.46.55.38C13.71 14.73 16 11.74 16 8.2 16 3.78 12.42.2 8 .2Z" />
              </svg>
              GitHub
            </a>
            <a
              href={DONATE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="about-dialog-link about-dialog-link-donate"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none">
                <path
                  d="M8 14s-5-3.2-5-7a2.8 2.8 0 0 1 5-1.7A2.8 2.8 0 0 1 13 7c0 3.8-5 7-5 7Z"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
              </svg>
              Buy me a coffee
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
