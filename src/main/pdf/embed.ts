import fs from 'node:fs/promises';
import { PDFDocument } from '@cantoo/pdf-lib';

import { NodePdfError } from '~shared/types/errors.js';
import { safeWritePdf } from './safe-write.js';

export type ImageFormat = 'png' | 'jpg' | 'jpeg';

export interface ImageRect {
  /** Normalized [0, 1], origin top-left (renderer convention). */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EmbedImageInput {
  filePath: string;
  pageIndex: number;
  rect: ImageRect;
  imageBytes: Uint8Array;
  imageFormat: ImageFormat;
  /** Password for the source PDF if it's encrypted. With the incremental-
   * update path the original encrypted bytes are preserved verbatim — we
   * never re-encrypt — so existing protection stays intact and we don't
   * need to know the owner password / permissions to write back. */
  password?: string;
}

/**
 * Read a PDF from disk, embed a raster image on the specified page using a
 * normalized rect, and write the result back in place via INCREMENTAL
 * UPDATE. Shared by the stamps pipeline (`applyStamp`) and the visual
 * signatures pipeline (`signatures.apply`) so both flows preserve any
 * existing cryptographic signatures byte-exact.
 *
 * Why incremental matters here: `doc.save()` regenerates the entire PDF
 * from scratch, which means every object gets a new byte offset. Any
 * existing /Sig field's /ByteRange points at OLD offsets, so the
 * signature's CMS no longer matches the document hash and Reader marks
 * it as "modified after signing" or hides it entirely. Incremental
 * update appends our new image + page mutation as a delta on top of the
 * untouched original bytes — prior signatures' byte ranges stay valid.
 *
 * Throws `NodePdfError` on any failure; callers should let it bubble up to
 * the IPC handler (`handle()` in `register.ts` translates it for the renderer).
 */
export async function embedImageOnPage(input: EmbedImageInput): Promise<void> {
  const { filePath, pageIndex, rect, imageBytes, imageFormat, password } = input;

  let pdfBytes: Buffer;
  try {
    pdfBytes = await fs.readFile(filePath);
  } catch (err) {
    throw new NodePdfError('READ_FAILED', `Failed to read PDF: ${filePath}`, err);
  }

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBytes, {
      // Arm the auto-tracking snapshot so commit() emits an incremental
      // section instead of a full re-save.
      forIncrementalUpdate: true,
      ...(password ? { password } : {}),
    });
  } catch (err) {
    throw new NodePdfError('INVALID_PDF', 'PDF could not be parsed', err);
  }

  const pages = doc.getPages();
  if (pageIndex >= pages.length) {
    throw new NodePdfError('VALIDATION_ERROR', 'Page index out of range');
  }
  const page = pages[pageIndex];
  if (!page) {
    throw new NodePdfError('VALIDATION_ERROR', 'Page not found');
  }
  const { width: pageW, height: pageH } = page.getSize();

  const image =
    imageFormat === 'png'
      ? await doc.embedPng(imageBytes)
      : await doc.embedJpg(imageBytes);

  const drawW = rect.w * pageW;
  const drawH = rect.h * pageH;
  const drawX = rect.x * pageW;
  // PDF coords have origin at bottom-left; the renderer uses top-left.
  const drawY = pageH - rect.y * pageH - drawH;

  page.drawImage(image, { x: drawX, y: drawY, width: drawW, height: drawH });

  let outBytes: Uint8Array;
  try {
    // commit() = saveIncremental(context.snapshot) + concat onto original
    // bytes. Existing encryption is preserved automatically because we
    // never touched the original encrypted objects.
    outBytes = await doc.commit({ useObjectStreams: false });
  } catch (err) {
    throw new NodePdfError('READ_FAILED', 'Failed to serialize PDF', err);
  }

  // Validate the output bytes BEFORE overwriting the source — pdf-lib
  // has produced silently-broken incremental saves on some real forms.
  // safeWritePdf throws (without writing) when the output wouldn't
  // parse, so the original file is left intact for the user to retry.
  await safeWritePdf(filePath, outBytes, {
    password,
    context: 'embedImageOnPage',
  });
}
