import { PDFDocument, type PDFRef } from '@cantoo/pdf-lib';

/**
 * pdf-lib silently strips the `/Encrypt` reference from a document's
 * trailerInfo as soon as it successfully decrypts the document with a
 * password (see `PDFDocument.js` constructor: `delete
 * context.trailerInfo.Encrypt;` guarded by `context.isDecrypted`).
 * Subsequent calls to `doc.commit()` or `doc.save()` write a new
 * trailer WITHOUT `/Encrypt`. pdf.js (and many strict viewers) then
 * load the resulting file as if it were unencrypted, try to parse the
 * still-encrypted content streams as raw PDF operators, and render
 * blank pages.
 *
 * Workaround: before pdf-lib processes the doc, do a quick second
 * load with `ignoreEncryption: true` (which keeps the trailer intact)
 * to capture the `/Encrypt` ref. After mutations, restore the ref on
 * the real doc's trailer so the serialized output references the
 * same encryption dict the original file used.
 *
 * The encryption dict object itself is still in the new doc's
 * indirectObjects map (pdf-lib only nukes the trailer pointer, not
 * the object), so re-attaching the ref is enough — no need to copy
 * the dict across contexts.
 */
export async function captureEncryptionRef(
  bytes: Uint8Array | Buffer,
): Promise<PDFRef | null> {
  try {
    const peek = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const encryptRef = peek.context.trailerInfo.Encrypt;
    // trailerInfo.Encrypt is typed as `PDFObject | undefined` in pdf-lib;
    // for an encrypted PDF it's always a PDFRef. Anything else means
    // the file isn't encrypted in a way we can preserve, so skip.
    return encryptRef && typeof encryptRef === 'object' && 'tag' in encryptRef
      ? (encryptRef as PDFRef)
      : null;
  } catch {
    // Couldn't peek — treat as unencrypted, no preservation needed.
    return null;
  }
}

/**
 * Re-attach a previously-captured `/Encrypt` ref to a document's
 * trailerInfo. Idempotent — passing null is a no-op. Call this
 * immediately before `doc.commit()` / `doc.save()` on any doc that
 * was loaded with a password.
 */
export function restoreEncryptionRef(doc: PDFDocument, ref: PDFRef | null): void {
  if (!ref) return;
  doc.context.trailerInfo.Encrypt = ref;
}
