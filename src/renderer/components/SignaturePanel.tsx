import type { ExistingSignatureInfo } from '~shared/types/signatures.js';

interface SignaturePanelProps {
  signatures: ExistingSignatureInfo[];
  loading: boolean;
  onClose(): void;
}

const INTEGRITY_TEXT: Record<ExistingSignatureInfo['integrity'], string> = {
  untampered:
    'Hash verified and CMS signature checks out — bytes intact since signing',
  'modified-after':
    'Signed bytes intact, but content was appended after the signature',
  invalid:
    'Signature verification failed — content or CMS was altered',
  unknown:
    'Could not fully verify (CMS parse incomplete)',
};

/** SubFilters we know how to verify end-to-end. Anything else lands on the
 * generic "format not supported" reason instead of a CMS-shaped error
 * message that wouldn't apply. */
const SUPPORTED_SUBFILTERS = new Set([
  // CMS / PKCS#7 family (parseCms path)
  'adbe.pkcs7.detached',
  'adbe.pkcs7.sha1',
  'ETSI.CAdES.detached',
  // Pre-PKCS#7 raw RSA format (parseLegacyRsaX509 path)
  'adbe.x509.rsa_sha1',
]);

/** Returns a more helpful unknown-status message when the subFilter is one
 * of the formats we don't speak (e.g. the pre-PKCS#7 `adbe.x509.rsa_sha1`,
 * or RFC 3161 timestamps). Falls back to the generic message otherwise. */
function unknownReason(subFilter: string): string {
  if (!subFilter) return INTEGRITY_TEXT.unknown;
  if (SUPPORTED_SUBFILTERS.has(subFilter)) return INTEGRITY_TEXT.unknown;
  return `Unsupported signature format: ${subFilter} — verification of this signature kind isn't implemented in this version`;
}

function formatDate(iso: string | null): string {
  if (!iso) return 'Unknown date';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatDateOnly(iso: string | null): string {
  if (!iso) return 'Unknown';
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

/** Compute the user-facing line for the temporal-validity dimension.
 * Returns `null` when there's nothing meaningful to say (no validity dates
 * at all). The two booleans frame a clear policy:
 *
 *  - validAtSigning + validNow  → "Valid through {to}"          (default OK)
 *  - validAtSigning + !validNow → "Was valid at signing; expired {to}"
 *    This is the long-term validation (LTV) case — historical signature is
 *    still meaningful even though the cert is past notAfter today.
 *  - !validAtSigning            → "Cert was not valid at the time of signing"
 *    (signed before notBefore or after notAfter — should not happen for
 *    a well-behaved signer; flagged red.)
 */
function temporalLine(sig: ExistingSignatureInfo): {
  text: string;
  color: string;
} | null {
  if (!sig.validFrom || !sig.validTo) return null;
  const range = `${formatDateOnly(sig.validFrom)} – ${formatDateOnly(sig.validTo)}`;

  if (sig.validAtSigning === false) {
    return {
      text: `Validity: cert was NOT valid at signing time (${range})`,
      color: 'var(--danger)',
    };
  }
  if (sig.expiredNow) {
    // Cert is past notAfter today, but the signature was still made within
    // the cert's window — this is the PAdES long-term-validation scenario.
    return {
      text: `Validity: cert was valid at signing; expired ${formatDateOnly(
        sig.validTo,
      )} (historical signature remains verifiable)`,
      color: '#facc15',
    };
  }
  return {
    text: `Validity: cert valid through ${formatDateOnly(sig.validTo)}`,
    color: 'var(--fg-muted)',
  };
}

/** Render the trust-chain verdict. Four shapes:
 *
 *  - trusted     → green-ish line citing the trusted root CA
 *  - self-signed → yellow line, calls out lack of third-party verification
 *  - untrusted   → yellow line, issuer present but not in Mozilla bundle
 *  - unknown     → muted line, parser failure
 */
function trustLine(sig: ExistingSignatureInfo): { text: string; color: string } {
  switch (sig.trustStatus) {
    case 'trusted':
      return {
        text: `Trust: chains to trusted root${
          sig.trustedRootCN ? ` (${sig.trustedRootCN})` : ''
        }`,
        color: '#4ade80',
      };
    case 'self-signed':
      return {
        text: 'Trust: self-signed — identity not verified by a third party',
        color: '#facc15',
      };
    case 'untrusted':
      return {
        text: `Trust: issued by ${
          sig.issuerCN ?? 'unknown CA'
        } — chain does not reach a trusted root`,
        color: '#facc15',
      };
    case 'unknown':
    default:
      return {
        text: 'Trust: could not determine (cert chain unavailable)',
        color: 'var(--fg-muted)',
      };
  }
}

/** Render the OCSP revocation verdict. Four shapes — keep parallel to the
 * other dimension renderers so the panel reads as one consistent story. */
function revocationLine(sig: ExistingSignatureInfo): {
  text: string;
  color: string;
} | null {
  switch (sig.revocationStatus) {
    case 'good':
      return {
        text: 'Revocation: cert is in good standing per OCSP responder',
        color: '#4ade80',
      };
    case 'revoked': {
      const parts = ['Revocation: cert was REVOKED'];
      if (sig.revokedAt) {
        try {
          parts.push(`on ${new Date(sig.revokedAt).toLocaleDateString()}`);
        } catch {
          parts.push(`on ${sig.revokedAt}`);
        }
      }
      if (sig.revocationReason) parts.push(`(${sig.revocationReason})`);
      return { text: parts.join(' '), color: 'var(--danger)' };
    }
    case 'unknown':
      return {
        text: 'Revocation: OCSP responder didn’t recognize this cert',
        color: '#facc15',
      };
    case 'unchecked':
    default:
      // Don't pollute the panel for cases where there was simply nothing to
      // check (self-signed, no AIA URL, no network). Returning null hides
      // the line entirely.
      return null;
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
          signatures.map((sig, idx) => {
            const temporal = temporalLine(sig);
            const trust = trustLine(sig);
            const revocation = revocationLine(sig);
            return (
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
                    {sig.trustStatus === 'trusted' && (
                      <span
                        className="signature-row-badge"
                        style={{
                          borderColor: 'rgba(74, 222, 128, 0.55)',
                          color: '#4ade80',
                        }}
                        title="Cert chains to a Mozilla-trusted root CA"
                      >
                        Trusted
                      </span>
                    )}
                    {sig.isSelfSigned && (
                      <span
                        className="signature-row-badge"
                        style={{
                          borderColor: 'rgba(250, 204, 21, 0.55)',
                          color: '#facc15',
                        }}
                        title="Self-signed: identity is not verified by a third party"
                      >
                        Self-signed
                      </span>
                    )}
                    {sig.expiredNow && (
                      <span
                        className="signature-row-badge"
                        style={{
                          borderColor: 'rgba(250, 204, 21, 0.55)',
                          color: '#facc15',
                        }}
                        title="Cert's notAfter is in the past today"
                      >
                        Expired
                      </span>
                    )}
                    {sig.revocationStatus === 'revoked' && (
                      <span
                        className="signature-row-badge"
                        style={{
                          borderColor: 'rgba(255, 107, 107, 0.6)',
                          color: 'var(--danger)',
                        }}
                        title="OCSP responder reports this cert was revoked by the CA"
                      >
                        Revoked
                      </span>
                    )}
                  </span>
                </div>
                <span
                  className="signature-row-meta"
                  // Red when the CMS hash check failed — this is the
                  // "the document was tampered with after signing"
                  // case and deserves visual urgency that the
                  // muted-meta default doesn't convey.
                  style={
                    sig.integrity === 'invalid'
                      ? { color: 'var(--danger)' }
                      : undefined
                  }
                >
                  {sig.integrity === 'unknown'
                    ? unknownReason(sig.subFilter)
                    : INTEGRITY_TEXT[sig.integrity]}
                </span>
                {temporal && (
                  <span
                    className="signature-row-meta"
                    style={{ color: temporal.color }}
                  >
                    {temporal.text}
                  </span>
                )}
                <span
                  className="signature-row-meta"
                  style={{ color: trust.color }}
                >
                  {trust.text}
                </span>
                {revocation && (
                  <span
                    className="signature-row-meta"
                    style={{ color: revocation.color }}
                  >
                    {revocation.text}
                  </span>
                )}
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
            );
          })
        )}
      </div>
    </div>
  );
}
