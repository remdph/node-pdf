import { useEffect, useState } from 'react';

import type { Certificate } from '~shared/types/certs.js';

import { useCertsStore } from '../stores/certs.js';

type Tab = 'list' | 'generate' | 'import';

interface CertificateManagerProps {
  onClose(): void;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

function isExpired(cert: Certificate): boolean {
  return new Date(cert.validTo).getTime() < Date.now();
}

export function CertificateManager({ onClose }: CertificateManagerProps): JSX.Element {
  const certs = useCertsStore((s) => s.certs);
  const loaded = useCertsStore((s) => s.loaded);
  const load = useCertsStore((s) => s.load);
  const generate = useCertsStore((s) => s.generate);
  const pickFile = useCertsStore((s) => s.pickFile);
  const importFromPath = useCertsStore((s) => s.importFromPath);
  const remove = useCertsStore((s) => s.remove);

  const [tab, setTab] = useState<Tab>('list');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Generate form state
  const [genCN, setGenCN] = useState('');
  const [genEmail, setGenEmail] = useState('');
  const [genOrg, setGenOrg] = useState('');
  const [genCountry, setGenCountry] = useState('');
  const [genValidity, setGenValidity] = useState(5);
  const [genPassword, setGenPassword] = useState('');
  const [genPasswordConfirm, setGenPasswordConfirm] = useState('');

  // Import form state
  const [importPath, setImportPath] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [importLabel, setImportLabel] = useState('');

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  // Land on the empty list tab by default; the empty state has a CTA that
  // jumps to the right tab. We intentionally do NOT auto-redirect on every
  // render — that would make clicking "My certificates" with 0 certs feel
  // broken (the user clicks, the redirect bounces them back).

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!genCN.trim()) {
      setError('Common Name is required');
      return;
    }
    if (genPassword.length < 4) {
      setError('Password must be at least 4 characters');
      return;
    }
    if (genPassword !== genPasswordConfirm) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await generate({
        commonName: genCN.trim(),
        password: genPassword,
        validityYears: genValidity,
        ...(genEmail.trim() ? { emailAddress: genEmail.trim() } : {}),
        ...(genOrg.trim() ? { organizationName: genOrg.trim() } : {}),
        ...(genCountry.trim() ? { countryName: genCountry.trim() } : {}),
      });
      setGenCN('');
      setGenEmail('');
      setGenOrg('');
      setGenCountry('');
      setGenPassword('');
      setGenPasswordConfirm('');
      setTab('list');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePickP12 = async () => {
    setError(null);
    try {
      const p = await pickFile();
      if (p) setImportPath(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!importPath) {
      setError('Pick a .p12 / .pfx file first');
      return;
    }
    if (!importPassword) {
      setError('PKCS#12 password is required');
      return;
    }
    setBusy(true);
    try {
      await importFromPath(
        importPath,
        importPassword,
        importLabel.trim() || undefined,
      );
      setImportPath('');
      setImportPassword('');
      setImportLabel('');
      setTab('list');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (id: string) => {
    if (!confirm('Remove this certificate? The .p12 file will be deleted.')) return;
    setBusy(true);
    try {
      await remove(id);
    } catch (err) {
      console.error('[CertificateManager] remove failed', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="signature-editor-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="signature-editor"
        role="dialog"
        aria-label="Certificate manager"
        style={{ width: 640 }}
      >
        <div className="signature-editor-header">
          <span className="signature-editor-title">Certificates</span>
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

        <div className="signature-editor-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'list'}
            className={`signature-editor-tab${tab === 'list' ? ' is-active' : ''}`}
            onClick={() => setTab('list')}
          >
            My certificates{certs.length > 0 ? ` (${certs.length})` : ''}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'generate'}
            className={`signature-editor-tab${tab === 'generate' ? ' is-active' : ''}`}
            onClick={() => setTab('generate')}
          >
            Generate new
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'import'}
            className={`signature-editor-tab${tab === 'import' ? ' is-active' : ''}`}
            onClick={() => setTab('import')}
          >
            Import .p12
          </button>
        </div>

        <div className="signature-editor-body">
          {tab === 'list' && (
            <>
              {!loaded ? (
                <p className="muted small">Loading certificates…</p>
              ) : certs.length === 0 ? (
                <div
                  className="cert-empty"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '0.75rem',
                    padding: '1.5rem 0.5rem',
                    textAlign: 'center',
                  }}
                >
                  <p className="muted small" style={{ margin: 0 }}>
                    You don&apos;t have any signing certificates yet.
                  </p>
                  <div className="signature-editor-row" style={{ justifyContent: 'center' }}>
                    <button
                      type="button"
                      className="signature-editor-btn is-primary"
                      onClick={() => setTab('generate')}
                    >
                      Generate self-signed
                    </button>
                    <button
                      type="button"
                      className="signature-editor-btn"
                      onClick={() => setTab('import')}
                    >
                      Import .p12
                    </button>
                  </div>
                </div>
              ) : (
                <div className="cert-list">
                  {certs.map((c) => (
                    <div className="cert-row" key={c.id}>
                      <div className="cert-row-main">
                        <div className="cert-row-name">
                          {c.label}
                          {c.isSelfSigned && (
                            <span className="signature-row-badge">Self-signed</span>
                          )}
                          {isExpired(c) && (
                            <span
                              className="signature-row-badge"
                              style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
                            >
                              Expired
                            </span>
                          )}
                        </div>
                        <div className="cert-row-meta">CN: {c.subjectCN}</div>
                        <div className="cert-row-meta">
                          Issuer: {c.issuerCN}
                        </div>
                        <div className="cert-row-meta">
                          Valid {formatDate(c.validFrom)} – {formatDate(c.validTo)}
                        </div>
                        <div
                          className="cert-row-meta"
                          style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.7rem' }}
                        >
                          {c.fingerprint}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="signature-editor-btn"
                        onClick={() => handleRemove(c.id)}
                        disabled={busy}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {tab === 'generate' && (
            <form onSubmit={handleGenerate} className="cert-form">
              <div className="signature-editor-hint">
                Creates an RSA-2048 self-signed certificate and stores it as
                a password-encrypted PKCS#12 in your local profile.
              </div>
              <label className="cert-field">
                <span>Common Name (required)</span>
                <input
                  type="text"
                  className="signature-editor-input"
                  placeholder="Your full name or organization"
                  value={genCN}
                  onChange={(e) => setGenCN(e.target.value)}
                  required
                  autoFocus
                />
              </label>
              <label className="cert-field">
                <span>Email</span>
                <input
                  type="email"
                  className="signature-editor-input"
                  placeholder="you@example.com"
                  value={genEmail}
                  onChange={(e) => setGenEmail(e.target.value)}
                />
              </label>
              <label className="cert-field">
                <span>Organization</span>
                <input
                  type="text"
                  className="signature-editor-input"
                  value={genOrg}
                  onChange={(e) => setGenOrg(e.target.value)}
                />
              </label>
              <label className="cert-field">
                <span>Country (2-letter code)</span>
                <input
                  type="text"
                  className="signature-editor-input"
                  maxLength={2}
                  value={genCountry}
                  onChange={(e) => setGenCountry(e.target.value.toUpperCase())}
                />
              </label>
              <label className="cert-field">
                <span>Validity (years)</span>
                <input
                  type="number"
                  className="signature-editor-input"
                  min={1}
                  max={20}
                  value={genValidity}
                  onChange={(e) => setGenValidity(Number(e.target.value) || 1)}
                />
              </label>
              <label className="cert-field">
                <span>Password (required to sign)</span>
                <input
                  type="password"
                  className="signature-editor-input"
                  value={genPassword}
                  onChange={(e) => setGenPassword(e.target.value)}
                  required
                />
              </label>
              <label className="cert-field">
                <span>Confirm password</span>
                <input
                  type="password"
                  className="signature-editor-input"
                  value={genPasswordConfirm}
                  onChange={(e) => setGenPasswordConfirm(e.target.value)}
                  required
                />
              </label>
              {error && (
                <div className="signature-editor-hint" style={{ color: 'var(--danger)' }}>
                  {error}
                </div>
              )}
              <div className="signature-editor-footer" style={{ borderTop: 'none', padding: 0 }}>
                <button
                  type="submit"
                  className="signature-editor-btn is-primary"
                  disabled={busy}
                >
                  {busy ? 'Generating…' : 'Generate certificate'}
                </button>
              </div>
            </form>
          )}

          {tab === 'import' && (
            <form onSubmit={handleImport} className="cert-form">
              <div className="signature-editor-hint">
                Import an existing PKCS#12 (.p12 or .pfx) — for example, your
                eIDAS / FIEL / Adobe-issued cert. The file is stored as-is;
                you&apos;ll need to enter its password every time you sign.
              </div>
              <div className="cert-field">
                <span>PKCS#12 file</span>
                <div className="signature-editor-row">
                  <input
                    type="text"
                    className="signature-editor-input"
                    placeholder="Click 'Choose file' to pick a .p12/.pfx"
                    value={importPath}
                    readOnly
                  />
                  <button
                    type="button"
                    className="signature-editor-btn"
                    onClick={handlePickP12}
                    disabled={busy}
                  >
                    Choose file…
                  </button>
                </div>
              </div>
              <label className="cert-field">
                <span>PKCS#12 password</span>
                <input
                  type="password"
                  className="signature-editor-input"
                  value={importPassword}
                  onChange={(e) => setImportPassword(e.target.value)}
                  required
                />
              </label>
              <label className="cert-field">
                <span>Label (optional)</span>
                <input
                  type="text"
                  className="signature-editor-input"
                  placeholder="Defaults to subject CN"
                  value={importLabel}
                  onChange={(e) => setImportLabel(e.target.value)}
                />
              </label>
              {error && (
                <div className="signature-editor-hint" style={{ color: 'var(--danger)' }}>
                  {error}
                </div>
              )}
              <div className="signature-editor-footer" style={{ borderTop: 'none', padding: 0 }}>
                <button
                  type="submit"
                  className="signature-editor-btn is-primary"
                  disabled={busy || !importPath}
                >
                  {busy ? 'Importing…' : 'Import certificate'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
