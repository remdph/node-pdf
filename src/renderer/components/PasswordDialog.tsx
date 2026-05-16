import { useEffect, useRef, useState } from 'react';

interface PasswordDialogProps {
  /** Filename shown in the subtitle for context. */
  title?: string;
  /** Shows an "Incorrect password" hint after a failed attempt. */
  error?: boolean;
  onSubmit(password: string): void;
  onCancel(): void;
}

/** Single-field password prompt used by pdfjs's `onPassword` callback when
 * opening an encrypted PDF. */
export function PasswordDialog({
  title,
  error,
  onSubmit,
  onCancel,
}: PasswordDialogProps): JSX.Element {
  const [password, setPassword] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length === 0) return;
    onSubmit(password);
  };

  return (
    <div
      className="password-dialog-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <form
        className="password-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Enter password"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <header className="password-dialog-header">
          <div>
            <h2 className="password-dialog-title">Password required</h2>
            {title && (
              <p className="password-dialog-subtitle muted small" title={title}>
                {title}
              </p>
            )}
          </div>
          <button
            type="button"
            className="password-dialog-close"
            onClick={onCancel}
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

        <div className="password-dialog-body">
          <p className="muted small password-dialog-help">
            This PDF is encrypted. Enter the password to open it.
          </p>

          <label className="password-dialog-field">
            <span className="password-dialog-label">Password</span>
            <input
              ref={inputRef}
              type="password"
              className="password-dialog-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>

          {error && (
            <div className="password-dialog-error small">Incorrect password.</div>
          )}
        </div>

        <footer className="password-dialog-footer">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={password.length === 0}
          >
            Unlock
          </button>
        </footer>
      </form>
    </div>
  );
}
