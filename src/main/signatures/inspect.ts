import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
} from '@cantoo/pdf-lib';
import forge from 'node-forge';

import { NodePdfError } from '~shared/types/errors.js';
import type {
  ExistingSignatureInfo,
  SignatureIntegrityStatus,
  SignatureTrustStatus,
} from '~shared/types/signatures.js';

import { verifyTrustChain } from './trust.js';

interface SignatureField {
  /** /T (field name). */
  fieldName: string;
  /** The /V sig dict resolved through any indirect refs. */
  sigDict: PDFDict;
}

/** Recursively collect every field whose /FT is /Sig. AcroForm Fields can
 * be nested (a parent group with /Kids), so we descend depth-first. */
function collectSignatureFields(
  doc: PDFDocument,
  fields: PDFArray,
  parentName = '',
  out: SignatureField[] = [],
): SignatureField[] {
  for (let i = 0; i < fields.size(); i++) {
    const ref = fields.get(i);
    const dict = doc.context.lookup(ref);
    if (!(dict instanceof PDFDict)) continue;

    const partial = dict.lookupMaybe(PDFName.of('T'), PDFString, PDFHexString);
    const rawLocal = partial ? partial.decodeText() : '';
    // Some PDFs (notably FreeTSA's demo files) store random binary in /T
    // because the field name isn't meant to be shown — only matched. If the
    // value can't be displayed as readable text, fall back to a synthetic
    // "Signature{n}" name so the panel doesn't show mojibake.
    // eslint-disable-next-line no-control-regex
    const localName = /^[\x20-\x7E]*$/.test(rawLocal) ? rawLocal : '';
    const fullName = parentName ? `${parentName}.${localName}` : localName;

    const kids = dict.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) {
      collectSignatureFields(doc, kids, fullName, out);
      continue;
    }

    const ft = dict.lookupMaybe(PDFName.of('FT'), PDFName);
    if (ft && ft.asString() === '/Sig') {
      const v = dict.lookup(PDFName.of('V'));
      if (v instanceof PDFDict) {
        out.push({
          fieldName: fullName || `Signature${out.length + 1}`,
          sigDict: v,
        });
      }
    }
  }
  return out;
}

/** Parse a /M timestamp string (PDF "D:YYYYMMDDHHmmSSOHH'mm") into an ISO string.
 * Returns null if the input doesn't parse. */
function parsePdfDate(raw: string): string | null {
  const m = raw.match(
    /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?'?/,
  );
  if (!m) return null;
  const [
    ,
    year,
    month = '01',
    day = '01',
    hour = '00',
    minute = '00',
    second = '00',
    tzSign,
    tzH = '00',
    tzM = '00',
  ] = m;
  const tz =
    !tzSign || tzSign === 'Z' ? 'Z' : `${tzSign}${tzH.padStart(2, '0')}:${tzM.padStart(2, '0')}`;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${tz}`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Decode raw bytes from a /Contents hex string. PDF wraps the CMS blob in
 * angle brackets containing the hex; pdf-lib's PDFHexString.asBytes() handles
 * that for us already. */
function extractCmsBytes(sigDict: PDFDict): Uint8Array | null {
  const v = sigDict.lookup(PDFName.of('Contents'));
  if (v instanceof PDFHexString) return v.asBytes();
  if (v instanceof PDFString) {
    // Some signers emit /Contents as a literal string instead of hex. Treat
    // each char's char code as a byte.
    const text = v.asString();
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  }
  return null;
}

function extractByteRange(sigDict: PDFDict): [number, number, number, number] | null {
  const arr = sigDict.lookupMaybe(PDFName.of('ByteRange'), PDFArray);
  if (!arr || arr.size() !== 4) return null;
  const nums: number[] = [];
  for (let i = 0; i < 4; i++) {
    const v = arr.lookup(i);
    if (!(v instanceof PDFNumber)) return null;
    nums.push(v.asNumber());
  }
  return nums as [number, number, number, number];
}

interface SignerInfo {
  signerName: string | null;
  issuerCN: string | null;
  signedAt: string | null;
  digestAlgorithm: string | null;
  embeddedDigest: Uint8Array | null;
  /** Result of cryptographically verifying the CMS signatureValue against
   * the signer cert's public key. Three states:
   *  - true:  RSA verify succeeded → signer cert's private key produced this
   *           signature, so the entire signed-attributes blob (which carries
   *           the document hash) is authentic.
   *  - false: verify failed → the CMS was forged / tampered. Document
   *           integrity cannot be trusted.
   *  - null:  we couldn't even attempt verification (missing cert / sig /
   *           algorithm). Caller treats as 'unknown' rather than 'valid'. */
  cmsSignatureValid: boolean | null;
  /** Cert validity window (ISO strings, null if cert parse failed). */
  validFrom: string | null;
  validTo: string | null;
  /** Result of chain validation against the bundled Mozilla root store. */
  trustStatus: SignatureTrustStatus;
  /** Friendly CN of the trusted root when trustStatus === 'trusted'. */
  trustedRootCN: string | null;
}

function asArray(node: forge.asn1.Asn1 | undefined): forge.asn1.Asn1[] | null {
  if (!node || !Array.isArray(node.value)) return null;
  return node.value as forge.asn1.Asn1[];
}

/**
 * The PDF /Contents slot is a fixed-size hex placeholder (we write 16 KB);
 * the real CMS DER fills the leading bytes and the tail is zero-padding.
 * Forge's `fromDer` rejects the buffer wholesale with "Unparsed DER bytes
 * remain", so we read the leading SEQUENCE's length prefix and slice the
 * buffer down to the actual DER size before parsing.
 *
 * Many real-world signers (iText, GlobalSign-issued IDs we tested with)
 * emit indefinite-length BER (the length byte is exactly `0x80`, with no
 * numeric octets; the SEQUENCE ends with an EOC `00 00`). For that form the
 * total length isn't declared up-front, so we can't trim — return the buffer
 * as-is and trust forge to consume only the structurally valid bytes.
 */
function trimToDerLength(buf: Uint8Array): Uint8Array {
  if (buf.length < 2) return buf;
  const lengthByte = buf[1]!;

  // Indefinite-length encoding: BER-only. Don't attempt to derive a length.
  if (lengthByte === 0x80) return buf;

  let dataLength: number;
  let headerLength: number;
  if ((lengthByte & 0x80) === 0) {
    // Short form: length fits in one byte (≤ 127).
    dataLength = lengthByte;
    headerLength = 2;
  } else {
    // Long form: low 7 bits encode the number of subsequent length octets.
    const lenOctets = lengthByte & 0x7f;
    if (lenOctets === 0 || buf.length < 2 + lenOctets) return buf;
    headerLength = 2 + lenOctets;
    dataLength = 0;
    for (let i = 0; i < lenOctets; i++) {
      // Big-endian assembly of the length integer.
      dataLength = dataLength * 256 + buf[2 + i]!;
    }
  }
  const total = headerLength + dataLength;
  return total > 0 && total <= buf.length ? buf.subarray(0, total) : buf;
}

function isContext(node: forge.asn1.Asn1, tag: number): boolean {
  return (
    node.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && (node.type as number) === tag
  );
}

/**
 * Walk the SignedData ASN.1 tree by hand to pull signer cert + signed
 * attributes. We previously relied on `p7.rawCapture` (an undocumented
 * internal field of node-forge's `messageFromAsn1`) which is unreliable
 * across forge versions — this manual walker only depends on the public
 * `forge.asn1` primitives and the RFC 5652 structure.
 *
 *     ContentInfo ::= SEQ { contentType OID, content [0] EXPLICIT ANY }
 *     SignedData  ::= SEQ { version, digestAlgs SET, encapContent,
 *                           [0] IMPL certificates OPTIONAL,
 *                           [1] IMPL crls         OPTIONAL,
 *                           signerInfos SET }
 *     SignerInfo  ::= SEQ { version, sid, digestAlgorithm,
 *                           [0] IMPL signedAttrs OPTIONAL,
 *                           sigAlgorithm, signature,
 *                           [1] IMPL unsignedAttrs OPTIONAL }
 */
/**
 * Cryptographically verify the CMS signatureValue against the signer cert's
 * public key. Without this check, an attacker can swap the cert + recompute
 * messageDigest and the document-hash comparison would still pass — making
 * "untampered" a worthless verdict.
 *
 * Per RFC 5652 §5.4, the bytes signed are the DER-encoded SignedAttributes
 * re-tagged as a UNIVERSAL SET (not the IMPLICIT [0] form that appears in
 * the SignerInfo). We rebuild that node by cloning the children under a
 * fresh `(UNIVERSAL, SET)` header before hashing.
 */
function verifyCmsSignature(
  cert: forge.pki.Certificate,
  signedAttrs: forge.asn1.Asn1,
  signatureValue: Uint8Array,
  digestAlgorithm: string,
): boolean {
  try {
    const children = asArray(signedAttrs);
    if (!children) return false;
    const setNode = forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.SET,
      true,
      children,
    );
    const derSet = forge.asn1.toDer(setNode).getBytes();

    // digestAlgorithm comes from oidToHashName: one of sha1|sha256|sha384|sha512.
    // forge.md exposes all four; cast widens beyond the SHA-2 family because
    // legacy CMS in the wild still uses SHA-1 (e.g. older Adobe / GlobalSign IDs).
    const md = forge.md[
      digestAlgorithm as 'sha1' | 'sha256' | 'sha384' | 'sha512'
    ]?.create();
    if (!md) return false;
    md.update(derSet);

    // node-forge's RSA verify takes binary-strings on both sides. We use
    // the cert's publicKey directly; the signer cert is the only public key
    // we have, and SignerInfo.sid (when more than one cert is in the CMS)
    // would tell us which to use. For our single-signer flow this is fine.
    const pubKey = cert.publicKey as forge.pki.rsa.PublicKey;
    return pubKey.verify(
      md.digest().bytes(),
      Buffer.from(signatureValue).toString('binary'),
    );
  } catch {
    return false;
  }
}

/** Locate the OCTET STRING signature value inside a SignerInfo's children.
 * SignerInfo layout: `[version, sid, digestAlg, signedAttrs?, sigAlg,
 * signature, unsignedAttrs?]`. We skip over the optional signedAttrs and
 * signatureAlgorithm to land on the OCTET STRING. */
function findSignatureValue(siChildren: forge.asn1.Asn1[]): Uint8Array | null {
  let idx = 3; // start after version (0), sid (1), digestAlgorithm (2)
  const maybeSigned = siChildren[idx];
  if (maybeSigned && isContext(maybeSigned, 0)) idx++; // skip signedAttrs
  idx++; // skip signatureAlgorithm SEQ
  const sigNode = siChildren[idx];
  if (!sigNode || typeof sigNode.value !== 'string') return null;
  const raw = sigNode.value;
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i) & 0xff;
  return buf;
}

function parseCms(cms: Uint8Array): SignerInfo {
  const DBG = process.env.NODEPDF_SIG_DEBUG === '1';
  const dbg = (...args: unknown[]) => {
    if (DBG) console.error('[sig-debug]', ...args);
  };
  const result: SignerInfo = {
    signerName: null,
    issuerCN: null,
    signedAt: null,
    digestAlgorithm: null,
    embeddedDigest: null,
    cmsSignatureValid: null,
    validFrom: null,
    validTo: null,
    trustStatus: 'unknown',
    trustedRootCN: null,
  };

  // Trim trailing placeholder zero-padding so forge sees only the real DER.
  const der = trimToDerLength(cms);
  dbg('parseCms: cms bytes =', cms.length, 'trimmed =', der.length);

  let contentInfo: forge.asn1.Asn1;
  try {
    const binary = forge.util.createBuffer(Buffer.from(der).toString('binary'));
    // - strict:false → accept BER (notably indefinite-length encoding used
    //   by iText-derived signers like the GlobalSign-issued Qoppa demo).
    // - parseAllBytes:false → some CMS payloads carry trailing EOC markers
    //   or odd padding that forge would otherwise reject; we only need the
    //   parsed structure, not byte-exact roundtrip.
    // @types/node-forge only models the legacy boolean-strict overload; the
    // options-object form is supported at runtime in forge >=0.10.0.
    type FromDerOptions = { strict?: boolean; parseAllBytes?: boolean };
    type FromDer = (
      bytes: forge.util.ByteBuffer,
      opts: FromDerOptions,
    ) => forge.asn1.Asn1;
    const fromDer = forge.asn1.fromDer as unknown as FromDer;
    contentInfo = fromDer(binary, { strict: false, parseAllBytes: false });
  } catch (err) {
    dbg('parseCms: fromDer threw', err);
    return result;
  }

  const contentInfoChildren = asArray(contentInfo);
  dbg('parseCms: ContentInfo children =', contentInfoChildren?.length);
  if (!contentInfoChildren || contentInfoChildren.length < 2) return result;

  // content [0] EXPLICIT → unwrap one layer to reach SignedData
  const explicit = contentInfoChildren[1];
  dbg(
    'parseCms: explicit tagClass =',
    explicit?.tagClass,
    'type =',
    explicit?.type,
  );
  const explicitChildren = explicit ? asArray(explicit) : null;
  const signedData = explicitChildren?.[0];
  dbg(
    'parseCms: signedData tagClass =',
    signedData?.tagClass,
    'type =',
    signedData?.type,
  );
  if (!signedData) return result;
  const sdChildren = asArray(signedData);
  dbg('parseCms: SignedData children =', sdChildren?.length);
  if (!sdChildren) return result;

  // Find the SignerInfos SET and the optional [0] IMPL certificates wrapper.
  // SignerInfos is the only UNIVERSAL SET inside SignedData (digestAlgorithms
  // also a SET but lives earlier; we want the LAST UNIVERSAL SET).
  let signerInfosSet: forge.asn1.Asn1 | null = null;
  let certificatesWrapper: forge.asn1.Asn1 | null = null;
  for (const child of sdChildren) {
    dbg(
      '  SD child: tagClass =',
      child.tagClass,
      'type =',
      child.type,
      'arr =',
      Array.isArray(child.value),
    );
    if (
      child.tagClass === forge.asn1.Class.UNIVERSAL &&
      (child.type as number) === forge.asn1.Type.SET
    ) {
      // Overwrite as we go — the last UNIVERSAL SET is signerInfos.
      signerInfosSet = child;
    } else if (isContext(child, 0)) {
      certificatesWrapper = child;
    }
  }
  dbg(
    'parseCms: signerInfosSet =',
    !!signerInfosSet,
    'certificatesWrapper =',
    !!certificatesWrapper,
  );

  // ---- certificates → signer + issuer + chain ----------------------------
  // The CMS bag often holds intermediates + root in addition to the leaf;
  // we need them all for chain validation. Convention is leaf-first but
  // we don't rely on that — chain assembly walks subject/issuer DNs.
  const certificateList = certificatesWrapper ? asArray(certificatesWrapper) : null;
  const allCerts: forge.pki.Certificate[] = [];
  if (certificateList) {
    for (const certAsn1 of certificateList) {
      try {
        allCerts.push(forge.pki.certificateFromAsn1(certAsn1));
      } catch {
        // Skip unparseable cert entries.
      }
    }
  }
  dbg('parseCms: certCount =', allCerts.length);

  // The leaf is conventionally certificates[0]; for full robustness we'd
  // match SignerInfo.sid (issuer + serial), but that's overkill for our
  // single-signer cases.
  const cert = allCerts[0] ?? null;
  if (cert) {
    const subjCN = cert.subject.getField('CN');
    if (subjCN && typeof subjCN.value === 'string') {
      result.signerName = subjCN.value;
    } else {
      const first = cert.subject.attributes[0];
      if (first && typeof first.value === 'string') {
        result.signerName = first.value;
      }
    }
    const issCN = cert.issuer.getField('CN');
    if (issCN && typeof issCN.value === 'string') {
      result.issuerCN = issCN.value;
    } else {
      const first = cert.issuer.attributes[0];
      if (first && typeof first.value === 'string') {
        result.issuerCN = first.value;
      }
    }
    result.validFrom = cert.validity.notBefore.toISOString();
    result.validTo = cert.validity.notAfter.toISOString();

    // Chain validation against bundled Mozilla roots. Always runs — for
    // self-signed certs it short-circuits to 'self-signed' without touching
    // the store.
    const trust = verifyTrustChain(cert, allCerts);
    result.trustStatus = trust.status;
    if (trust.status === 'trusted') {
      result.trustedRootCN = trust.rootCN;
    }
    dbg(
      'parseCms: signerName =',
      result.signerName,
      'issuerCN =',
      result.issuerCN,
      'trust =',
      trust.status,
    );
  }

  // ---- signerInfos[0] → digestAlgorithm + signedAttrs --------------------
  const signerInfoList = signerInfosSet ? asArray(signerInfosSet) : null;
  const signerInfo = signerInfoList?.[0];
  const siChildren = signerInfo ? asArray(signerInfo) : null;
  if (!siChildren) return result;

  // SignerInfo layout: [version, sid, digestAlgorithm, signedAttrs?, ...]
  // digestAlgorithm is always at index 2; signedAttrs is optionally at [3]
  // (only if its CONTEXT [0] IMPL tag is present).
  const digestAlgNode = siChildren[2];
  const digestAlgChildren = digestAlgNode ? asArray(digestAlgNode) : null;
  const digestOidNode = digestAlgChildren?.[0];
  if (digestOidNode && typeof digestOidNode.value === 'string') {
    try {
      result.digestAlgorithm = oidToHashName(forge.asn1.derToOid(digestOidNode.value));
    } catch {
      // ignored
    }
  }

  dbg('parseCms: siChildren =', siChildren.length, 'digestAlgorithm =', result.digestAlgorithm);
  const maybeSignedAttrs = siChildren[3];
  dbg(
    'parseCms: maybeSignedAttrs tagClass =',
    maybeSignedAttrs?.tagClass,
    'type =',
    maybeSignedAttrs?.type,
  );
  const signedAttrList =
    maybeSignedAttrs && isContext(maybeSignedAttrs, 0)
      ? asArray(maybeSignedAttrs)
      : null;
  dbg('parseCms: signedAttrList =', signedAttrList?.length);
  if (!signedAttrList) return result;

  for (const attr of signedAttrList) {
    const attrChildren = asArray(attr);
    if (!attrChildren) continue;
    const oidNode = attrChildren[0];
    const valueSet = attrChildren[1];
    if (!oidNode || typeof oidNode.value !== 'string') continue;
    let oid: string;
    try {
      oid = forge.asn1.derToOid(oidNode.value);
    } catch {
      continue;
    }
    const valueList = valueSet ? asArray(valueSet) : null;
    const inner = valueList?.[0];
    if (!inner || typeof inner.value !== 'string') continue;

    if (oid === '1.2.840.113549.1.9.5') {
      // signingTime — UTCTime or GeneralizedTime.
      try {
        const date =
          (inner.type as number) === forge.asn1.Type.UTCTIME
            ? forge.asn1.utcTimeToDate(inner.value)
            : forge.asn1.generalizedTimeToDate(inner.value);
        if (!Number.isNaN(date.getTime())) {
          result.signedAt = date.toISOString();
        }
      } catch {
        // Malformed time — fall back to PDF-level /M.
      }
    } else if (oid === '1.2.840.113549.1.9.4') {
      const raw = inner.value;
      const buf = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i) & 0xff;
      result.embeddedDigest = buf;
    }
  }

  // ---- cryptographic verification of the CMS signatureValue --------------
  // This is the check that turns "the hash in the CMS matches the document"
  // into "this CMS was actually produced by the holder of the cert's private
  // key". Without it, an attacker can swap the cert + recompute messageDigest
  // and our integrity status would be a lie.
  if (cert && maybeSignedAttrs && result.digestAlgorithm) {
    const sigValue = findSignatureValue(siChildren);
    dbg('parseCms: signatureValue bytes =', sigValue?.length);
    if (sigValue) {
      result.cmsSignatureValid = verifyCmsSignature(
        cert,
        maybeSignedAttrs,
        sigValue,
        result.digestAlgorithm,
      );
      dbg('parseCms: cmsSignatureValid =', result.cmsSignatureValid);
    }
  }

  return result;
}

function oidToHashName(oid: string): string | null {
  switch (oid) {
    case '1.3.14.3.2.26':
      return 'sha1';
    case '2.16.840.1.101.3.4.2.1':
      return 'sha256';
    case '2.16.840.1.101.3.4.2.2':
      return 'sha384';
    case '2.16.840.1.101.3.4.2.3':
      return 'sha512';
    default:
      return null;
  }
}

function computeByteRangeHash(
  pdfBytes: Buffer,
  byteRange: [number, number, number, number],
  algorithm: string,
): Uint8Array {
  const hash = createHash(algorithm);
  hash.update(pdfBytes.subarray(byteRange[0], byteRange[0] + byteRange[1]));
  hash.update(pdfBytes.subarray(byteRange[2], byteRange[2] + byteRange[3]));
  return hash.digest();
}

/**
 * Decode a PDF literal-string into its underlying byte sequence. pdf-lib's
 * PDFString.asString() returns the value WITHOUT processing PDF's literal-
 * string escape rules — so binary payloads (a DER-encoded cert in /Cert,
 * for example) come back with `\n`, `\r`, `\ddd` and friends as multi-char
 * placeholders instead of the single bytes they represent. Without this
 * decoder forge sees a truncated/garbled cert and bails partway through DER
 * parsing.
 *
 * Per PDF 32000-1:2008 §7.3.4.2:
 *  \n  → 0x0A  \r → 0x0D  \t → 0x09  \b → 0x08  \f → 0x0C
 *  \(  → 0x28  \) → 0x29  \\ → 0x5C
 *  \\nnn  → octal byte (1–3 digits)
 *  \\<EOL>  → line continuation (the EOL is dropped)
 *  \\<anything-else>  → the backslash is ignored
 */
function decodePdfLiteralEscapes(s: string): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== 0x5c /* '\' */) {
      out.push(c & 0xff);
      i++;
      continue;
    }
    i++;
    if (i >= s.length) break;
    const next = s.charCodeAt(i);
    if (next >= 0x30 && next <= 0x37) {
      // Octal escape — read 1 to 3 octal digits.
      let val = 0;
      let count = 0;
      while (count < 3 && i < s.length) {
        const d = s.charCodeAt(i);
        if (d < 0x30 || d > 0x37) break;
        val = (val << 3) | (d - 0x30);
        i++;
        count++;
      }
      out.push(val & 0xff);
      continue;
    }
    switch (next) {
      case 0x6e: out.push(0x0a); i++; break; // \n
      case 0x72: out.push(0x0d); i++; break; // \r
      case 0x74: out.push(0x09); i++; break; // \t
      case 0x62: out.push(0x08); i++; break; // \b
      case 0x66: out.push(0x0c); i++; break; // \f
      case 0x28: out.push(0x28); i++; break; // \(
      case 0x29: out.push(0x29); i++; break; // \)
      case 0x5c: out.push(0x5c); i++; break; // \\
      case 0x0a: i++; break;                  // \<LF> line continuation
      case 0x0d:                              // \<CR> or \<CR><LF>
        i++;
        if (i < s.length && s.charCodeAt(i) === 0x0a) i++;
        break;
      default:
        // Unknown escape: drop the backslash, keep the char (per spec).
        out.push(next & 0xff);
        i++;
    }
  }
  return new Uint8Array(out);
}

/**
 * Parse a signature dict whose SubFilter is `adbe.x509.rsa_sha1` — a legacy
 * Adobe format predating PKCS#7 in PDFs. Layout differs from CMS-based sigs:
 *
 *  - /Contents is the raw RSA signature value (PKCS#1 v1.5 over SHA-1 of
 *    the byte range). NO ASN.1 envelope — just the modulus-sized blob.
 *  - /Cert holds the signer's X.509 cert. Either a single value (literal
 *    string or hex string carrying DER bytes) or an array of those for a
 *    chain (leaf first, intermediates after).
 *
 * Verification here is direct — no intermediate "messageDigest" attribute,
 * the byte-range hash IS what the RSA verify covers. When the verify passes
 * we synthesize a matching `embeddedDigest` so `classifyIntegrity` (which is
 * shared with CMS) renders the integrity verdict identically.
 */
function parseLegacyRsaX509(
  sigDict: PDFDict,
  pdfBytes: Buffer,
  byteRange: [number, number, number, number] | null,
): SignerInfo {
  const result: SignerInfo = {
    signerName: null,
    issuerCN: null,
    signedAt: null,
    digestAlgorithm: 'sha1',
    embeddedDigest: null,
    cmsSignatureValid: null,
    validFrom: null,
    validTo: null,
    trustStatus: 'unknown',
    trustedRootCN: null,
  };

  // ---- collect cert DER bytes from /Cert -----------------------------
  // pdf-lib's PDFString.asString() does NOT process PDF literal-string
  // escape sequences — so binary payloads need decodePdfLiteralEscapes()
  // to recover the original DER bytes. Hex strings are already raw bytes.
  const certNode = sigDict.lookup(PDFName.of('Cert'));
  const certBytesArr: Uint8Array[] = [];

  if (certNode instanceof PDFString) {
    certBytesArr.push(decodePdfLiteralEscapes(certNode.asString()));
  } else if (certNode instanceof PDFHexString) {
    certBytesArr.push(certNode.asBytes());
  } else if (certNode instanceof PDFArray) {
    for (let i = 0; i < certNode.size(); i++) {
      const c = certNode.lookup(i);
      if (c instanceof PDFString) {
        certBytesArr.push(decodePdfLiteralEscapes(c.asString()));
      } else if (c instanceof PDFHexString) {
        certBytesArr.push(c.asBytes());
      }
    }
  }
  if (certBytesArr.length === 0) return result;

  // ---- parse all certs to forge.pki.Certificate ----------------------
  const allCerts: forge.pki.Certificate[] = [];
  for (const cb of certBytesArr) {
    try {
      const asn1 = forge.asn1.fromDer(
        forge.util.createBuffer(Buffer.from(cb).toString('binary')),
      );
      allCerts.push(forge.pki.certificateFromAsn1(asn1));
    } catch {
      // skip unparseable cert entries
    }
  }
  const cert = allCerts[0] ?? null;
  if (!cert) return result;

  // ---- populate metadata (same shape as the CMS path) ----------------
  const subjCN = cert.subject.getField('CN');
  if (subjCN && typeof subjCN.value === 'string') {
    result.signerName = subjCN.value;
  } else {
    const first = cert.subject.attributes[0];
    if (first && typeof first.value === 'string') result.signerName = first.value;
  }
  const issCN = cert.issuer.getField('CN');
  if (issCN && typeof issCN.value === 'string') {
    result.issuerCN = issCN.value;
  } else {
    const first = cert.issuer.attributes[0];
    if (first && typeof first.value === 'string') result.issuerCN = first.value;
  }
  result.validFrom = cert.validity.notBefore.toISOString();
  result.validTo = cert.validity.notAfter.toISOString();

  const trust = verifyTrustChain(cert, allCerts);
  result.trustStatus = trust.status;
  if (trust.status === 'trusted') result.trustedRootCN = trust.rootCN;

  // ---- verify the raw RSA signature ----------------------------------
  // /Contents must be the hex-encoded signature value. Plain string form
  // isn't standard for adbe.x509.rsa_sha1; tolerate it anyway (same
  // escape-decoding caveat as /Cert above).
  const contentsNode = sigDict.lookup(PDFName.of('Contents'));
  let sigValue: Uint8Array | null = null;
  if (contentsNode instanceof PDFHexString) sigValue = contentsNode.asBytes();
  else if (contentsNode instanceof PDFString) {
    sigValue = decodePdfLiteralEscapes(contentsNode.asString());
  }
  if (!sigValue || !byteRange) return result;

  // Per PDF 1.3 §7.4.4.3, /Contents is an ASN.1 OCTET STRING wrapping the
  // raw signature bytes. Unwrap the tag+length header so the payload we
  // hand to RSA verify is exactly modulus-sized. Some non-conformant
  // signers store the raw bytes directly — detect by checking the leading
  // OCTET STRING tag (0x04) and fall through if absent.
  if (sigValue.length >= 2 && sigValue[0] === 0x04) {
    const lengthByte = sigValue[1]!;
    let headerLen: number;
    let dataLen: number;
    if ((lengthByte & 0x80) === 0) {
      headerLen = 2;
      dataLen = lengthByte;
    } else {
      const lenOctets = lengthByte & 0x7f;
      headerLen = 2 + lenOctets;
      dataLen = 0;
      for (let k = 0; k < lenOctets; k++) {
        dataLen = dataLen * 256 + sigValue[2 + k]!;
      }
    }
    if (headerLen + dataLen <= sigValue.length) {
      sigValue = sigValue.subarray(headerLen, headerLen + dataLen);
    }
  }

  let docHash: Buffer;
  try {
    const h = createHash('sha1');
    h.update(pdfBytes.subarray(byteRange[0], byteRange[0] + byteRange[1]));
    h.update(pdfBytes.subarray(byteRange[2], byteRange[2] + byteRange[3]));
    docHash = h.digest();
  } catch {
    return result;
  }

  try {
    const pubKey = cert.publicKey as forge.pki.rsa.PublicKey;
    const ok = pubKey.verify(
      docHash.toString('binary'),
      Buffer.from(sigValue).toString('binary'),
    );
    result.cmsSignatureValid = ok;
    if (ok) {
      // classifyIntegrity expects a synthetic "embedded" digest to compare
      // against the recomputed byte-range hash. For this format the two ARE
      // the same value by construction — populating it lets the shared
      // classifier reach the 'untampered' branch.
      result.embeddedDigest = new Uint8Array(docHash);
    }
  } catch {
    result.cmsSignatureValid = false;
  }

  return result;
}

function classifyIntegrity(
  pdfBytes: Buffer,
  byteRange: [number, number, number, number],
  signer: SignerInfo,
): SignatureIntegrityStatus {
  // 1. Cryptographic CMS verification — must pass. If `false`, the CMS itself
  //    was forged (the signature doesn't match the public key), so nothing
  //    downstream is trustworthy.
  if (signer.cmsSignatureValid === false) return 'invalid';

  // 2. Need both the embedded digest + the algorithm to recompute and compare.
  if (!signer.embeddedDigest || !signer.digestAlgorithm) return 'unknown';

  let computed: Uint8Array;
  try {
    computed = computeByteRangeHash(pdfBytes, byteRange, signer.digestAlgorithm);
  } catch {
    return 'unknown';
  }
  const a = Buffer.from(signer.embeddedDigest);
  const b = Buffer.from(computed);
  if (a.length !== b.length || !a.equals(b)) return 'invalid';

  // 3. Hash matches. If we couldn't fully verify the CMS signature (parser
  //    couldn't even attempt it), don't claim "valid" — fall back to unknown.
  if (signer.cmsSignatureValid !== true) return 'unknown';

  // 4. A signature is "modified-after" if there are appended bytes past what
  //    the byte-range covers. The signature itself is still cryptographically
  //    valid for the bytes it covers; the warning is that the trailing bytes
  //    are unsigned.
  const lastSignedByte = byteRange[2] + byteRange[3];
  if (lastSignedByte < pdfBytes.length) return 'modified-after';

  return 'untampered';
}

/** Returns true if the signature references DocMDP transform params, which
 * means it's a certification (author) signature rather than a plain
 * approval signature. */
function isCertificationSignature(sigDict: PDFDict): boolean {
  const refArr = sigDict.lookupMaybe(PDFName.of('Reference'), PDFArray);
  if (!refArr) return false;
  for (let i = 0; i < refArr.size(); i++) {
    const ref = refArr.lookup(i);
    if (!(ref instanceof PDFDict)) continue;
    const tm = ref.lookupMaybe(PDFName.of('TransformMethod'), PDFName);
    if (tm && tm.asString() === '/DocMDP') return true;
  }
  return false;
}

export async function inspectSignatures(
  filePath: string,
  password?: string,
): Promise<ExistingSignatureInfo[]> {
  let pdfBytes: Buffer;
  try {
    pdfBytes = await fs.readFile(filePath);
  } catch (err) {
    throw new NodePdfError('READ_FAILED', `Failed to read PDF: ${filePath}`, err);
  }

  let doc: PDFDocument;
  try {
    // ignoreEncryption lets us walk the structure even if we don't have the
    // password — signature fields and ByteRange are not encrypted (they
    // can't be, since the hash covers the encrypted bytes verbatim).
    doc = await PDFDocument.load(pdfBytes, {
      password,
      ignoreEncryption: true,
    });
  } catch {
    // Not a parseable PDF → no signatures to report (rather than crash).
    return [];
  }

  // AcroForm lives under the catalog. Some PDFs don't have one at all,
  // which is fine — no signatures.
  const acroFormRef = doc.catalog.get(PDFName.of('AcroForm'));
  if (!acroFormRef) return [];
  const acroForm =
    acroFormRef instanceof PDFRef
      ? doc.context.lookup(acroFormRef, PDFDict)
      : acroFormRef instanceof PDFDict
        ? acroFormRef
        : null;
  if (!acroForm) return [];

  const fields = acroForm.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) return [];

  const sigFields = collectSignatureFields(doc, fields);
  const result: ExistingSignatureInfo[] = [];

  for (const { fieldName, sigDict } of sigFields) {
    const subFilterNode = sigDict.lookupMaybe(PDFName.of('SubFilter'), PDFName);
    const subFilter = subFilterNode ? subFilterNode.asString().replace(/^\//, '') : '';

    const byteRange = extractByteRange(sigDict);
    const cms = extractCmsBytes(sigDict);

    let signerInfo: SignerInfo = {
      signerName: null,
      issuerCN: null,
      signedAt: null,
      digestAlgorithm: null,
      embeddedDigest: null,
      cmsSignatureValid: null,
      validFrom: null,
      validTo: null,
      trustStatus: 'unknown',
      trustedRootCN: null,
    };
    // Branch on SubFilter: adbe.x509.rsa_sha1 is a pre-PKCS#7 format where
    // /Contents is a raw RSA signature and the cert is in /Cert — totally
    // different parsing than the CMS-based subFilters.
    if (subFilter === 'adbe.x509.rsa_sha1') {
      signerInfo = parseLegacyRsaX509(sigDict, pdfBytes, byteRange);
    } else if (cms) {
      signerInfo = parseCms(cms);
    }

    let integrity: SignatureIntegrityStatus = 'unknown';
    if (byteRange) integrity = classifyIntegrity(pdfBytes, byteRange, signerInfo);

    // Fall back to /M (PDF-level signing time) if CMS didn't expose one.
    let signedAt = signerInfo.signedAt;
    if (!signedAt) {
      const m = sigDict.lookupMaybe(PDFName.of('M'), PDFString);
      if (m) signedAt = parsePdfDate(m.asString());
    }

    // /Name in the sig dict (some signers set this even when the cert CN
    // is empty or generic).
    let signerName = signerInfo.signerName;
    if (!signerName) {
      const nameNode = sigDict.lookupMaybe(PDFName.of('Name'), PDFString, PDFHexString);
      if (nameNode) {
        signerName = nameNode instanceof PDFHexString ? nameNode.decodeText() : nameNode.asString();
      }
    }

    const reasonNode = sigDict.lookupMaybe(PDFName.of('Reason'), PDFString, PDFHexString);
    const locationNode = sigDict.lookupMaybe(PDFName.of('Location'), PDFString, PDFHexString);

    // Trust dimension already computed inside parseCms (verifyTrustChain
    // returns 'trusted' / 'self-signed' / 'untrusted' / 'unknown').
    const isSelfSigned = signerInfo.trustStatus === 'self-signed';

    // Temporal validity: compute three independent flags.
    //  - validNow:        cert is currently within its validity window
    //  - validAtSigning:  cert was within its window at the time of signing
    //                     (null when either bound or signedAt is missing)
    //  - expiredNow:      cert's notAfter is in the past (today)
    // We expose all three so the UI can render the LTV story honestly:
    // "expired NOW but VALID at signing" is the normal case for archived
    // signatures and is materially different from "never valid".
    const now = Date.now();
    const vFrom = signerInfo.validFrom ? Date.parse(signerInfo.validFrom) : NaN;
    const vTo = signerInfo.validTo ? Date.parse(signerInfo.validTo) : NaN;
    const signedTs = signerInfo.signedAt ? Date.parse(signerInfo.signedAt) : NaN;

    const validNow =
      Number.isFinite(vFrom) && Number.isFinite(vTo)
        ? now >= vFrom && now <= vTo
        : null;
    const validAtSigning =
      Number.isFinite(vFrom) && Number.isFinite(vTo) && Number.isFinite(signedTs)
        ? signedTs >= vFrom && signedTs <= vTo
        : null;
    const expiredNow =
      Number.isFinite(vTo) ? now > vTo : null;

    result.push({
      fieldName,
      subFilter,
      signerName,
      issuerCN: signerInfo.issuerCN,
      isSelfSigned,
      signedAt,
      ...(reasonNode
        ? {
            reason:
              reasonNode instanceof PDFHexString
                ? reasonNode.decodeText()
                : reasonNode.asString(),
          }
        : {}),
      ...(locationNode
        ? {
            location:
              locationNode instanceof PDFHexString
                ? locationNode.decodeText()
                : locationNode.asString(),
          }
        : {}),
      integrity,
      isCertification: isCertificationSignature(sigDict),
      validFrom: signerInfo.validFrom,
      validTo: signerInfo.validTo,
      validNow,
      validAtSigning,
      expiredNow,
      trustStatus: signerInfo.trustStatus,
      trustedRootCN: signerInfo.trustedRootCN,
    });
  }

  return result;
}
