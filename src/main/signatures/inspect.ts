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
} from '~shared/types/signatures.js';

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
    const localName = partial ? partial.decodeText() : '';
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
  signedAt: string | null;
  digestAlgorithm: string | null;
  embeddedDigest: Uint8Array | null;
}

/** Pull signer-friendly metadata + the embedded message digest out of a CMS
 * SignedData blob. Returns nulls for fields we couldn't decode rather than
 * throwing — callers fall back to PDF-level metadata. */
function parseCms(cms: Uint8Array): SignerInfo {
  const result: SignerInfo = {
    signerName: null,
    signedAt: null,
    digestAlgorithm: null,
    embeddedDigest: null,
  };
  try {
    const binary = forge.util.createBuffer(Buffer.from(cms).toString('binary'));
    const asn1 = forge.asn1.fromDer(binary, false);
    // @types/node-forge doesn't model `rawCapture` (an undocumented field
    // forge populates during parse with the raw ASN.1 subtree of each
    // SignerInfo). It's the only way to reach the signed attributes; we
    // structurally type it instead of casting through `any`.
    const p7 = forge.pkcs7.messageFromAsn1(asn1) as forge.pkcs7.PkcsSignedData & {
      rawCapture?: { signerInfos?: forge.asn1.Asn1[] };
    };

    // Signer cert subject CN. PkcsSignedData exposes signers via `certificates`;
    // for non-certification signatures there's usually exactly one.
    const cert = p7.certificates?.[0];
    if (cert) {
      const cn = cert.subject.getField('CN');
      if (cn && typeof cn.value === 'string') {
        result.signerName = cn.value;
      } else {
        // Fall back to any DN component so we don't show "null" for certs
        // that omit CN (uncommon but legal).
        const first = cert.subject.attributes[0];
        if (first && typeof first.value === 'string') result.signerName = first.value;
      }
    }

    // Signed attributes: id-signingTime (1.2.840.113549.1.9.5) and the
    // signed message digest (id-messageDigest, 1.2.840.113549.1.9.4).
    const signer = p7.rawCapture?.signerInfos?.[0];
    const signerChildren = signer && Array.isArray(signer.value) ? signer.value : null;
    if (signerChildren) {
      const authAttrs = signerChildren[3];
      const attrList =
        authAttrs && Array.isArray(authAttrs.value) ? authAttrs.value : null;
      if (attrList) {
        for (const attr of attrList) {
          const attrChildren = Array.isArray(attr.value) ? attr.value : null;
          if (!attrChildren) continue;
          const oidNode = attrChildren[0];
          const valueSet = attrChildren[1];
          if (!oidNode || typeof oidNode.value !== 'string') continue;
          const oid = forge.asn1.derToOid(oidNode.value);
          const inner =
            valueSet && Array.isArray(valueSet.value) ? valueSet.value[0] : null;
          if (!inner || typeof inner.value !== 'string') continue;
          if (oid === '1.2.840.113549.1.9.5') {
            // signingTime — UTCTime or GeneralizedTime, both render through
            // forge.asn1.utcTimeToDate / generalizedTimeToDate cleanly.
            try {
              const date =
                inner.type === forge.asn1.Type.UTCTIME
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
      }
      const digestAlgAsn1 = signerChildren[2];
      const algChildren =
        digestAlgAsn1 && Array.isArray(digestAlgAsn1.value) ? digestAlgAsn1.value : null;
      const algOidNode = algChildren?.[0];
      if (algOidNode && typeof algOidNode.value === 'string') {
        try {
          result.digestAlgorithm = oidToHashName(forge.asn1.derToOid(algOidNode.value));
        } catch {
          // ignored
        }
      }
    }
  } catch {
    // CMS we can't parse → caller treats integrity as 'unknown'.
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

function classifyIntegrity(
  pdfBytes: Buffer,
  byteRange: [number, number, number, number],
  signer: SignerInfo,
): SignatureIntegrityStatus {
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

  // A signature is "modified-after" if there are appended bytes past what
  // the byte-range covers. Adobe's reader calls this "Signed but document
  // was modified after signing"; the signature itself is still valid for
  // its covered range, just incomplete.
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
      signedAt: null,
      digestAlgorithm: null,
      embeddedDigest: null,
    };
    if (cms) signerInfo = parseCms(cms);

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

    result.push({
      fieldName,
      subFilter,
      signerName,
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
    });
  }

  return result;
}
