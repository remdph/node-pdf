import { useEffect, useRef, useState } from 'react';

import type { PdfPermissions, ProtectInput } from '~shared/types/ipc.js';

interface ProtectDialogProps {
  /** Filename shown in the subtitle for context. */
  title?: string;
  /** Whether the PDF is currently encrypted — determines whether the
   * "Current password" field is shown and what actions are available. */
  encrypted: boolean;
  /** If we already know the unlock password (because the user typed it to
   * open the file), prefill it so they don't have to type it again. */
  knownCurrentPassword?: string;
  busy?: boolean;
  onSubmit(payload: Omit<ProtectInput, 'filePath'>): void;
  onCancel(): void;
}

const DEFAULT_PERMS: PdfPermissions = {
  printing: true,
  copying: true,
  modifying: true,
  annotating: true,
};

export function ProtectDialog({
  title,
  encrypted,
  knownCurrentPassword,
  busy,
  onSubmit,
  onCancel,
}: ProtectDialogProps): JSX.Element {
  const [currentPassword, setCurrentPassword] = useState(knownCurrentPassword ?? '');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [perms, setPerms] = useState<PdfPermissions>(DEFAULT_PERMS);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const mismatch = newPassword.length > 0 && confirm.length > 0 && newPassword !== confirm;
  const needsCurrent = encrypted && currentPassword.length === 0;
  const settingNew = newPassword.length > 0;
  const removing = encrypted && newPassword.length === 0 && confirm.length === 0;
  // Submit is allowed when either:
  //  - we're setting a new password (and confirmation matches), OR
  //  - we're removing (PDF encrypted, both new fields empty)
  const canSubmit =
    !busy && !needsCurrent && !mismatch && (settingNew || removing);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      currentPassword: encrypted ? currentPassword : undefined,
      newPassword: settingNew ? newPassword : '',
      permissions: settingNew ? perms : undefined,
    });
  };

  const togglePerm = (key: keyof PdfPermissions) =>
    setPerms((prev) => ({ ...prev, [key]: !prev[key] }));

  const heading = encrypted ? 'Manage protection' : 'Protect with password';
  const submitLabel = busy
    ? settingNew
      ? 'Encrypting…'
      : 'Removing…'
    : settingNew
      ? encrypted
        ? 'Change password'
        : 'Protect'
      : 'Remove protection';

  return (
    <div
      className="password-dialog-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <form
        className="password-dialog protect-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <header className="password-dialog-header">
          <div>
            <h2 className="password-dialog-title">{heading}</h2>
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
            disabled={busy}
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
          {encrypted && (
            <label className="password-dialog-field">
              <span className="password-dialog-label">Current password</span>
              <input
                ref={firstFieldRef}
                type="password"
                className="password-dialog-input"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                disabled={busy}
              />
            </label>
          )}

          <label className="password-dialog-field">
            <span className="password-dialog-label">
              {encrypted ? 'New password' : 'Password'}
            </span>
            <input
              ref={encrypted ? undefined : firstFieldRef}
              type="password"
              className="password-dialog-input"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder={encrypted ? 'Leave blank to remove protection' : ''}
              autoComplete="new-password"
              disabled={busy}
            />
          </label>

          {newPassword.length > 0 && (
            <label className="password-dialog-field">
              <span className="password-dialog-label">Confirm password</span>
              <input
                type="password"
                className="password-dialog-input"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                disabled={busy}
              />
            </label>
          )}

          {mismatch && (
            <div className="password-dialog-error small">Passwords don't match.</div>
          )}

          {settingNew && (
            <fieldset className="protect-perms" disabled={busy}>
              <legend className="password-dialog-label">Permissions</legend>
              <PermCheckbox
                label="Allow printing"
                checked={perms.printing}
                onChange={() => togglePerm('printing')}
              />
              <PermCheckbox
                label="Allow copying text"
                checked={perms.copying}
                onChange={() => togglePerm('copying')}
              />
              <PermCheckbox
                label="Allow modifying"
                checked={perms.modifying}
                onChange={() => togglePerm('modifying')}
              />
              <PermCheckbox
                label="Allow annotating"
                checked={perms.annotating}
                onChange={() => togglePerm('annotating')}
              />
            </fieldset>
          )}

          {removing && (
            <p className="muted small">
              Removing protection writes an unencrypted copy of the PDF.
            </p>
          )}
        </div>

        <footer className="password-dialog-footer">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!canSubmit}>
            {submitLabel}
          </button>
        </footer>
      </form>
    </div>
  );
}

interface PermCheckboxProps {
  label: string;
  checked: boolean;
  onChange(): void;
}

function PermCheckbox({ label, checked, onChange }: PermCheckboxProps): JSX.Element {
  return (
    <label className="protect-perm">
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}
