import fs from 'node:fs/promises';
import { PDFDocument } from '@cantoo/pdf-lib';

import { NodePdfError } from '~shared/types/errors.js';

/**
 * Multi-layer validation before overwriting an existing PDF on disk.
 *
 * pdf-lib's `commit({ useObjectStreams: false })` has produced silently
 * corrupt incremental saves on some real-world forms (the resulting
 * file's /Root reference no longer resolves, so the next open fails
 * with "Invalid Root reference"). This helper:
 *
 *  1. Confirms the bytes start with `%PDF-` and have `%%EOF` near the
 *     tail — catches obviously-truncated output.
 *  2. Round-trips through `PDFDocument.load` AND touches `.catalog`
 *     so any unresolved /Root pointer surfaces here, BEFORE we
 *     overwrite the source.
 *  3. Only then writes the bytes to disk via `fs.writeFile`.
 *
 * If either validation step fails, the original file is left untouched
 * and the caller sees a `READ_FAILED` NodePdfError with the underlying
 * cause. Use this for every write path that produces user-visible
 * PDFs (fillForm, embedImageOnPage, sign-digital).
 *
 * The `password` is only used to re-parse encrypted output during the
 * round-trip check; `ignoreEncryption: true` lets us inspect the
 * structure even when we don't actually need to decrypt content
 * streams.
 */
export async function safeWritePdf(
  filePath: string,
  bytes: Uint8Array,
  opts: { password?: string; context: string } = { context: 'pdf' },
): Promise<void> {
  const { password, context } = opts;

  // Layer 1: header / footer markers.
  const startsWithPdf =
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d;
  const tailLen = Math.min(bytes.length, 1024);
  const tail = Buffer.from(bytes.subarray(bytes.length - tailLen)).toString('latin1');
  const endsWithEof = tail.includes('%%EOF');
  if (!startsWithPdf || !endsWithEof) {
    console.error(
      `[${context}] suspicious output bytes — refusing to write`,
      { startsWithPdf, endsWithEof, size: bytes.length },
    );
    throw new NodePdfError(
      'READ_FAILED',
      `${context}: would produce an invalid PDF — original file left untouched`,
    );
  }

  // Layer 2: round-trip through pdf-lib. Catches structural corruption
  // (broken xref, unresolved /Root, etc.) that the marker checks miss.
  try {
    const verify = await PDFDocument.load(bytes, {
      ...(password ? { password } : {}),
      ignoreEncryption: true,
    });
    // Touch the catalog so any lazy-resolution failure surfaces here —
    // pdf-lib's load is lenient by default and won't error on broken
    // /Root until something actually reads the catalog.
    void verify.catalog;
  } catch (err) {
    console.error(`[${context}] round-trip parse failed — refusing to write`, err);
    throw new NodePdfError(
      'READ_FAILED',
      `${context}: would produce an unreadable PDF: ${(err as Error).message ?? 'parse failed'} — original file left untouched`,
      err,
    );
  }

  try {
    await fs.writeFile(filePath, bytes);
  } catch (err) {
    throw new NodePdfError('READ_FAILED', `Failed to write PDF: ${filePath}`, err);
  }
}
