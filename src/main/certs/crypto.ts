import { createHash, randomBytes } from 'node:crypto';

import forge from 'node-forge';

import { NodePdfError } from '~shared/types/errors.js';
import type { Certificate, GenerateCertInput } from '~shared/types/certs.js';

export interface ParsedP12 {
  cert: forge.pki.Certificate;
  /** PEM-encoded private key. Kept as PEM so callers can hand it back to
   * forge / node:crypto without re-handling forge's intermediate types. */
  keyPem: string;
}

/** Decrypt and parse a PKCS#12 blob. Throws `NodePdfError` with a friendly
 * message for the most common failure (wrong password). */
export function parseP12(p12Der: Uint8Array, password: string): ParsedP12 {
  let asn1: forge.asn1.Asn1;
  try {
    const binary = forge.util.createBuffer(
      Buffer.from(p12Der).toString('binary'),
    );
    asn1 = forge.asn1.fromDer(binary, false);
  } catch (err) {
    throw new NodePdfError('VALIDATION_ERROR', 'PKCS#12 file is not valid DER', err);
  }

  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, password);
  } catch (err) {
    // node-forge throws on wrong password — surface it cleanly.
    throw new NodePdfError(
      'VALIDATION_ERROR',
      'Wrong password or corrupted PKCS#12 file',
      err,
    );
  }

  let cert: forge.pki.Certificate | null = null;
  let key: forge.pki.PrivateKey | null = null;

  for (const safeContents of p12.safeContents) {
    for (const bag of safeContents.safeBags) {
      if (
        (bag.type === forge.pki.oids.keyBag ||
          bag.type === forge.pki.oids.pkcs8ShroudedKeyBag) &&
        bag.key
      ) {
        key = bag.key;
      } else if (bag.type === forge.pki.oids.certBag && bag.cert) {
        // Prefer the leaf cert (non-CA) if multiple are present. Common case
        // is exactly one cert though.
        if (!cert || !bag.cert.isIssuer(bag.cert)) cert = bag.cert;
      }
    }
  }

  if (!cert || !key) {
    throw new NodePdfError(
      'VALIDATION_ERROR',
      'PKCS#12 file does not contain both a certificate and a private key',
    );
  }

  return {
    cert,
    keyPem: forge.pki.privateKeyToPem(key),
  };
}

/** Compute SHA-1 fingerprint of a cert's DER, lowercase hex. The convention
 * matches what OpenSSL, Adobe and most viewers display. */
export function certFingerprint(cert: forge.pki.Certificate): string {
  const der = forge.asn1
    .toDer(forge.pki.certificateToAsn1(cert))
    .getBytes();
  const hash = createHash('sha1');
  hash.update(Buffer.from(der, 'binary'));
  return hash.digest('hex');
}

function getCN(attrs: forge.pki.CertificateField[]): string {
  for (const a of attrs) {
    if (a.shortName === 'CN' && typeof a.value === 'string') return a.value;
  }
  // Fall back to any DN component so the UI doesn't show "null".
  for (const a of attrs) {
    if (typeof a.value === 'string') return a.value;
  }
  return '(unnamed)';
}

/** Build a UI-friendly metadata record from a parsed cert. */
export function certMetadata(
  cert: forge.pki.Certificate,
  id: string,
  label: string,
  isSelfSigned: boolean,
): Omit<Certificate, 'createdAt'> {
  return {
    id,
    label,
    subjectCN: getCN(cert.subject.attributes),
    issuerCN: getCN(cert.issuer.attributes),
    fingerprint: certFingerprint(cert),
    serialNumber: cert.serialNumber.toLowerCase(),
    validFrom: cert.validity.notBefore.toISOString(),
    validTo: cert.validity.notAfter.toISOString(),
    isSelfSigned,
  };
}

/**
 * Generate a self-signed RSA 2048 cert + key and wrap it in a password-
 * encrypted PKCS#12 blob. Returns both the PKCS#12 DER bytes (to persist)
 * and the parsed cert (to derive metadata).
 *
 * The cert claims Code Signing + Document Signing extended key usages so
 * Adobe Reader recognises it as a signing cert (it'll still show
 * "validity unknown" because the root isn't in AATL — that's expected for
 * personal self-signed certs). */
export function generateSelfSignedP12(input: GenerateCertInput): {
  p12Der: Uint8Array;
  cert: forge.pki.Certificate;
} {
  const validityYears = input.validityYears ?? 5;
  if (validityYears < 1 || validityYears > 20) {
    throw new NodePdfError('VALIDATION_ERROR', 'Validity must be 1–20 years');
  }
  if (!input.commonName.trim()) {
    throw new NodePdfError('VALIDATION_ERROR', 'Common Name is required');
  }

  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  // Per RFC 5280 the serial should be a positive integer ≤ 20 octets. forge
  // wants a hex string; 16 random bytes gives us 128 bits of uniqueness.
  cert.serialNumber = randomBytes(16).toString('hex');
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(
    cert.validity.notBefore.getFullYear() + validityYears,
  );

  const attrs: forge.pki.CertificateField[] = [
    { name: 'commonName', value: input.commonName.trim() },
  ];
  if (input.organizationName) {
    attrs.push({ name: 'organizationName', value: input.organizationName });
  }
  if (input.countryName) {
    attrs.push({ name: 'countryName', value: input.countryName });
  }
  if (input.emailAddress) {
    attrs.push({ name: 'emailAddress', value: input.emailAddress });
  }
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  cert.setExtensions([
    {
      name: 'basicConstraints',
      cA: false,
    },
    {
      name: 'keyUsage',
      digitalSignature: true,
      nonRepudiation: true,
      keyEncipherment: true,
    },
    {
      name: 'extKeyUsage',
      // 1.3.6.1.5.5.7.3.36 = id-kp-documentSigning. forge has a short name
      // for codeSigning but not documentSigning — pass the OID directly.
      codeSigning: true,
      emailProtection: true,
    },
    {
      name: 'subjectKeyIdentifier',
    },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(
    keys.privateKey,
    [cert],
    input.password,
    {
      friendlyName: input.label?.trim() || input.commonName.trim(),
      algorithm: '3des',
    },
  );
  const der = forge.asn1.toDer(p12Asn1).getBytes();
  const p12Der = new Uint8Array(der.length);
  for (let i = 0; i < der.length; i++) p12Der[i] = der.charCodeAt(i) & 0xff;

  return { p12Der, cert };
}
