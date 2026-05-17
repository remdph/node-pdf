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

import { readCertP12 } from '../certs/storage.js';
import { parseP12 } from '../certs/crypto.js';

/**
 * PDF cryptographic signing pipeline (PKCS#7 / CMS detached, adbe.pkcs7.detached).
 *
 * The signing flow is the classic placeholder + byte-patch dance:
 *
 *  1. Build a /Sig dict whose /ByteRange is a huge-numbers placeholder and
 *     whose /Contents is an all-zero hex string of `placeholderHexLength`
 *     characters (16 KB binary = 32 KB hex chars by default).
 *  2. Save the PDF with `useObjectStreams: false` so object positions are
 *     deterministic and the placeholder string survives serialization
 *     verbatim. Encryption is incompatible with signatures; we sign first
 *     and re-encrypt the final bytes if the source PDF was encrypted.
 *  3. Locate the placeholder in the output bytes, derive the real ByteRange
 *     from its offsets, and patch the ByteRange placeholder in-place
 *     (preserving byte length so offsets stay stable).
 *  4. Hash the byte range with SHA-256 by way of node-forge's PKCS#7
 *     pipeline (we feed it the raw signed bytes; it derives the hash
 *     internally as the `messageDigest` authenticated attribute).
 *  5. Replace the Contents placeholder with the hex-encoded CMS, padded
 *     with zeros to fill the slot.
 *
 * v1 caveats:
 *  - Only INVISIBLE signatures (no on-page widget appearance). Visual
 *    appearances ride alongside via the eSignature flow (Fase 1).
 *  - Re-encryption restores the default broad permission set on PDFs that
 *    were originally password-protected — same limitation as embedImageOnPage.
 *  - Adobe Reader will show "validity unknown" for self-signed certs
 *    because the root isn't in the AATL. That's expected; user can add the
 *    cert to their trusted identities in Acrobat to upgrade the verdict.
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
 * Construct a SignedData CMS message over the concatenated byte range using
 * the supplied cert + key. Returns the DER bytes (binary string from forge,
 * one byte per char — caller hex-encodes).
 */
function buildCmsSignature(
  cert: forge.pki.Certificate,
  keyPem: string,
  signedContent: Buffer,
): Uint8Array {
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

  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
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

/** Append a signature field + sig dict to the document. The widget is
 * invisible (zero rect on the first page, hidden + locked flags), suitable
 * for a pure-crypto signature without on-page appearance. */
function addInvisibleSignatureField(
  doc: PDFDocument,
  opts: { reason?: string; location?: string; contactInfo?: string },
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

  // The first page is just where we anchor the widget — the rect is zero
  // and flag 0b10000100 = 132 (Hidden + Locked) keeps it off-screen and
  // immutable. Adobe still shows the signature in the Signatures panel.
  const pages = doc.getPages();
  if (pages.length === 0) {
    throw new NodePdfError('VALIDATION_ERROR', 'PDF has no pages to attach signature to');
  }
  const firstPage = pages[0]!;
  const firstPageRef = firstPage.ref;

  const widget = ctx.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    T: PDFString.of(`Signature${Date.now()}`),
    V: sigRef,
    P: firstPageRef,
    Rect: [0, 0, 0, 0],
    F: 132,
  });
  const widgetRef = ctx.register(widget);

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

  // Pages with signature widgets must reference the widget in their /Annots
  // so Reader can find it visually (even though our rect is empty).
  const annotsRaw = firstPage.node.get(PDFName.of('Annots'));
  if (annotsRaw instanceof PDFArray) {
    annotsRaw.push(widgetRef);
  } else {
    firstPage.node.set(PDFName.of('Annots'), ctx.obj([widgetRef]));
  }
}

export async function signPdfDigitally(opts: SignDigitalOptions): Promise<void> {
  if (opts.password) {
    // Fail fast: encryption + signing requires an incremental-update flow
    // we don't have yet (re-encrypting post-sign shifts ByteRange offsets
    // and breaks the hash). User should remove protection first.
    throw new NodePdfError(
      'VALIDATION_ERROR',
      'Cannot digitally sign an encrypted PDF in v1. Remove password protection first, then re-apply it after signing.',
    );
  }

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
  const { cert, keyPem } = parseP12(new Uint8Array(p12Bytes), opts.certPassword);

  // ---- 2. Add placeholder /Sig field + save -------------------------------
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBytes);
  } catch (err) {
    throw new NodePdfError('INVALID_PDF', 'PDF could not be parsed', err);
  }

  addInvisibleSignatureField(doc, {
    reason: opts.reason,
    location: opts.location,
    contactInfo: opts.contactInfo,
  });

  // Object streams MUST be off — placeholder bytes need to be findable in
  // the raw output, and stream compression would mask them.
  let withPlaceholder: Uint8Array;
  try {
    withPlaceholder = await doc.save({ useObjectStreams: false });
  } catch (err) {
    throw new NodePdfError('READ_FAILED', 'Failed to serialize PDF', err);
  }

  // ---- 3. Locate placeholder + patch ByteRange ----------------------------
  let buf = Buffer.from(withPlaceholder);
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
    cms = buildCmsSignature(cert, keyPem, signedContent);
  } catch (err) {
    throw new NodePdfError('READ_FAILED', 'Failed to build CMS signature', err);
  }

  // ---- 5. Write CMS into Contents slot ------------------------------------
  buf = patchContents(buf, contentsStart, cms);

  // ---- 6. Persist ---------------------------------------------------------
  // We refuse to digitally sign encrypted PDFs in v1: re-encrypting after
  // signing would shift /Contents + /ByteRange offsets and break the hash.
  // The proper fix is an incremental-update flow (sign the encrypted bytes
  // as-is via append-only update) which we haven't built yet. Users should
  // remove protection, sign, then re-apply protection via the Protect dialog.
  try {
    await fs.writeFile(opts.filePath, buf);
  } catch (err) {
    throw new NodePdfError(
      'READ_FAILED',
      `Failed to write signed PDF: ${opts.filePath}`,
      err,
    );
  }
}
