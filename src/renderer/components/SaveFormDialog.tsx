import { useEffect, useState } from 'react';

interface SaveFormDialogProps {
  busy: boolean;
  onClose(): void;
  /** Caller resolves with the saved mode so the dialog can close itself
   * AFTER the IPC write completes (and stay open with an error if it
   * throws). */
  onSave(mode: 'keep' | 'flatten'): Promise<void>;
}

/**
 * Confirmation dialog shown when the user clicks the toolbar Save
 * button on a form. Asks whether to save with fields still editable
 * (default — incremental save) or to lock the form by flattening
 * the values into page graphics. Defaults to "keep" because that's
 * the non-destructive choice; the user has to explicitly opt into
 * flatten by picking the second radio.
 *
 * The auto-save that runs before stamps / signatures uses the same
 * fillForm IPC under the hood but never prompts — it always picks
 * `keep` (or `flatten` when the cert-sign dialog's "Lock form" box
 * is checked). This dialog only fires for the explicit Save action.
 */
export function SaveFormDialog({ busy, onClose, onSave }: SaveFormDialogProps): JSX.Element {
  const [mode, setMode] = useState<'keep' | 'flatten'>('keep');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const submit = async () => {
    setError(null);
    try {
      await onSave(mode);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className="password-dialog-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="password-dialog save-form-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Save form"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="password-dialog-header settings-dialog-header">
          <h2 className="settings-dialog-title">Save form</h2>
          <button
            type="button"
            className="password-dialog-close"
            onClick={onClose}
            disabled={busy}
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

        <div className="password-dialog-body save-form-dialog-body">
          <label className="save-form-option">
            <input
              type="radio"
              name="save-form-mode"
              checked={mode === 'keep'}
              onChange={() => setMode('keep')}
              disabled={busy}
            />
            <div className="save-form-option-text">
              <div className="save-form-option-title">Keep editable</div>
              <div className="save-form-option-sub">
                Save the filled values. Fields stay editable for future
                fills, and signatures can still be applied later.
              </div>
            </div>
          </label>

          <label className="save-form-option">
            <input
              type="radio"
              name="save-form-mode"
              checked={mode === 'flatten'}
              onChange={() => setMode('flatten')}
              disabled={busy}
            />
            <div className="save-form-option-text">
              <div className="save-form-option-title">Lock form (flatten)</div>
              <div className="save-form-option-sub">
                Bake the values into the page graphics so nobody can
                modify them. The form becomes a read-only PDF.
                Existing signatures stay valid forever.
              </div>
            </div>
          </label>

          {error && (
            <div className="signature-editor-hint" style={{ color: 'var(--danger)' }}>
              {error}
            </div>
          )}
        </div>

        <footer className="signature-editor-footer" style={{ borderTop: 'none', padding: '0 1.25rem 1rem' }}>
          <button
            type="button"
            className="signature-editor-btn"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="signature-editor-btn is-primary"
            onClick={() => void submit()}
            disabled={busy}
          >
            {busy ? 'Saving…' : mode === 'flatten' ? 'Save and lock' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}
