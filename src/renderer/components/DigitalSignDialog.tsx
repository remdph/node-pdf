import { useEffect, useState } from 'react';

import type { SignDigitalInput } from '~shared/types/signatures.js';

import { useCertsStore } from '../stores/certs.js';
import { useSettingsStore } from '../stores/settings.js';
import { useSignaturesStore } from '../stores/signatures.js';
import { CertificateManager } from './CertificateManager.js';

interface DigitalSignDialogProps {
  /** PDF being signed. */
  filePath: string;
  /** Informational only — encrypted PDFs are now supported via incremental
   * update, but we still surface a note to set expectations. */
  isEncrypted: boolean;
  onClose(): void;
  /** Two modes:
   *  - invisible (input.visualSignatureId omitted) → caller signs
   *    immediately; the dialog stays open until the IPC returns.
   *  - visible   (input.visualSignatureId set, pageIndex/rect omitted) →
   *    caller closes the dialog and arms a page-placement overlay; the
   *    actual signing happens once the user confirms placement.
   * The parent decides what to do based on whether visualSignatureId is
   * present in `input`. `lockForm` is a UI-only flag that asks the
   * caller to flatten the form (mode: 'flatten') before signing — only
   * meaningful when the PDF has pending form edits. */
  onSign(
    input: Omit<SignDigitalInput, 'filePath' | 'pageIndex' | 'rect'> & {
      lockForm?: boolean;
    },
  ): Promise<void>;
  /** Set while the sign IPC is in flight. */
  busy: boolean;
  /** When true the parent has pending form edits that will be flushed
   * to disk before the signature is applied. The dialog uses this to
   * surface a "Lock form fields" option so the user can choose
   * flatten (form locked, signature stays valid forever) vs keep
   * (form editable, future fills will void the sig in strict viewers). */
  hasDirtyForm?: boolean;
}

export function DigitalSignDialog({
  filePath,
  isEncrypted,
  onClose,
  onSign,
  busy,
  hasDirtyForm = false,
}: DigitalSignDialogProps): JSX.Element {
  const certs = useCertsStore((s) => s.certs);
  const loaded = useCertsStore((s) => s.loaded);
  const load = useCertsStore((s) => s.load);
  const signatures = useSignaturesStore((s) => s.signatures);
  const signaturesLoaded = useSignaturesStore((s) => s.loaded);
  const loadSignatures = useSignaturesStore((s) => s.load);
  const settings = useSettingsStore((s) => s.settings);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const loadSettings = useSettingsStore((s) => s.load);
  const updateSettings = useSettingsStore((s) => s.update);

  const [certId, setCertId] = useState<string>('');
  const [certPassword, setCertPassword] = useState('');
  const [reason, setReason] = useState('');
  const [location, setLocation] = useState('');
  const [contactInfo, setContactInfo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  // Visible-appearance toggle + pick. When empty, the signature is invisible
  // (only shows in the viewer's Signatures panel).
  const [visibleMode, setVisibleMode] = useState(false);
  const [visualSignatureId, setVisualSignatureId] = useState<string>('');
  // RFC 3161 TSA toggle. Off by default; once turned on we use the URL from
  // settings (FreeTSA by default — see DEFAULT_SETTINGS in src/shared/types/settings).
  const [useTimestamp, setUseTimestamp] = useState(false);
  // Local editable copy of the TSA URL so the user can override the global
  // setting just for this signing — the change persists to settings when
  // they actually sign, not on every keystroke.
  const [tsaUrlInput, setTsaUrlInput] = useState('');
  // PAdES-LT: embed cert chain + OCSP response so verifiers can validate
  // the sig OFFLINE for years. Off by default since it requires network
  // (and slows signing by the OCSP round-trip).
  const [embedRevocation, setEmbedRevocation] = useState(false);
  // When `hasDirtyForm` is set the parent will flush pending form edits
  // before signing. `lockForm` asks for a flatten-save instead of the
  // default keep-save: the form becomes uneditable but the signature
  // can never be invalidated by a later fill. Off by default — most
  // users want to keep their form editable.
  const [lockForm, setLockForm] = useState(false);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  useEffect(() => {
    if (!signaturesLoaded) void loadSignatures();
  }, [signaturesLoaded, loadSignatures]);

  useEffect(() => {
    if (!settingsLoaded) void loadSettings();
  }, [settingsLoaded, loadSettings]);

  // Seed the editable TSA URL from the persisted setting once loaded.
  useEffect(() => {
    if (settingsLoaded && !tsaUrlInput) {
      setTsaUrlInput(settings.tsaUrl);
    }
  }, [settingsLoaded, settings.tsaUrl, tsaUrlInput]);

  // Auto-select the first cert once they're available.
  useEffect(() => {
    if (!certId && certs.length > 0) {
      setCertId(certs[0]!.id);
    }
  }, [certs, certId]);

  // Auto-select the first visual signature when entering visible mode.
  useEffect(() => {
    if (visibleMode && !visualSignatureId && signatures.length > 0) {
      setVisualSignatureId(signatures[0]!.id);
    }
  }, [visibleMode, visualSignatureId, signatures]);

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
    if (visibleMode && !visualSignatureId) {
      setError(
        'Pick a signature image, or uncheck "Add visible appearance" for an invisible signature',
      );
      return;
    }
    if (useTimestamp && !tsaUrlInput.trim()) {
      setError('TSA URL is required when timestamping is enabled');
      return;
    }
    try {
      // Persist the TSA URL if the user edited it — next signing will use
      // the same value without re-prompting.
      if (useTimestamp && tsaUrlInput.trim() !== settings.tsaUrl) {
        await updateSettings({ tsaUrl: tsaUrlInput.trim() });
      }
      await onSign({
        certId,
        certPassword,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(location.trim() ? { location: location.trim() } : {}),
        ...(contactInfo.trim() ? { contactInfo: contactInfo.trim() } : {}),
        ...(visibleMode && visualSignatureId ? { visualSignatureId } : {}),
        ...(useTimestamp && tsaUrlInput.trim() ? { tsaUrl: tsaUrlInput.trim() } : {}),
        ...(embedRevocation ? { embedRevocationInfo: true } : {}),
        ...(hasDirtyForm && lockForm ? { lockForm: true } : {}),
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
                style={{ color: '#facc15' }}
              >
                This PDF is password-protected. The signature will be
                appended as an incremental update — the existing encrypted
                content remains untouched and its protection stays intact.
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
                  disabled={busy}
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
                disabled={busy || certs.length === 0}
                autoFocus
                required={certs.length > 0}
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
                disabled={busy}
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
                disabled={busy}
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
                disabled={busy}
              />
            </label>

            <div className="cert-field">
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  cursor: busy ? 'not-allowed' : 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={visibleMode}
                  onChange={(e) => setVisibleMode(e.target.checked)}
                  disabled={busy}
                />
                <span style={{ fontSize: '0.85rem', color: 'var(--fg)' }}>
                  Add visible appearance on the page
                </span>
              </label>
              {visibleMode && (
                signatures.length === 0 ? (
                  <div
                    className="signature-editor-hint"
                    style={{ color: '#facc15' }}
                  >
                    No saved signatures. Create one via the Signatures button
                    (cursive icon) in the toolbar first.
                  </div>
                ) : (
                  <select
                    className="signature-editor-select"
                    value={visualSignatureId}
                    onChange={(e) => setVisualSignatureId(e.target.value)}
                    disabled={busy}
                    style={{ width: '100%', marginTop: '0.4rem' }}
                  >
                    {signatures.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label} ({s.kind})
                      </option>
                    ))}
                  </select>
                )
              )}
              {visibleMode && (
                <div className="signature-editor-hint" style={{ marginTop: '0.3rem' }}>
                  After clicking Continue, drag/resize the signature on the
                  current page, then confirm.
                </div>
              )}
            </div>

            <div className="cert-field">
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  cursor: busy ? 'not-allowed' : 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={useTimestamp}
                  onChange={(e) => setUseTimestamp(e.target.checked)}
                  disabled={busy}
                />
                <span style={{ fontSize: '0.85rem', color: 'var(--fg)' }}>
                  Add trusted timestamp (PAdES-T)
                </span>
              </label>
              {useTimestamp && (
                <>
                  <input
                    type="url"
                    className="signature-editor-input"
                    placeholder="https://freetsa.org/tsr"
                    value={tsaUrlInput}
                    onChange={(e) => setTsaUrlInput(e.target.value)}
                    disabled={busy}
                    style={{ marginTop: '0.4rem' }}
                  />
                  <div className="signature-editor-hint" style={{ marginTop: '0.3rem' }}>
                    Contacts an RFC 3161 Timestamp Authority. Keeps the
                    signature verifiable after the cert expires. Requires
                    internet access at sign time.
                  </div>
                </>
              )}
            </div>

            <div className="cert-field">
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  cursor: busy ? 'not-allowed' : 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={embedRevocation}
                  onChange={(e) => setEmbedRevocation(e.target.checked)}
                  disabled={busy}
                />
                <span style={{ fontSize: '0.85rem', color: 'var(--fg)' }}>
                  Embed revocation info for offline verification (PAdES-LT)
                </span>
              </label>
              {embedRevocation && (
                <div className="signature-editor-hint" style={{ marginTop: '0.3rem' }}>
                  Fetches the cert&apos;s OCSP response right now and embeds
                  it (plus the full cert chain) into the document&apos;s
                  /DSS. Verifiers can then check revocation OFFLINE for
                  years to come, even if the OCSP responder is gone.
                </div>
              )}
            </div>

            {hasDirtyForm && (
              <div className="cert-field">
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    cursor: busy ? 'not-allowed' : 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={lockForm}
                    onChange={(e) => setLockForm(e.target.checked)}
                    disabled={busy}
                  />
                  <span style={{ fontSize: '0.85rem', color: 'var(--fg)' }}>
                    Lock form fields before signing
                  </span>
                </label>
                <div className="signature-editor-hint" style={{ marginTop: '0.3rem' }}>
                  {lockForm
                    ? 'Form values will be flattened into the page graphics before the signature is applied. The form becomes uneditable, but the signature can never be invalidated by a later fill.'
                    : 'Form stays editable. The signature will cover the current form values; any later fill creates an incremental change that strict verifiers may flag as "modified after signing".'}
                </div>
              </div>
            )}

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
                disabled={
                  busy ||
                  certs.length === 0 ||
                  !certId ||
                  (visibleMode && (!visualSignatureId || signatures.length === 0))
                }
              >
                {busy
                  ? 'Signing…'
                  : visibleMode
                    ? 'Continue to place'
                    : 'Sign'}
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
