import type { ExistingSignatureInfo } from '~shared/types/signatures.js';

interface SignaturePanelProps {
  signatures: ExistingSignatureInfo[];
  loading: boolean;
  onClose(): void;
}

const STATUS_TEXT: Record<ExistingSignatureInfo['integrity'], string> = {
  untampered: 'Valid — document untouched since signing',
  'modified-after': 'Valid for its range, but document was modified afterwards',
  invalid: 'Invalid — content changed after signing',
  unknown: 'Could not verify this signature',
};

function formatDate(iso: string | null): string {
  if (!iso) return 'Unknown date';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function SignaturePanel({
  signatures,
  loading,
  onClose,
}: SignaturePanelProps): JSX.Element {
  return (
    <div className="side-panel is-open" role="complementary" aria-label="Signatures">
      <div className="side-panel-header">
        <span className="side-panel-title">
          Signatures{signatures.length > 0 ? ` (${signatures.length})` : ''}
        </span>
        <button
          type="button"
          className="side-panel-close"
          onClick={onClose}
          aria-label="Close signatures panel"
        >
          ×
        </button>
      </div>
      <div className="side-panel-body">
        {loading ? (
          <p className="muted small">Inspecting signatures…</p>
        ) : signatures.length === 0 ? (
          <p className="muted small">This document has no embedded signatures.</p>
        ) : (
          signatures.map((sig, idx) => (
            <div className="signature-row" key={`${sig.fieldName}-${idx}`}>
              <div className="signature-row-head">
                <span
                  className={`signature-row-status is-${sig.integrity}`}
                  aria-hidden
                />
                <span className="signature-row-name">
                  {sig.signerName ?? 'Unknown signer'}
                  {sig.isCertification && (
                    <span className="signature-row-badge">Certification</span>
                  )}
                </span>
              </div>
              <span className="signature-row-meta">{STATUS_TEXT[sig.integrity]}</span>
              <span className="signature-row-meta">
                Field: <strong>{sig.fieldName}</strong>
              </span>
              <span className="signature-row-meta">
                Signed: {formatDate(sig.signedAt)}
              </span>
              {sig.subFilter && (
                <span className="signature-row-meta">Filter: {sig.subFilter}</span>
              )}
              {sig.reason && (
                <span className="signature-row-meta">Reason: {sig.reason}</span>
              )}
              {sig.location && (
                <span className="signature-row-meta">Location: {sig.location}</span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
