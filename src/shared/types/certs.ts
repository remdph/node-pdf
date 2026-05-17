/**
 * Metadata about a stored signing certificate.
 *
 * The on-disk representation is always a password-encrypted PKCS#12 blob
 * (`.p12`); this struct exposes the pieces the UI needs to label and reason
 * about the cert without ever revealing the private key.
 */
export interface Certificate {
  id: string;
  /** User-visible label. Defaults to the subject CN at import time. */
  label: string;
  /** Subject CN — the canonical "who signed this" string. */
  subjectCN: string;
  /** Issuer CN — equals subjectCN for self-signed certs. */
  issuerCN: string;
  /** SHA-1 fingerprint of the DER cert, lowercase hex. */
  fingerprint: string;
  /** Cert serial number, lowercase hex. */
  serialNumber: string;
  /** ISO timestamp of the cert's notBefore. */
  validFrom: string;
  /** ISO timestamp of the cert's notAfter. */
  validTo: string;
  /** True when subject == issuer — we generated it ourselves. */
  isSelfSigned: boolean;
  /** When the cert was created or imported into NodePDF. */
  createdAt: string;
}

export interface GenerateCertInput {
  /** Subject Common Name. */
  commonName: string;
  /** Password used to encrypt the resulting PKCS#12. The user must
   * re-supply this on every signing operation; we never persist it. */
  password: string;
  /** Optional friendly label — falls back to `commonName`. */
  label?: string;
  /** Cert validity in years. Defaults to 5. */
  validityYears?: number;
  /** Optional subject attributes. Email is the most commonly requested. */
  emailAddress?: string;
  organizationName?: string;
  countryName?: string;
}

export interface ImportCertInput {
  /** Absolute path to the .p12 / .pfx on disk. */
  filePath: string;
  /** Password to decrypt the .p12. We re-encrypt nothing — the imported
   * blob is stored verbatim and this password is needed at sign time. */
  password: string;
  /** Optional user-friendly label override. */
  label?: string;
}
