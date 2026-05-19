import fs from 'node:fs/promises';

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFImage,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
} from '@cantoo/pdf-lib';
import forge from 'node-forge';

import { NodePdfError } from '~shared/types/errors.js';
import type { NormRect } from '~shared/types/stamps.js';

import { readCertP12 } from '../certs/storage.js';
import { parseP12 } from '../certs/crypto.js';
import { safeWritePdf } from '../pdf/safe-write.js';
import { fetchOcspResponseRaw } from './ocsp.js';
import { findSignature } from './storage.js';
import { requestTimestampToken } from './tsa.js';

/**
 * PDF cryptographic signing pipeline (PKCS#7 / CMS detached, adbe.pkcs7.detached).
 *
 * Approach: INCREMENTAL UPDATE. We load the PDF with `forIncrementalUpdate`
 * (which arms an auto-tracking snapshot on the context), attach a /Sig
 * field (+ widget, + AcroForm bookkeeping), then call `doc.commit()` which
 * emits only the *delta* — new objects + modified xref entries + new
 * trailer — appended to the byte-perfect original. This is the canonical
 * way to add signatures to a PDF per ISO 32000 §12.8 and unlocks two
 * important cases:
 *
 *  1. Encrypted PDFs work without re-encryption (which would shift offsets
 *     and break ByteRange). The original encrypted objects stay encrypted;
 *     the new /Sig.Contents is exempt from encryption per spec, so the
 *     placeholder remains findable in the appended bytes.
 *  2. Multi-signing: each subsequent sign is another incremental layer that
 *     doesn't disturb earlier signatures' byte ranges.
 *
 * Pipeline:
 *
 *  1. Load with `forIncrementalUpdate: true` — pdf-lib auto-arms a snapshot
 *     on the context and starts tracking mutations.
 *  2. Embed image (if visible) + register a /Sig dict whose /ByteRange is a
 *     known-pattern placeholder and whose /Contents is a 16 KB all-zero hex
 *     slot. Attach a widget annotation (visible or invisible) to the target
 *     page; update AcroForm.Fields. The mutations to existing objects
 *     (catalog → AcroForm, page → /Annots) get auto-marked for incremental
 *     output thanks to the snapshot tracking.
 *  3. Call `doc.commit({ useObjectStreams: false })`. Returns the FULL
 *     signed PDF bytes (original + appended incremental section).
 *  4. Locate the /Contents placeholder in the combined bytes, derive the
 *     real ByteRange (covers the entire file except the hex slot), patch
 *     the ByteRange placeholder in place (preserving byte length).
 *  5. Hash the byte range with SHA-256 via node-forge's PKCS#7 pipeline
 *     (which auto-populates the `messageDigest` signed attribute).
 *  6. Optionally request a TSA TimeStampToken and embed it as an
 *     unsignedAttribute on the SignerInfo (PAdES-T).
 *  7. Hex-encode + zero-pad the CMS into the Contents slot.
 *
 * Caveats:
 *  - Trust chain validation is Mozilla-bundle only (no OS trust store yet)
 *    — that's why a self-signed cert shows "validity unknown" in Reader.
 *  - We don't yet do OCSP/CRL revocation checking at sign time (Fase 5+).
 */

const PLACEHOLDER_BYTE_LENGTH = 16384; // 16 KB CMS slot
const PLACEHOLDER_HEX_LENGTH = PLACEHOLDER_BYTE_LENGTH * 2;
// The dummy 1000000000 is just a marker we look for after pdf-lib serializes
// the array; the exact whitespace inside `[ ]` varies by pdf-lib version,
// so the on-disk pattern is matched with a regex that tolerates either
// `[0 ...]` or `[ 0 ... ]` and any whitespace between numbers.
const BYTE_RANGE_PATTERN =
  /\/ByteRange\s*\[\s*0\s+1000000000\s+1000000000\s+1000000000\s*\]/;

export interface SignDigitalOptions {
  filePath: string;
  certId: string;
  certPassword: string;
  password?: string;
  reason?: string;
  location?: string;
  contactInfo?: string;
  /** Optional id of a stored visual signature (eSignature from Fase 1).
   * When present, the /Sig widget gets a Form XObject /AP/N appearance
   * showing the image at the given page+rect — the signature becomes
   * VISIBLE on the page instead of just appearing in the Signatures panel. */
  visualSignatureId?: string;
  /** 0-based page index for the visible appearance. Required when
   * visualSignatureId is set; ignored otherwise. */
  pageIndex?: number;
  /** Normalized [0..1] rect in top-left coords (renderer convention).
   * Required when visualSignatureId is set; ignored otherwise. */
  rect?: NormRect;
  /** Optional RFC 3161 Trusted Timestamp Authority URL. When set, we POST
   * SHA-256(signatureValue) to the TSA and embed the returned token as an
   * unsignedAttribute in the SignerInfo. This upgrades the signature to
   * PAdES-T and proves the signature existed at the TSA's reported time,
   * which keeps it verifiable after the signer's cert expires. */
  tsaUrl?: string;
  /** PAdES-LT (Long Term): stapling. When true, we pre-fetch the OCSP
   * response for the signer cert and embed it — along with the full cert
   * chain — into the document's /DSS so verifiers can validate the
   * signature OFFLINE for years to come (no dependency on the OCSP
   * responder still being up). Best-effort: if OCSP fetch fails, we still
   * embed the certs but signing continues. */
  embedRevocationInfo?: boolean;
}

/** Format a Date as PDF date string: `D:YYYYMMDDHHmmSSZ`. */
function formatPdfDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `D:${d.getUTCFullYear()}` +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

/**
 * OID for `id-aa-signatureTimeStampToken` — the unsignedAttribute that
 * carries an RFC 3161 TimeStampToken inside a SignerInfo. Verifiers chain
 * the TST's own signature back to a trusted TSA root and treat the
 * resulting timestamp as proof the signature existed at that time.
 */
const OID_SIG_TIMESTAMP_TOKEN = '1.2.840.113549.1.9.16.2.14';

/** Walk the CMS ASN.1 tree built by forge.pkcs7 and find the bytes of the
 * SignerInfo's signatureValue (an OCTET STRING in the standard layout).
 * We need this to hash for the TSA request — the TST signs the signature
 * value, which is what proves "this signature existed at time X". */
function extractSignerInfoSignatureBytes(cms: forge.asn1.Asn1): Buffer {
  // ContentInfo SEQ → [0] EXPLICIT SignedData SEQ → ... → signerInfos SET
  // → SignerInfo SEQ → walk children to find the OCTET STRING after any
  // [0] IMPL signedAttrs.
  const ciChildren = cms.value as forge.asn1.Asn1[];
  const explicit = ciChildren[1]!;
  const signedData = (explicit.value as forge.asn1.Asn1[])[0]!;
  const sdChildren = signedData.value as forge.asn1.Asn1[];
  // signerInfos is the only universal SET in SignedData.
  let signerInfos: forge.asn1.Asn1 | null = null;
  for (const ch of sdChildren) {
    if (
      ch.tagClass === forge.asn1.Class.UNIVERSAL &&
      (ch.type as number) === forge.asn1.Type.SET
    ) {
      signerInfos = ch;
    }
  }
  if (!signerInfos) throw new NodePdfError('READ_FAILED', 'CMS has no signerInfos');
  const signerInfo = (signerInfos.value as forge.asn1.Asn1[])[0]!;
  const siChildren = signerInfo.value as forge.asn1.Asn1[];
  // Layout: [version, sid, digestAlg, signedAttrs?, sigAlg, signature, unsignedAttrs?]
  let idx = 3;
  const maybeSigned = siChildren[idx];
  if (
    maybeSigned &&
    maybeSigned.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC &&
    (maybeSigned.type as number) === 0
  ) {
    idx++;
  }
  idx++; // skip sigAlg SEQ
  const sigNode = siChildren[idx];
  if (!sigNode || typeof sigNode.value !== 'string') {
    throw new NodePdfError('READ_FAILED', 'CMS signatureValue not found');
  }
  const raw = sigNode.value;
  const buf = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i) & 0xff;
  return buf;
}

/** Inject (or extend) the SignerInfo's unsignedAttributes with the given
 * attribute, by mutating the ASN.1 tree in place. Used to attach the TSA
 * TimeStampToken without going through forge's high-level API (which
 * doesn't expose post-sign mutation cleanly). */
function injectUnsignedAttribute(
  cms: forge.asn1.Asn1,
  attrTypeOid: string,
  attrValue: forge.asn1.Asn1,
): void {
  const ciChildren = cms.value as forge.asn1.Asn1[];
  const explicit = ciChildren[1]!;
  const signedData = (explicit.value as forge.asn1.Asn1[])[0]!;
  const sdChildren = signedData.value as forge.asn1.Asn1[];
  let signerInfos: forge.asn1.Asn1 | null = null;
  for (const ch of sdChildren) {
    if (
      ch.tagClass === forge.asn1.Class.UNIVERSAL &&
      (ch.type as number) === forge.asn1.Type.SET
    ) {
      signerInfos = ch;
    }
  }
  if (!signerInfos) throw new NodePdfError('READ_FAILED', 'CMS has no signerInfos');
  const signerInfo = (signerInfos.value as forge.asn1.Asn1[])[0]!;
  const siChildren = signerInfo.value as forge.asn1.Asn1[];

  // Attribute SEQ { OID, SET OF AttributeValue }
  const attribute = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.SEQUENCE,
    true,
    [
      forge.asn1.create(
        forge.asn1.Class.UNIVERSAL,
        forge.asn1.Type.OID,
        false,
        forge.asn1.oidToDer(attrTypeOid).getBytes(),
      ),
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, [
        attrValue,
      ]),
    ],
  );

  // Check if unsignedAttrs already exists (CONTEXT [1] IMPLICIT). If so,
  // append our attribute to it; otherwise create a new one.
  const last = siChildren[siChildren.length - 1];
  if (
    last &&
    last.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC &&
    (last.type as number) === 1
  ) {
    (last.value as forge.asn1.Asn1[]).push(attribute);
  } else {
    const unsignedAttrs = forge.asn1.create(
      forge.asn1.Class.CONTEXT_SPECIFIC,
      1,
      true,
      [attribute],
    );
    siChildren.push(unsignedAttrs);
  }
}

/**
 * Construct a SignedData CMS message over the concatenated byte range using
 * the supplied cert + key. Returns the DER bytes (binary string from forge,
 * one byte per char — caller hex-encodes).
 *
 * When `tsaUrl` is provided, after sign() we hash the resulting
 * signatureValue, request an RFC 3161 TimeStampToken from the TSA, and
 * embed it as an unsignedAttribute in the SignerInfo — upgrading the
 * signature to PAdES-T grade (still verifiable after cert expiry).
 */
async function buildCmsSignature(
  cert: forge.pki.Certificate,
  keyPem: string,
  signedContent: Buffer,
  tsaUrl?: string,
): Promise<Uint8Array> {
  const p7 = forge.pkcs7.createSignedData();
  // forge owns the binary→ASN.1 dance; pass a binary string buffer.
  p7.content = forge.util.createBuffer(signedContent.toString('binary'));
  p7.addCertificate(cert);
  // `@types/node-forge` types each OID lookup as `string | undefined`, but
  // every name on this list is a built-in forge constant guaranteed to be
  // present. Pull them through a typed helper to satisfy `Attribute.type`.
  const oid = (name: keyof typeof forge.pki.oids): string => forge.pki.oids[name]!;
  p7.addSigner({
    key: keyPem,
    certificate: cert,
    digestAlgorithm: oid('sha256'),
    authenticatedAttributes: [
      // contentType + messageDigest are required by RFC 5652 §11.
      { type: oid('contentType'), value: oid('data') },
      // value is auto-populated from sha256 of p7.content during sign().
      { type: oid('messageDigest') },
      // Must be a Date — forge.asn1.dateToUtcTime returns string inputs
      // as-is, which would embed a JS toString() date into the UTCTime
      // slot and produce a malformed CMS that parsers reject. @types/node-forge
      // types `value` as string only, but the runtime contract is broader.
      { type: oid('signingTime'), value: new Date() as unknown as string },
    ],
  });
  p7.sign({ detached: true });

  const cmsAsn1 = p7.toAsn1();

  if (tsaUrl) {
    // PAdES-T upgrade: hash the signatureValue, ask the TSA to timestamp
    // that hash, embed the returned TST as an unsignedAttribute. The
    // signature won't expire when the signer cert does.
    const sigValueBytes = extractSignerInfoSignatureBytes(cmsAsn1);
    const tst = await requestTimestampToken(sigValueBytes, { url: tsaUrl });
    injectUnsignedAttribute(cmsAsn1, OID_SIG_TIMESTAMP_TOKEN, tst);
  }

  const der = forge.asn1.toDer(cmsAsn1).getBytes();
  const out = new Uint8Array(der.length);
  for (let i = 0; i < der.length; i++) out[i] = der.charCodeAt(i) & 0xff;
  return out;
}

/** Locate `/Contents <00...00>` (the entire hex string slot including the
 * angle brackets) and return its bracket-inclusive start and exclusive end
 * offsets. */
function findContentsPlaceholder(pdfBytes: Buffer): {
  contentsStart: number;
  contentsEnd: number;
} {
  // Build the exact placeholder pattern (Buffer for indexOf efficiency).
  // Pattern is `<` + zeros + `>` — pdf-lib serializes PDFHexString that way.
  const pattern = Buffer.alloc(PLACEHOLDER_HEX_LENGTH + 2);
  pattern[0] = 0x3c; // '<'
  pattern.fill(0x30, 1, PLACEHOLDER_HEX_LENGTH + 1); // '0'
  pattern[PLACEHOLDER_HEX_LENGTH + 1] = 0x3e; // '>'

  const start = pdfBytes.indexOf(pattern);
  if (start === -1) {
    throw new NodePdfError(
      'READ_FAILED',
      'Signature placeholder not found in saved PDF (pdf-lib serialization changed?)',
    );
  }
  return {
    contentsStart: start,
    contentsEnd: start + pattern.length,
  };
}

/** Replace the ByteRange placeholder array with the real values, preserving
 * the original byte length by right-padding the replacement with spaces.
 *
 * The placeholder is matched by regex (not by exact-string search) because
 * pdf-lib's PDFArray serialization wraps the array in `[ ... ]` or `[...]`
 * depending on version, and putting a value-shaped marker (1000000000) in
 * each of the three placeholder slots gives us a uniquely identifiable
 * landmark without being sensitive to exact whitespace. */
function patchByteRange(
  pdfBytes: Buffer,
  byteRange: [number, number, number, number],
): Buffer {
  // Search inside a latin1 view so byte offsets line up with string indices.
  const view = pdfBytes.toString('latin1');
  const match = BYTE_RANGE_PATTERN.exec(view);
  if (!match) {
    throw new NodePdfError(
      'READ_FAILED',
      'ByteRange placeholder not found in saved PDF (pdf-lib serialization changed?)',
    );
  }
  const start = match.index;
  const matchedLength = match[0].length;
  const real = `/ByteRange [${byteRange[0]} ${byteRange[1]} ${byteRange[2]} ${byteRange[3]}]`;
  if (real.length > matchedLength) {
    throw new NodePdfError(
      'READ_FAILED',
      `ByteRange values too large for placeholder slot (got ${real.length}, slot ${matchedLength})`,
    );
  }
  const padded = Buffer.from(real.padEnd(matchedLength, ' '), 'latin1');
  return Buffer.concat([
    pdfBytes.subarray(0, start),
    padded,
    pdfBytes.subarray(start + matchedLength),
  ]);
}

/** Write a hex-encoded CMS into the Contents placeholder slot, padded with
 * '0' chars to fill the full 32 KB hex window. */
function patchContents(pdfBytes: Buffer, hexStart: number, cmsDer: Uint8Array): Buffer {
  // hexStart points at '<' — actual hex begins at hexStart + 1.
  const hexInner = hexStart + 1;
  let cmsHex = '';
  for (let i = 0; i < cmsDer.length; i++) {
    cmsHex += cmsDer[i]!.toString(16).padStart(2, '0');
  }
  if (cmsHex.length > PLACEHOLDER_HEX_LENGTH) {
    throw new NodePdfError(
      'READ_FAILED',
      `CMS signature is ${cmsHex.length} hex chars, exceeds ${PLACEHOLDER_HEX_LENGTH}-char placeholder`,
    );
  }
  const padded = cmsHex.padEnd(PLACEHOLDER_HEX_LENGTH, '0');
  const out = Buffer.from(pdfBytes);
  out.write(padded, hexInner, 'latin1');
  return out;
}

/**
 * Build the Form XObject that the /Sig widget uses as its /AP /N visual
 * appearance. The content stream is a tiny PostScript-flavored snippet:
 *
 *   q  width 0 0 height 0 0 cm  /Im0 Do  Q
 *
 * which positions the embedded image at the BBox origin and scales it to
 * BBox size. Resources reference the Image XObject under the local name
 * `Im0` (the only one we use).
 */
function buildAppearanceStream(
  doc: PDFDocument,
  image: PDFImage,
  widthPt: number,
  heightPt: number,
): PDFRawStream {
  const ctx = doc.context;
  // pdf-lib serializes numbers fine; we just need integers/floats with
  // enough precision for sub-point alignment.
  const w = widthPt.toFixed(2);
  const h = heightPt.toFixed(2);
  const contentBytes = new TextEncoder().encode(
    `q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`,
  );

  const resources = ctx.obj({
    XObject: ctx.obj({
      Im0: image.ref,
    }),
    // /ProcSet is legacy but Adobe Reader still flags its absence in some
    // strict modes. Tiny cost to include it for max compatibility.
    ProcSet: ['PDF', 'ImageC'],
  });
  const formDict = ctx.obj({
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, widthPt, heightPt],
    Resources: resources,
  });
  return PDFRawStream.of(formDict, contentBytes);
}

interface VisibleAppearance {
  pageIndex: number;
  /** PDF-coords rect (origin at bottom-left). */
  pdfRect: { x: number; y: number; width: number; height: number };
  image: PDFImage;
}

/** Serialize a forge cert to its DER bytes (Uint8Array). */
function certToDer(cert: forge.pki.Certificate): Uint8Array {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const out = new Uint8Array(der.length);
  for (let i = 0; i < der.length; i++) out[i] = der.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Embed Long-Term Validation artifacts (cert chain + OCSP responses) into
 * the document's /DSS (Document Security Store) — the standard PAdES-LT
 * mechanism for offline verification. See ETSI EN 319 142-1 §5.4.2.
 *
 *   /Catalog
 *     /DSS <<
 *       /Certs [<cert_stream> <cert_stream> ...]
 *       /OCSPs [<ocsp_stream> ...]
 *     >>
 *
 * Each entry is an indirect reference to a stream object whose raw bytes
 * are the DER encoding of the artifact. With /DSS in place a verifier can
 * answer "was this cert valid at signing time?" without ANY network access,
 * which matters because:
 *
 *   - OCSP responders go offline; URLs change.
 *   - Network might be restricted at the verifier's end (air-gapped audit).
 *   - The verifier may be examining the document years after signing.
 *
 * We deliberately put the /DSS in the SAME incremental update as the /Sig
 * field. That way the /Sig's ByteRange covers the /DSS bytes too — the
 * stapled validation info is itself authenticated by the signature, so an
 * attacker can't strip + re-staple their own "this cert is good" claim.
 */
function addDocumentSecurityStore(
  doc: PDFDocument,
  certs: forge.pki.Certificate[],
  ocspResponses: Uint8Array[],
): void {
  if (certs.length === 0 && ocspResponses.length === 0) return;
  const ctx = doc.context;

  // Embed each cert as its own indirect stream object.
  const certRefs: PDFRef[] = certs.map((cert) => {
    const der = certToDer(cert);
    const streamDict = ctx.obj({ Length: der.length });
    const stream = PDFRawStream.of(streamDict, der);
    return ctx.register(stream);
  });

  const ocspRefs: PDFRef[] = ocspResponses.map((respDer) => {
    const streamDict = ctx.obj({ Length: respDer.length });
    const stream = PDFRawStream.of(streamDict, respDer);
    return ctx.register(stream);
  });

  // Build (or merge) /DSS on the catalog. If a previous incremental update
  // already added one (multi-sig scenarios), we extend its /Certs and
  // /OCSPs arrays instead of overwriting.
  const catalogDssRaw = doc.catalog.get(PDFName.of('DSS'));
  let dss: PDFDict;
  if (catalogDssRaw instanceof PDFDict) {
    dss = catalogDssRaw;
  } else if (catalogDssRaw instanceof PDFRef) {
    const resolved = ctx.lookup(catalogDssRaw);
    dss = resolved instanceof PDFDict ? resolved : ctx.obj({});
    if (!(resolved instanceof PDFDict)) {
      doc.catalog.set(PDFName.of('DSS'), dss);
    }
  } else {
    dss = ctx.obj({});
    doc.catalog.set(PDFName.of('DSS'), dss);
  }

  if (certRefs.length > 0) {
    let certsArr = dss.lookup(PDFName.of('Certs'));
    if (!(certsArr instanceof PDFArray)) {
      certsArr = ctx.obj([]);
      dss.set(PDFName.of('Certs'), certsArr);
    }
    for (const ref of certRefs) (certsArr as PDFArray).push(ref);
  }
  if (ocspRefs.length > 0) {
    let ocspsArr = dss.lookup(PDFName.of('OCSPs'));
    if (!(ocspsArr instanceof PDFArray)) {
      ocspsArr = ctx.obj([]);
      dss.set(PDFName.of('OCSPs'), ocspsArr);
    }
    for (const ref of ocspRefs) (ocspsArr as PDFArray).push(ref);
  }
}

/**
 * Append a /Sig field + widget annotation to the document. With no
 * `visible` arg, the widget is invisible (zero rect + Hidden+Locked flags)
 * and the signature only appears in the viewer's Signatures panel. When
 * `visible` is provided, the widget gets a real rect on the chosen page
 * plus an /AP /N Form XObject that paints the supplied image — what
 * Adobe Reader calls a "visual signature appearance".
 */
function addSignatureField(
  doc: PDFDocument,
  opts: { reason?: string; location?: string; contactInfo?: string },
  visible: VisibleAppearance | null,
): void {
  const ctx = doc.context;

  const sigDict = ctx.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    // Placeholder values that survive serialization at known byte widths.
    // The single-digit zero + 10-digit dummies in BYTE_RANGE_PLACEHOLDER
    // give us a known-length string to find-and-patch.
    ByteRange: [0, 1000000000, 1000000000, 1000000000],
    Contents: PDFHexString.of('0'.repeat(PLACEHOLDER_HEX_LENGTH)),
    M: PDFString.of(formatPdfDate(new Date())),
    ...(opts.reason ? { Reason: PDFString.of(opts.reason) } : {}),
    ...(opts.location ? { Location: PDFString.of(opts.location) } : {}),
    ...(opts.contactInfo ? { ContactInfo: PDFString.of(opts.contactInfo) } : {}),
  });
  const sigRef = ctx.register(sigDict);

  const pages = doc.getPages();
  if (pages.length === 0) {
    throw new NodePdfError('VALIDATION_ERROR', 'PDF has no pages to attach signature to');
  }

  let widgetDict: PDFDict;
  let targetPageIndex: number;
  if (visible) {
    if (visible.pageIndex < 0 || visible.pageIndex >= pages.length) {
      throw new NodePdfError(
        'VALIDATION_ERROR',
        `Page index ${visible.pageIndex} out of range (doc has ${pages.length} pages)`,
      );
    }
    targetPageIndex = visible.pageIndex;
    const r = visible.pdfRect;
    // Build the appearance stream + dict referencing it via /N.
    const apStream = buildAppearanceStream(doc, visible.image, r.width, r.height);
    const apRef = ctx.register(apStream);
    const apDict = ctx.obj({ N: apRef });

    widgetDict = ctx.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      T: PDFString.of(`Signature${Date.now()}`),
      V: sigRef,
      P: pages[targetPageIndex]!.ref,
      // PDF /Rect is [llx lly urx ury] in PDF coords (origin bottom-left).
      Rect: [r.x, r.y, r.x + r.width, r.y + r.height],
      // F=4 = Print flag only. NOT Hidden/Locked so the appearance renders.
      F: 4,
      AP: apDict,
    });
  } else {
    targetPageIndex = 0;
    widgetDict = ctx.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      T: PDFString.of(`Signature${Date.now()}`),
      V: sigRef,
      P: pages[targetPageIndex]!.ref,
      Rect: [0, 0, 0, 0],
      // 0b10000100 = Hidden + Locked. Keeps the widget off-screen and
      // immutable. Adobe still shows the signature in the Signatures panel.
      F: 132,
    });
  }
  const widgetRef = ctx.register(widgetDict);

  // Splice into AcroForm. Create one if the PDF doesn't have a form yet.
  const acroFormRaw = doc.catalog.get(PDFName.of('AcroForm'));
  let acroForm: PDFDict;
  if (acroFormRaw instanceof PDFDict) {
    acroForm = acroFormRaw;
  } else if (acroFormRaw instanceof PDFRef) {
    const resolved = ctx.lookup(acroFormRaw);
    if (resolved instanceof PDFDict) {
      acroForm = resolved;
    } else {
      acroForm = ctx.obj({});
      doc.catalog.set(PDFName.of('AcroForm'), acroForm);
    }
  } else {
    acroForm = ctx.obj({});
    doc.catalog.set(PDFName.of('AcroForm'), acroForm);
  }

  let fields = acroForm.lookup(PDFName.of('Fields'));
  if (!(fields instanceof PDFArray)) {
    fields = ctx.obj([]);
    acroForm.set(PDFName.of('Fields'), fields);
  }
  (fields as PDFArray).push(widgetRef);

  // SigFlags: bit 1 = SignaturesExist, bit 2 = AppendOnly. Set both for
  // safety so viewers know modifications require an incremental update.
  acroForm.set(PDFName.of('SigFlags'), PDFNumber.of(3));

  // The page hosting the widget MUST include it in its /Annots — both for
  // visible (so Reader paints it) and invisible (so Reader can resolve
  // clicks / focus / signature panel cross-references). Use `lookup` (not
  // `get`) here so we follow indirect refs: if /Annots was already an
  // indirect array (which is normal), `get` would return the bare PDFRef
  // and our `instanceof PDFArray` check would fall through to the else,
  // OVERWRITING the page's existing annotations (e.g. prior signature
  // widgets from a previous incremental update) with a new one-element
  // array. That's the bug that caused earlier signatures to vanish.
  const targetPage = pages[targetPageIndex]!;
  const annotsResolved = targetPage.node.lookup(PDFName.of('Annots'));
  if (annotsResolved instanceof PDFArray) {
    annotsResolved.push(widgetRef);
  } else {
    targetPage.node.set(PDFName.of('Annots'), ctx.obj([widgetRef]));
  }
}

export async function signPdfDigitally(opts: SignDigitalOptions): Promise<void> {
  // ---- 1. Read PDF + cert ------------------------------------------------
  let pdfBytes: Buffer;
  try {
    pdfBytes = await fs.readFile(opts.filePath);
  } catch (err) {
    throw new NodePdfError(
      'READ_FAILED',
      `Failed to read PDF: ${opts.filePath}`,
      err,
    );
  }

  const p12Bytes = await readCertP12(opts.certId);
  if (!p12Bytes) {
    throw new NodePdfError('VALIDATION_ERROR', 'Certificate not found');
  }
  const { cert, chain, keyPem } = parseP12(new Uint8Array(p12Bytes), opts.certPassword);

  // ---- 2. Add placeholder /Sig field + save (incremental) ----------------
  // Loading with `forIncrementalUpdate: true` makes pdf-lib auto-track
  // mutations against the snapshot it takes at load time. We use the
  // `commit()` helper later — it serializes only changed objects + a new
  // xref + trailer, then concatenates onto the original byte-perfect
  // source. Critical for two reasons:
  //   1. Encrypted PDFs: original encrypted objects stay encrypted; we
  //      only add new objects. /Sig.Contents is exempt from encryption
  //      per spec so the placeholder remains findable.
  //   2. Multi-sig PDFs: adding signature #2 doesn't invalidate
  //      signature #1 because #1's byte-range bytes don't change.
  // DO NOT call takeSnapshot() manually — when forIncrementalUpdate has
  // already armed context.snapshot, takeSnapshot returns a NEW empty
  // snapshot that won't reflect any of our mutations. The auto-tracked
  // snapshot inside context.snapshot is the one commit() consults.
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBytes, {
      forIncrementalUpdate: true,
      ...(opts.password ? { password: opts.password } : {}),
    });
  } catch (err) {
    throw new NodePdfError('INVALID_PDF', 'PDF could not be parsed', err);
  }

  // Prepare the visible appearance (if requested) BEFORE saving — we need
  // pdf-lib to embed the image as an Image XObject during serialization.
  let visible: VisibleAppearance | null = null;
  if (opts.visualSignatureId) {
    if (
      opts.pageIndex === undefined ||
      !opts.rect ||
      ![opts.rect.x, opts.rect.y, opts.rect.w, opts.rect.h].every(
        (n) => Number.isFinite(n) && n >= 0 && n <= 1,
      )
    ) {
      throw new NodePdfError(
        'VALIDATION_ERROR',
        'Visible signature requires pageIndex + normalized rect (0..1)',
      );
    }
    const found = await findSignature(opts.visualSignatureId);
    if (!found) {
      throw new NodePdfError(
        'VALIDATION_ERROR',
        `Visual signature not found: ${opts.visualSignatureId}`,
      );
    }
    const imageBytes = new Uint8Array(found.bytes);
    const image =
      found.signature.ext === 'png'
        ? await doc.embedPng(imageBytes)
        : await doc.embedJpg(imageBytes);
    const page = doc.getPages()[opts.pageIndex];
    if (!page) {
      throw new NodePdfError(
        'VALIDATION_ERROR',
        `Page index ${opts.pageIndex} out of range`,
      );
    }
    const { width: pageW, height: pageH } = page.getSize();
    const widthPt = opts.rect.w * pageW;
    const heightPt = opts.rect.h * pageH;
    // Renderer rect uses top-left origin; PDF uses bottom-left. Convert.
    const xPt = opts.rect.x * pageW;
    const yPt = pageH - opts.rect.y * pageH - heightPt;
    visible = {
      pageIndex: opts.pageIndex,
      pdfRect: { x: xPt, y: yPt, width: widthPt, height: heightPt },
      image,
    };
  }

  // PAdES-LT: pre-fetch OCSP for the signer cert + embed cert chain into
  // /DSS BEFORE adding the /Sig field. This way the /Sig's ByteRange will
  // cover the /DSS bytes — the validation info is itself authenticated.
  // Skipped automatically when:
  //  - User didn't request it (embedRevocationInfo !== true)
  //  - Chain has no issuer cert (self-signed → no OCSP to ask anyway, but
  //    we still embed the cert itself so verifiers have it)
  if (opts.embedRevocationInfo) {
    const ocspResponses: Uint8Array[] = [];
    if (chain.length >= 2) {
      try {
        const raw = await fetchOcspResponseRaw({
          cert: chain[0]!,
          issuerCert: chain[1]!,
        });
        if (raw) ocspResponses.push(raw);
      } catch {
        // Network / responder failure — proceed without the OCSP staple.
        // Cert chain alone still gives the verifier something to work with.
      }
    }
    addDocumentSecurityStore(doc, chain, ocspResponses);
  }

  addSignatureField(
    doc,
    {
      reason: opts.reason,
      location: opts.location,
      contactInfo: opts.contactInfo,
    },
    visible,
  );

  // Object streams MUST be off — placeholder bytes need to be findable in
  // the raw output, and stream compression would mask them. commit() does
  // saveIncremental with the auto-tracked snapshot AND concatenates the
  // original bytes for us — returning the full signed PDF in one shot.
  let combinedBytes: Uint8Array;
  try {
    combinedBytes = await doc.commit({ useObjectStreams: false });
  } catch (err) {
    throw new NodePdfError('READ_FAILED', 'Failed to serialize incremental update', err);
  }

  // ---- 3. Locate placeholder + patch ByteRange ---------------------------
  // The /Sig dict (with placeholder Contents) lives in the appended
  // incremental section. ByteRange will end up covering the whole file
  // except the Contents hex slot.
  let buf = Buffer.from(combinedBytes);
  const { contentsStart, contentsEnd } = findContentsPlaceholder(buf);
  const byteRange: [number, number, number, number] = [
    0,
    contentsStart,
    contentsEnd,
    buf.length - contentsEnd,
  ];
  buf = patchByteRange(buf, byteRange);

  // ---- 4. Build CMS over the signed byte range ----------------------------
  const signedContent = Buffer.concat([
    buf.subarray(0, contentsStart),
    buf.subarray(contentsEnd),
  ]);
  let cms: Uint8Array;
  try {
    cms = await buildCmsSignature(cert, keyPem, signedContent, opts.tsaUrl);
  } catch (err) {
    if (err instanceof NodePdfError) throw err;
    throw new NodePdfError('READ_FAILED', 'Failed to build CMS signature', err);
  }

  // ---- 5. Write CMS into Contents slot ------------------------------------
  buf = patchContents(buf, contentsStart, cms);

  // ---- 6. Persist ---------------------------------------------------------
  // Validate before overwriting so a botched CMS patch or trailing-trailer
  // mismatch doesn't destroy the source. safeWritePdf re-parses the
  // bytes (header + EOF check + pdf-lib round-trip) and throws if
  // anything looks off — the original file stays intact for retry.
  await safeWritePdf(opts.filePath, buf, {
    password: opts.password,
    context: 'signDigital',
  });
}
