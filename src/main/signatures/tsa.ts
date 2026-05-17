import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

import forge from 'node-forge';

import { NodePdfError } from '~shared/types/errors.js';

/**
 * RFC 3161 Trusted Timestamp client.
 *
 * Round-trip:
 *   1. Compute a digest over the bytes we want to timestamp (in our case the
 *      CMS signatureValue — proves the signature existed at the TSA's
 *      reported time).
 *   2. Wrap the digest in a TimeStampReq (DER), POST to the TSA endpoint
 *      with Content-Type `application/timestamp-query`.
 *   3. Receive `application/timestamp-reply`. Parse PKIStatusInfo — anything
 *      other than `granted` (0) / `grantedWithMods` (1) means the TSA
 *      refused. Extract the embedded TimeStampToken (a ContentInfo SEQUENCE).
 *   4. Embed the TST as an unsigned attribute in the SignerInfo of our CMS,
 *      under OID 1.2.840.113549.1.9.16.2.14 (id-aa-signatureTimeStampToken).
 *      The verifier later checks that the TST signs SHA-256(signatureValue),
 *      proving the time.
 *
 * The TSA's own signature on the TST is what gives the timestamp legal
 * weight — verifiers chain that signature back to a trusted TSA root.
 * We do NOT validate the TST chain in this version; that's a separate
 * follow-up (would live alongside OCSP-style trust checks).
 */

export type TsaHashAlgorithm = 'sha256' | 'sha384' | 'sha512';

interface AlgorithmOidInfo {
  oid: string;
  forgeName: TsaHashAlgorithm;
}

const HASH_OIDS: Record<TsaHashAlgorithm, AlgorithmOidInfo> = {
  sha256: { oid: '2.16.840.1.101.3.4.2.1', forgeName: 'sha256' },
  sha384: { oid: '2.16.840.1.101.3.4.2.2', forgeName: 'sha384' },
  sha512: { oid: '2.16.840.1.101.3.4.2.3', forgeName: 'sha512' },
};

/** Build a DER-encoded TimeStampReq per RFC 3161 §2.4.1. */
function buildTimestampReq(
  messageDigest: Buffer,
  algorithm: TsaHashAlgorithm,
  certReq: boolean,
): Uint8Array {
  const info = HASH_OIDS[algorithm];
  const algorithmIdentifier = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.SEQUENCE,
    true,
    [
      forge.asn1.create(
        forge.asn1.Class.UNIVERSAL,
        forge.asn1.Type.OID,
        false,
        forge.asn1.oidToDer(info.oid).getBytes(),
      ),
      // NULL parameters — required for the SHA family. Without this Adobe
      // and some strict TSAs reject as malformed AlgorithmIdentifier.
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.NULL, false, ''),
    ],
  );

  const messageImprint = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.SEQUENCE,
    true,
    [
      algorithmIdentifier,
      forge.asn1.create(
        forge.asn1.Class.UNIVERSAL,
        forge.asn1.Type.OCTETSTRING,
        false,
        messageDigest.toString('binary'),
      ),
    ],
  );

  const reqChildren: forge.asn1.Asn1[] = [
    // version INTEGER (defaults to 1; some TSAs require it to be present)
    forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.INTEGER,
      false,
      String.fromCharCode(0x01),
    ),
    messageImprint,
  ];
  // certReq BOOLEAN — when true, the TSA includes its own signing cert in
  // the TST. That's what we want so verifiers can resolve the chain offline.
  if (certReq) {
    reqChildren.push(
      forge.asn1.create(
        forge.asn1.Class.UNIVERSAL,
        forge.asn1.Type.BOOLEAN,
        false,
        String.fromCharCode(0xff),
      ),
    );
  }

  const req = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.SEQUENCE,
    true,
    reqChildren,
  );
  const der = forge.asn1.toDer(req).getBytes();
  const out = new Uint8Array(der.length);
  for (let i = 0; i < der.length; i++) out[i] = der.charCodeAt(i) & 0xff;
  return out;
}

/** Parse a TimeStampResp and extract the embedded TimeStampToken (a
 * ContentInfo SEQUENCE). Throws NodePdfError if PKIStatusInfo.status
 * indicates rejection or the structure is malformed. */
function extractTimestampToken(respBytes: Uint8Array): forge.asn1.Asn1 {
  let resp: forge.asn1.Asn1;
  try {
    const bin = forge.util.createBuffer(Buffer.from(respBytes).toString('binary'));
    // Cast around the @types limitation re: options object — same trick as
    // inspect.ts. Real-world TSAs sometimes ship a trailing newline.
    type FromDer = (
      b: forge.util.ByteBuffer,
      o: { strict?: boolean; parseAllBytes?: boolean },
    ) => forge.asn1.Asn1;
    const fromDer = forge.asn1.fromDer as unknown as FromDer;
    resp = fromDer(bin, { strict: false, parseAllBytes: false });
  } catch (err) {
    throw new NodePdfError('READ_FAILED', 'TSA response is not valid DER', err);
  }

  const children = Array.isArray(resp.value) ? (resp.value as forge.asn1.Asn1[]) : null;
  if (!children || children.length < 1) {
    throw new NodePdfError('READ_FAILED', 'TSA response has no PKIStatusInfo');
  }

  // PKIStatusInfo ::= SEQ { status INTEGER, statusString OPT, failInfo OPT }
  const statusInfo = children[0];
  const statusChildren = statusInfo && Array.isArray(statusInfo.value)
    ? (statusInfo.value as forge.asn1.Asn1[])
    : null;
  const statusNode = statusChildren?.[0];
  if (!statusNode || typeof statusNode.value !== 'string') {
    throw new NodePdfError('READ_FAILED', 'TSA PKIStatusInfo malformed');
  }
  // Status INTEGER bytes — interpret big-endian as small integer.
  let statusValue = 0;
  for (let i = 0; i < statusNode.value.length; i++) {
    statusValue = (statusValue << 8) | (statusNode.value.charCodeAt(i) & 0xff);
  }
  // 0 = granted, 1 = grantedWithMods. Anything else (2 = rejection, etc.)
  // means the TSA refused; surface a useful error.
  if (statusValue !== 0 && statusValue !== 1) {
    const reason = statusValue === 2
      ? 'rejection'
      : statusValue === 3
        ? 'waiting'
        : statusValue === 4
          ? 'revocationWarning'
          : statusValue === 5
            ? 'revocationNotification'
            : `status=${statusValue}`;
    throw new NodePdfError(
      'READ_FAILED',
      `TSA refused to timestamp: ${reason}`,
    );
  }

  // The TimeStampToken is the second element of TimeStampResp.
  if (children.length < 2) {
    throw new NodePdfError(
      'READ_FAILED',
      'TSA granted but response has no TimeStampToken',
    );
  }
  return children[1]!;
}

function postBinary(
  url: string,
  contentType: string,
  body: Uint8Array,
  expectedResponseType: string,
  timeoutMs: number,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(new NodePdfError('VALIDATION_ERROR', `Invalid TSA URL: ${url}`, err));
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(
        new NodePdfError(
          'VALIDATION_ERROR',
          `Unsupported TSA protocol: ${parsed.protocol}`,
        ),
      );
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
          // Some TSAs reject requests with the default Node user-agent.
          'User-Agent': 'NodePDF/0.1 RFC3161-client',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(
              new NodePdfError(
                'READ_FAILED',
                `TSA returned HTTP ${res.statusCode} ${res.statusMessage ?? ''}`,
              ),
            );
            return;
          }
          const ct = (res.headers['content-type'] ?? '').toLowerCase();
          // Be lenient on exact content-type — some TSAs return
          // `application/timestamp-reply; charset=...` or generic
          // `application/octet-stream`.
          if (
            !ct.includes(expectedResponseType.toLowerCase()) &&
            !ct.includes('octet-stream') &&
            ct !== ''
          ) {
            reject(
              new NodePdfError(
                'READ_FAILED',
                `TSA response content-type ${ct} doesn't look like ${expectedResponseType}`,
              ),
            );
            return;
          }
          resolve(new Uint8Array(buf));
        });
        res.on('error', (err) => reject(new NodePdfError('READ_FAILED', 'TSA response error', err)));
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`TSA request timed out after ${timeoutMs}ms`));
    });
    req.on('error', (err) =>
      reject(new NodePdfError('READ_FAILED', `TSA request failed: ${err.message}`, err)),
    );
    req.write(body);
    req.end();
  });
}

export interface TsaOptions {
  /** Endpoint URL (default https://freetsa.org/tsr is set elsewhere in
   * settings). Must accept application/timestamp-query POSTs. */
  url: string;
  /** Hash algorithm for the messageImprint. SHA-256 is the universal pick. */
  algorithm?: TsaHashAlgorithm;
  /** Network timeout (ms). TSAs are usually fast; we cap at 15 s default. */
  timeoutMs?: number;
}

/**
 * Request a timestamp token from an RFC 3161 TSA. Returns the parsed
 * TimeStampToken ASN.1 node (a ContentInfo SEQ), ready to embed inside a
 * SignerInfo's unsignedAttrs.
 */
export async function requestTimestampToken(
  dataToTimestamp: Buffer,
  options: TsaOptions,
): Promise<forge.asn1.Asn1> {
  const algorithm = options.algorithm ?? 'sha256';
  const timeoutMs = options.timeoutMs ?? 15_000;

  const digest = createHash(HASH_OIDS[algorithm].forgeName)
    .update(dataToTimestamp)
    .digest();

  const reqDer = buildTimestampReq(digest, algorithm, true);
  const respDer = await postBinary(
    options.url,
    'application/timestamp-query',
    reqDer,
    'application/timestamp-reply',
    timeoutMs,
  );
  return extractTimestampToken(respDer);
}
