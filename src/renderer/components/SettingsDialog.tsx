import { useEffect } from 'react';

import { applyTheme } from '../lib/theme.js';
import { useSettingsStore } from '../stores/settings.js';
import type { UiTheme } from '~shared/types/settings.js';

interface SettingsDialogProps {
  onClose(): void;
}

/**
 * In-app settings panel surfaced from the titlebar gear button. Two
 * options for now:
 *   - "Check for updates on startup" — wires through to the main
 *     updater (read at bootstrap time). Toggling takes effect on next
 *     launch; the current session keeps whatever state the updater
 *     already arrived at.
 *   - "Theme" — flips `<html data-theme=…>` synchronously and persists
 *     to AppSettings. The cached value in localStorage means the next
 *     cold start picks the right theme before React even mounts (see
 *     src/renderer/lib/theme.ts).
 *
 * Shares the modal shell classes (`password-dialog*`) with
 * AboutDialog / ProtectDialog so styling stays consistent.
 */
export function SettingsDialog({ onClose }: SettingsDialogProps): JSX.Element {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const setTheme = (theme: UiTheme) => {
    // Apply immediately so the user sees the change while the IPC
    // round-trip writes settings.json. If the write fails the UI stays
    // visually correct and the next launch will revert via cache — an
    // acceptable degradation for a cosmetic setting.
    applyTheme(theme);
    void update({ theme });
  };

  const setCheckUpdates = (enabled: boolean) => {
    void update({ checkUpdatesOnStartup: enabled });
  };

  return (
    <div
      className="password-dialog-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="password-dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="password-dialog-header settings-dialog-header">
          <h2 className="settings-dialog-title">Settings</h2>
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

        <div className="password-dialog-body settings-dialog-body">
          <section className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-title">Check for updates on startup</div>
              <div className="settings-row-sub">
                When enabled, NodePDF contacts GitHub on launch to see if a
                newer release is available. Takes effect next launch.
              </div>
            </div>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={settings.checkUpdatesOnStartup}
                onChange={(e) => setCheckUpdates(e.target.checked)}
              />
              <span className="settings-toggle-track" aria-hidden>
                <span className="settings-toggle-thumb" />
              </span>
            </label>
          </section>

          <section className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-title">Theme</div>
              <div className="settings-row-sub">
                Light is functional but some accents still assume a dark
                background — Dark is the polished default.
              </div>
            </div>
            <div className="settings-segmented" role="radiogroup" aria-label="Theme">
              <button
                type="button"
                role="radio"
                aria-checked={settings.theme === 'dark'}
                className={`settings-segmented-btn${settings.theme === 'dark' ? ' settings-segmented-on' : ''}`}
                onClick={() => setTheme('dark')}
              >
                Dark
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={settings.theme === 'light'}
                className={`settings-segmented-btn${settings.theme === 'light' ? ' settings-segmented-on' : ''}`}
                onClick={() => setTheme('light')}
              >
                Light
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
