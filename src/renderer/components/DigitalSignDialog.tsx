import { useEffect, useState } from 'react';

import type { SignDigitalInput } from '~shared/types/signatures.js';

import { useCertsStore } from '../stores/certs.js';
import { CertificateManager } from './CertificateManager.js';

interface DigitalSignDialogProps {
  /** Pre-checked PDF path — caller has already validated it's not encrypted. */
  filePath: string;
  /** True if the PDF is currently encrypted; we disable signing in that
   * case and show a helpful message. */
  isEncrypted: boolean;
  onClose(): void;
  onSign(input: Omit<SignDigitalInput, 'filePath'>): Promise<void>;
  /** Set while the sign IPC is in flight. */
  busy: boolean;
}

export function DigitalSignDialog({
  filePath,
  isEncrypted,
  onClose,
  onSign,
  busy,
}: DigitalSignDialogProps): JSX.Element {
  const certs = useCertsStore((s) => s.certs);
  const loaded = useCertsStore((s) => s.loaded);
  const load = useCertsStore((s) => s.load);

  const [certId, setCertId] = useState<string>('');
  const [certPassword, setCertPassword] = useState('');
  const [reason, setReason] = useState('');
  const [location, setLocation] = useState('');
  const [contactInfo, setContactInfo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  // Auto-select the first cert once they're available.
  useEffect(() => {
    if (!certId && certs.length > 0) {
      setCertId(certs[0]!.id);
    }
  }, [certs, certId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy && !managerOpen) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy, managerOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!certId) {
      setError('Pick a certificate first');
      return;
    }
    if (!certPassword) {
      setError('Certificate password is required');
      return;
    }
    try {
      await onSign({
        certId,
        certPassword,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(location.trim() ? { location: location.trim() } : {}),
        ...(contactInfo.trim() ? { contactInfo: contactInfo.trim() } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;

  return (
    <>
      <div
        className="signature-editor-backdrop"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget && !busy) onClose();
        }}
      >
        <div
          className="signature-editor"
          role="dialog"
          aria-label="Digital signature"
          style={{ width: 520 }}
        >
          <div className="signature-editor-header">
            <span className="signature-editor-title">Digitally sign</span>
            <button
              type="button"
              className="signature-editor-close"
              onClick={onClose}
              disabled={busy}
              aria-label="Close"
            >
              ×
            </button>
          </div>

          <form onSubmit={handleSubmit} className="signature-editor-body">
            <div className="signature-editor-hint">
              Will embed a PKCS#7 signature in <strong>{fileName}</strong>.
              The signature can be verified in any PDF viewer that supports
              cryptographic signatures.
            </div>

            {isEncrypted && (
              <div
                className="signature-editor-hint"
                style={{ color: 'var(--danger)' }}
              >
                Cannot digitally sign an encrypted PDF in this version.
                Remove the password (Protect dialog) first, sign, then
                re-apply protection.
              </div>
            )}

            <div className="cert-field">
              <div className="signature-editor-row">
                <span style={{ minWidth: 0, flex: 1 }}>Certificate</span>
                <button
                  type="button"
                  className="signature-editor-btn"
                  onClick={() => setManagerOpen(true)}
                  disabled={busy}
                  style={{ padding: '0.2rem 0.6rem' }}
                >
                  Manage…
                </button>
              </div>
              {certs.length === 0 ? (
                <div className="signature-editor-hint">
                  No certificates yet. Click <strong>Manage…</strong> to
                  generate or import one.
                </div>
              ) : (
                <select
                  className="signature-editor-select"
                  value={certId}
                  onChange={(e) => setCertId(e.target.value)}
                  disabled={busy || isEncrypted}
                  style={{ width: '100%' }}
                >
                  {certs.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label} — {c.subjectCN}
                      {c.isSelfSigned ? ' (self-signed)' : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <label className="cert-field">
              <span>Password for this certificate</span>
              <input
                type="password"
                className="signature-editor-input"
                value={certPassword}
                onChange={(e) => setCertPassword(e.target.value)}
                disabled={busy || isEncrypted || certs.length === 0}
                autoFocus
                required={!isEncrypted && certs.length > 0}
              />
            </label>

            <label className="cert-field">
              <span>Reason (optional)</span>
              <input
                type="text"
                className="signature-editor-input"
                placeholder="e.g. Approved by"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={busy || isEncrypted}
              />
            </label>

            <label className="cert-field">
              <span>Location (optional)</span>
              <input
                type="text"
                className="signature-editor-input"
                placeholder="e.g. Madrid"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                disabled={busy || isEncrypted}
              />
            </label>

            <label className="cert-field">
              <span>Contact info (optional)</span>
              <input
                type="text"
                className="signature-editor-input"
                placeholder="e.g. email"
                value={contactInfo}
                onChange={(e) => setContactInfo(e.target.value)}
                disabled={busy || isEncrypted}
              />
            </label>

            {error && (
              <div className="signature-editor-hint" style={{ color: 'var(--danger)' }}>
                {error}
              </div>
            )}

            <div className="signature-editor-footer" style={{ borderTop: 'none', padding: 0 }}>
              <button
                type="button"
                className="signature-editor-btn"
                onClick={onClose}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="signature-editor-btn is-primary"
                disabled={busy || isEncrypted || certs.length === 0 || !certId}
              >
                {busy ? 'Signing…' : 'Sign'}
              </button>
            </div>
          </form>
        </div>
      </div>

      {managerOpen && (
        <CertificateManager onClose={() => setManagerOpen(false)} />
      )}
    </>
  );
}
