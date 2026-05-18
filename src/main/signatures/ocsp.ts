import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

import forge from 'node-forge';

/**
 * Online Certificate Status Protocol client (RFC 6960).
 *
 * Asks the cert issuer's OCSP responder whether a given certificate is
 * still valid (vs revoked) right now. The flow:
 *
 *   1. From the signer cert's AIA extension, find the OCSP responder URL.
 *   2. Match the signer to its issuer (from the CMS bag) to compute the
 *      CertID — SHA-1 of issuer DN + SHA-1 of issuer public key + serial.
 *   3. Build a minimal OCSPRequest, POST to the responder with
 *      Content-Type application/ocsp-request.
 *   4. Parse the OCSPResponse: status (good / revoked / unknown), reason
 *      and revocation time if revoked, thisUpdate/nextUpdate timestamps.
 *
 * v1 caveats — documented so the verdict isn't oversold:
 *   - We do NOT verify the OCSP response's own signature (would require
 *     building a responder-cert chain and validating against a trust
 *     store). A malicious-in-the-middle could forge a "good" response.
 *     Acceptable for an "informational" status badge; for strict
 *     compliance work, treat the verdict as advisory.
 *   - No OCSP stapling at sign time — we don't embed the response in the
 *     PDF's /DSS for offline future verification. Inspectors that don't
 *     have internet access at the time the user opens the doc won't see
 *     the verdict (we mark them `unchecked`).
 */

export type OcspStatus = 'good' | 'revoked' | 'unknown';

export interface OcspResult {
  status: OcspStatus;
  /** When status === 'revoked', the time the cert was revoked. */
  revokedAt?: string;
  /** When status === 'revoked', the reason code if the responder included it. */
  revocationReason?: string;
  /** Responder's "thisUpdate" — when this status was generated. */
  producedAt?: string;
}

export interface OcspCheckInput {
  /** Certificate whose status we want. */
  cert: forge.pki.Certificate;
  /** The issuer cert (subject DN === cert.issuer DN). Must be available
   * because the CertID hashes the issuer's name + public key. */
  issuerCert: forge.pki.Certificate;
  /** Network timeout in ms. */
  timeoutMs?: number;
}

/** OIDs used by the OCSP machinery. */
const OID_AIA = '1.3.6.1.5.5.7.1.1';
const OID_AD_OCSP = '1.3.6.1.5.5.7.48.1';
const OID_SHA1 = '1.3.14.3.2.26';
const OID_OCSP_BASIC = '1.3.6.1.5.5.7.48.1.1';

/** Pull the first OCSP URL out of a cert's AIA extension. node-forge's
 * built-in extension parser handles `subjectAltName`, `keyUsage`, etc. but
 * doesn't auto-decode AIA — we walk the raw extension value as ASN.1. */
export function extractOcspUrl(cert: forge.pki.Certificate): string | null {
  // forge's Cert.extensions is an array; the AIA entry has .id === OID_AIA
  // but its .value field is the OCTET STRING contents (the raw DER of the
  // AuthorityInfoAccessSyntax SEQUENCE).
  type Ext = {
    id?: string;
    value?: string | Uint8Array;
  };
  const ext = (cert.extensions as Ext[]).find((e) => e.id === OID_AIA);
  if (!ext || typeof ext.value !== 'string') return null;

  let asn1: forge.asn1.Asn1;
  try {
    type FromDer = (
      b: forge.util.ByteBuffer,
      o: { strict?: boolean; parseAllBytes?: boolean },
    ) => forge.asn1.Asn1;
    const fromDer = forge.asn1.fromDer as unknown as FromDer;
    asn1 = fromDer(forge.util.createBuffer(ext.value), {
      strict: false,
      parseAllBytes: false,
    });
  } catch {
    return null;
  }
  const accessDescriptions = Array.isArray(asn1.value)
    ? (asn1.value as forge.asn1.Asn1[])
    : null;
  if (!accessDescriptions) return null;

  for (const ad of accessDescriptions) {
    const fields = Array.isArray(ad.value) ? (ad.value as forge.asn1.Asn1[]) : null;
    if (!fields || fields.length < 2) continue;
    const methodNode = fields[0];
    if (!methodNode || typeof methodNode.value !== 'string') continue;
    let methodOid: string;
    try {
      methodOid = forge.asn1.derToOid(methodNode.value);
    } catch {
      continue;
    }
    if (methodOid !== OID_AD_OCSP) continue;
    // accessLocation is a GeneralName — for OCSP it's typically the
    // uniformResourceIdentifier choice ([6] IMPL IA5String).
    const locNode = fields[1];
    if (!locNode || typeof locNode.value !== 'string') continue;
    if (
      locNode.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC &&
      (locNode.type as number) === 6
    ) {
      return locNode.value;
    }
  }
  return null;
}

/** Build the CertID for an OCSPRequest entry. Per RFC 6960 §4.1.1:
 *
 *   CertID ::= SEQUENCE {
 *     hashAlgorithm  AlgorithmIdentifier,
 *     issuerNameHash OCTET STRING,   -- SHA-1 of issuer DN DER
 *     issuerKeyHash  OCTET STRING,   -- SHA-1 of issuer SubjectPublicKey BIT STRING bytes
 *     serialNumber   CertificateSerialNumber
 *   }
 *
 * SHA-1 is what every responder in the wild speaks. Modern profiles allow
 * SHA-256 but compat is patchy. */
function buildCertId(
  cert: forge.pki.Certificate,
  issuerCert: forge.pki.Certificate,
): forge.asn1.Asn1 {
  // Issuer DN as ASN.1 then DER, then SHA-1.
  const issuerNameAsn1 = forge.pki.distinguishedNameToAsn1(issuerCert.subject);
  const issuerNameDer = forge.asn1.toDer(issuerNameAsn1).getBytes();
  const issuerNameHash = createHash('sha1')
    .update(Buffer.from(issuerNameDer, 'binary'))
    .digest();

  // Issuer subjectPublicKey RAW bytes — that's the BIT STRING value WITHOUT
  // the leading "unused bits" byte. forge exposes the parsed pubkey but
  // not the raw bytes directly; we re-serialize the cert's tbsCertificate
  // SubjectPublicKeyInfo and pluck the BIT STRING content.
  const issuerSpki = forge.pki.publicKeyToAsn1(issuerCert.publicKey);
  const spkiChildren = (issuerSpki.value as forge.asn1.Asn1[]);
  // SPKI structure: SEQ { AlgorithmIdentifier, BIT STRING subjectPublicKey }
  const bitStringNode = spkiChildren[1]!;
  // forge stores BIT STRING value as "<unused-bits-byte><raw-bytes>"; strip
  // the first byte to get the canonical public key bytes per RFC.
  const bitStringRaw = bitStringNode.value as string;
  const pubKeyBytes = bitStringRaw.slice(1);
  const issuerKeyHash = createHash('sha1')
    .update(Buffer.from(pubKeyBytes, 'binary'))
    .digest();

  // Serial number — forge stores as hex string. Convert to DER INTEGER bytes
  // (we need to preserve leading 0x00 for positive-sign in big endian).
  let serialHex = cert.serialNumber.toLowerCase();
  if (serialHex.length % 2 === 1) serialHex = '0' + serialHex;
  let serialBytes = Buffer.from(serialHex, 'hex');
  if (serialBytes.length > 0 && serialBytes[0]! & 0x80) {
    // High bit set → prepend 0x00 to keep INTEGER positive.
    serialBytes = Buffer.concat([Buffer.from([0x00]), serialBytes]);
  }

  return forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.SEQUENCE,
    true,
    [
      // hashAlgorithm SEQ { OID, NULL }
      forge.asn1.create(
        forge.asn1.Class.UNIVERSAL,
        forge.asn1.Type.SEQUENCE,
        true,
        [
          forge.asn1.create(
            forge.asn1.Class.UNIVERSAL,
            forge.asn1.Type.OID,
            false,
            forge.asn1.oidToDer(OID_SHA1).getBytes(),
          ),
          forge.asn1.create(
            forge.asn1.Class.UNIVERSAL,
            forge.asn1.Type.NULL,
            false,
            '',
          ),
        ],
      ),
      forge.asn1.create(
        forge.asn1.Class.UNIVERSAL,
        forge.asn1.Type.OCTETSTRING,
        false,
        issuerNameHash.toString('binary'),
      ),
      forge.asn1.create(
        forge.asn1.Class.UNIVERSAL,
        forge.asn1.Type.OCTETSTRING,
        false,
        issuerKeyHash.toString('binary'),
      ),
      forge.asn1.create(
        forge.asn1.Class.UNIVERSAL,
        forge.asn1.Type.INTEGER,
        false,
        serialBytes.toString('binary'),
      ),
    ],
  );
}

function buildOcspRequest(certId: forge.asn1.Asn1): Uint8Array {
  // OCSPRequest ::= SEQ { tbsRequest TBSRequest, optionalSignature [0] OPT }
  // TBSRequest ::= SEQ { version [0] EXP OPT, ..., requestList SEQ OF Request }
  // Request ::= SEQ { reqCert CertID, ... }
  const request = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.SEQUENCE,
    true,
    [certId],
  );
  const requestList = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.SEQUENCE,
    true,
    [request],
  );
  const tbsRequest = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.SEQUENCE,
    true,
    [requestList],
  );
  const ocspRequest = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.SEQUENCE,
    true,
    [tbsRequest],
  );
  const der = forge.asn1.toDer(ocspRequest).getBytes();
  const out = new Uint8Array(der.length);
  for (let i = 0; i < der.length; i++) out[i] = der.charCodeAt(i) & 0xff;
  return out;
}

function postBinary(
  url: string,
  contentType: string,
  body: Uint8Array,
  timeoutMs: number,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error(`Unsupported OCSP protocol: ${parsed.protocol}`));
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method: 'POST',
        protocol: parsed.protocol,
        host: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(body.length),
          'User-Agent': 'NodePDF/0.1 OCSP-client',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`OCSP HTTP ${res.statusCode}`));
            return;
          }
          resolve(new Uint8Array(Buffer.concat(chunks)));
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('OCSP request timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Parse an OCSPResponse and pull the first SingleResponse's status.
 *
 *   OCSPResponse ::= SEQ {
 *     responseStatus OCSPResponseStatus,
 *     responseBytes [0] EXPLICIT ResponseBytes OPT
 *   }
 *   ResponseBytes ::= SEQ {
 *     responseType OID (id-pkix-ocsp-basic),
 *     response OCTET STRING (BasicOCSPResponse DER)
 *   }
 *   BasicOCSPResponse ::= SEQ {
 *     tbsResponseData ResponseData,
 *     ...
 *   }
 *   ResponseData ::= SEQ {
 *     ..., responses SEQ OF SingleResponse, ...
 *   }
 *   SingleResponse ::= SEQ {
 *     certID CertID,
 *     certStatus CertStatus,
 *     thisUpdate GeneralizedTime,
 *     nextUpdate [0] EXP GeneralizedTime OPT,
 *     ...
 *   }
 *   CertStatus ::= CHOICE {
 *     good    [0] IMPLICIT NULL,
 *     revoked [1] IMPLICIT RevokedInfo,
 *     unknown [2] IMPLICIT UnknownInfo
 *   }
 */
function parseOcspResponse(respBytes: Uint8Array): OcspResult {
  try {
    type FromDer = (
      b: forge.util.ByteBuffer,
      o: { strict?: boolean; parseAllBytes?: boolean },
    ) => forge.asn1.Asn1;
    const fromDer = forge.asn1.fromDer as unknown as FromDer;
    const resp = fromDer(
      forge.util.createBuffer(Buffer.from(respBytes).toString('binary')),
      { strict: false, parseAllBytes: false },
    );
    const respChildren = resp.value as forge.asn1.Asn1[];
    const statusNode = respChildren[0];
    if (!statusNode || typeof statusNode.value !== 'string') {
      return { status: 'unknown' };
    }
    // OCSPResponseStatus INTEGER 0 = successful
    let statusEnum = 0;
    for (let i = 0; i < statusNode.value.length; i++) {
      statusEnum = (statusEnum << 8) | (statusNode.value.charCodeAt(i) & 0xff);
    }
    if (statusEnum !== 0) return { status: 'unknown' };

    const explicit = respChildren[1];
    if (!explicit) return { status: 'unknown' };
    const respBytesNode = (explicit.value as forge.asn1.Asn1[])[0];
    if (!respBytesNode) return { status: 'unknown' };
    const rbChildren = respBytesNode.value as forge.asn1.Asn1[];
    const respTypeOid =
      rbChildren[0] && typeof rbChildren[0].value === 'string'
        ? forge.asn1.derToOid(rbChildren[0].value)
        : null;
    if (respTypeOid !== OID_OCSP_BASIC) return { status: 'unknown' };

    const basicOctet = rbChildren[1];
    if (!basicOctet || typeof basicOctet.value !== 'string') return { status: 'unknown' };
    const basic = fromDer(forge.util.createBuffer(basicOctet.value), {
      strict: false,
      parseAllBytes: false,
    });
    const tbsResp = (basic.value as forge.asn1.Asn1[])[0]!;
    const tbsChildren = tbsResp.value as forge.asn1.Asn1[];
    // responses is a UNIVERSAL SEQUENCE inside tbsResponseData. Layout
    // includes responderID (CHOICE) and producedAt (GeneralizedTime) before
    // it; we scan for the first SEQUENCE-of-SEQUENCEs.
    let responses: forge.asn1.Asn1 | null = null;
    let producedAt: string | undefined;
    for (const child of tbsChildren) {
      if (
        child.tagClass === forge.asn1.Class.UNIVERSAL &&
        (child.type as number) === forge.asn1.Type.SEQUENCE &&
        Array.isArray(child.value) &&
        (child.value as forge.asn1.Asn1[])[0] &&
        ((child.value as forge.asn1.Asn1[])[0]!.tagClass ===
          forge.asn1.Class.UNIVERSAL &&
          ((child.value as forge.asn1.Asn1[])[0]!.type as number) ===
            forge.asn1.Type.SEQUENCE)
      ) {
        responses = child;
      } else if (
        child.tagClass === forge.asn1.Class.UNIVERSAL &&
        (child.type as number) === forge.asn1.Type.GENERALIZEDTIME &&
        typeof child.value === 'string'
      ) {
        try {
          producedAt = forge.asn1.generalizedTimeToDate(child.value).toISOString();
        } catch {
          // ignore malformed time
        }
      }
    }
    if (!responses) return { status: 'unknown' };

    const single = (responses.value as forge.asn1.Asn1[])[0];
    if (!single) return { status: 'unknown' };
    const singleChildren = single.value as forge.asn1.Asn1[];
    // certID [0], certStatus [1], thisUpdate [2]
    const certStatus = singleChildren[1];
    if (!certStatus) return { status: 'unknown' };

    // CertStatus CHOICE: [0] good, [1] revoked, [2] unknown
    const tag = certStatus.type as number;
    if (certStatus.tagClass !== forge.asn1.Class.CONTEXT_SPECIFIC) {
      return { status: 'unknown', ...(producedAt ? { producedAt } : {}) };
    }
    if (tag === 0) {
      return { status: 'good', ...(producedAt ? { producedAt } : {}) };
    }
    if (tag === 1) {
      // revoked [1] IMPL RevokedInfo SEQ { revocationTime GeneralizedTime,
      //                                    revocationReason [0] OPT }
      let revokedAt: string | undefined;
      let revocationReason: string | undefined;
      const revInfo = Array.isArray(certStatus.value)
        ? (certStatus.value as forge.asn1.Asn1[])
        : null;
      if (revInfo) {
        const revTime = revInfo[0];
        if (revTime && typeof revTime.value === 'string') {
          try {
            revokedAt = forge.asn1
              .generalizedTimeToDate(revTime.value)
              .toISOString();
          } catch {
            // ignore
          }
        }
        // Optional reason — context [0] IMPL CRLReason (an INTEGER ENUMERATED)
        for (let i = 1; i < revInfo.length; i++) {
          const node = revInfo[i]!;
          if (
            node.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC &&
            (node.type as number) === 0 &&
            typeof node.value === 'string' &&
            node.value.length > 0
          ) {
            const code = node.value.charCodeAt(0) & 0xff;
            revocationReason = OCSP_REVOCATION_REASONS[code] ?? `code ${code}`;
          }
        }
      }
      return {
        status: 'revoked',
        ...(revokedAt ? { revokedAt } : {}),
        ...(revocationReason ? { revocationReason } : {}),
        ...(producedAt ? { producedAt } : {}),
      };
    }
    return { status: 'unknown', ...(producedAt ? { producedAt } : {}) };
  } catch {
    return { status: 'unknown' };
  }
}

const OCSP_REVOCATION_REASONS: Record<number, string> = {
  0: 'unspecified',
  1: 'keyCompromise',
  2: 'cACompromise',
  3: 'affiliationChanged',
  4: 'superseded',
  5: 'cessationOfOperation',
  6: 'certificateHold',
  8: 'removeFromCRL',
  9: 'privilegeWithdrawn',
  10: 'aACompromise',
};

/**
 * End-to-end OCSP check. Returns null when the cert has no AIA OCSP URL or
 * we couldn't reach the responder — callers treat null as "no information"
 * rather than an error. */
export async function checkOcsp(input: OcspCheckInput): Promise<OcspResult | null> {
  const raw = await fetchOcspResponseRaw(input);
  if (!raw) return null;
  return parseOcspResponse(raw);
}

/**
 * Same as checkOcsp but returns the RAW OCSP response DER bytes instead of
 * a parsed verdict. Used by the digital-signing pipeline to "staple" the
 * response into the PDF's /DSS dict — verifiers can then check revocation
 * offline (no network round-trip at verify time) and the staple stays
 * meaningful for years after the OCSP responder is gone.
 */
export async function fetchOcspResponseRaw(
  input: OcspCheckInput,
): Promise<Uint8Array | null> {
  const url = extractOcspUrl(input.cert);
  if (!url) return null;
  let req: Uint8Array;
  try {
    const certId = buildCertId(input.cert, input.issuerCert);
    req = buildOcspRequest(certId);
  } catch {
    return null;
  }
  try {
    return await postBinary(
      url,
      'application/ocsp-request',
      req,
      input.timeoutMs ?? 10_000,
    );
  } catch {
    return null;
  }
}
