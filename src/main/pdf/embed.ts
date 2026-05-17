import fs from 'node:fs/promises';
import { PDFDocument } from '@cantoo/pdf-lib';

import { NodePdfError } from '~shared/types/errors.js';

import { toPdfLibPermissions, type PdfDocumentLike } from './encryption.js';

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
  /** Decrypts the PDF for editing AND is reused as the user/owner password
   * when re-encrypting. v1 caveat: original permissions are NOT preserved
   * across a re-encrypt — we re-grant the default broad set. */
  password?: string;
}

/**
 * Read a PDF from disk, embed a raster image on the specified page using a
 * normalized rect, and write the result back in place. Shared by the stamps
 * pipeline (`applyStamp`) and the upcoming signatures pipeline so both go
 * through identical decrypt/embed/re-encrypt behavior.
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
    doc = await PDFDocument.load(pdfBytes, password ? { password } : undefined);
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
    if (password) {
      (doc as unknown as PdfDocumentLike).encrypt({
        userPassword: password,
        ownerPassword: password,
        permissions: toPdfLibPermissions(undefined),
      });
      outBytes = await doc.save({ useObjectStreams: false });
    } else {
      outBytes = await doc.save();
    }
  } catch (err) {
    throw new NodePdfError('READ_FAILED', 'Failed to serialize PDF', err);
  }

  try {
    await fs.writeFile(filePath, outBytes);
  } catch (err) {
    throw new NodePdfError('READ_FAILED', `Failed to write PDF: ${filePath}`, err);
  }
}
