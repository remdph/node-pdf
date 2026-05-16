import { app, BrowserWindow, dialog } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';

import { NodePdfError } from '~shared/types/errors.js';
import { IPC_CHANNELS } from '~shared/types/ipc.js';
import type {
  PdfPermissions,
  PrinterInfo,
  PrintOptions,
  ProtectInput,
} from '~shared/types/ipc.js';
import type { ApplyStampInput, ApplyStampResult } from '~shared/types/stamps.js';
import { findStamp } from '../stamps/storage.js';
import { handle } from './register.js';

/** Map our user-friendly permission flags to the shape pdf-lib's `encrypt`
 * expects. We grant the unspecified-but-related capabilities by default
 * (e.g. content accessibility is always on so screen readers work). */
function toPdfLibPermissions(p: PdfPermissions | undefined): Record<string, unknown> {
  const all = !p; // undefined → grant everything
  return {
    printing: all || p?.printing ? 'highResolution' : false,
    modifying: all || (p?.modifying ?? false),
    copying: all || (p?.copying ?? false),
    annotating: all || (p?.annotating ?? false),
    fillingForms: all || (p?.modifying ?? false),
    documentAssembly: all || (p?.modifying ?? false),
    contentAccessibility: true,
  };
}

interface PdfDocumentLike {
  encrypt: (opts: {
    userPassword: string;
    ownerPassword: string;
    permissions?: Record<string, unknown>;
  }) => void;
}

const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');

export function registerPdfIpc(): void {
  handle<[], string | null>(IPC_CHANNELS.pdf.open, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: 'Open PDF',
          properties: ['openFile'],
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        })
      : await dialog.showOpenDialog({
          title: 'Open PDF',
          properties: ['openFile'],
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        });

    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });

  handle<[string], Uint8Array>(IPC_CHANNELS.pdf.read, async (_event, filePath) => {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new NodePdfError('INVALID_PATH', 'A file path is required');
    }
    if (!path.isAbsolute(filePath)) {
      throw new NodePdfError('INVALID_PATH', 'File path must be absolute');
    }

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new NodePdfError('FILE_NOT_FOUND', `File not found: ${filePath}`, err);
      }
      throw new NodePdfError('READ_FAILED', `Failed to read file: ${filePath}`, err);
    }

    if (buffer.length < PDF_MAGIC.length || !buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
      throw new NodePdfError('INVALID_PDF', `Not a PDF file: ${filePath}`);
    }

    return new Uint8Array(buffer);
  });

  handle<[ApplyStampInput], ApplyStampResult>(
    IPC_CHANNELS.pdf.applyStamp,
    async (event, input) => {
      const { filePath, pageIndex, stampId, rect, password } = input;

      if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
        throw new NodePdfError('INVALID_PATH', 'Invalid PDF path');
      }
      if (!Number.isInteger(pageIndex) || pageIndex < 0) {
        throw new NodePdfError('VALIDATION_ERROR', 'Invalid page index');
      }
      if (
        !rect ||
        ![rect.x, rect.y, rect.w, rect.h].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) ||
        rect.w === 0 ||
        rect.h === 0
      ) {
        throw new NodePdfError('VALIDATION_ERROR', 'Invalid stamp rectangle');
      }

      const found = await findStamp(stampId);
      if (!found) throw new NodePdfError('VALIDATION_ERROR', `Unknown stamp: ${stampId}`);

      const win = BrowserWindow.fromWebContents(event.sender);
      const confirm = win
        ? await dialog.showMessageBox(win, {
            type: 'question',
            buttons: ['Cancel', 'Apply'],
            defaultId: 1,
            cancelId: 0,
            message: `Modify ${path.basename(filePath)}?`,
            detail: 'The stamp will be permanently embedded in this file.',
          })
        : { response: 1 };

      if (confirm.response !== 1) return { applied: false };

      let pdfBytes: Buffer;
      try {
        pdfBytes = await fs.readFile(filePath);
      } catch (err) {
        throw new NodePdfError('READ_FAILED', `Failed to read PDF: ${filePath}`, err);
      }

      let doc: PDFDocument;
      try {
        // Pass the password through so encrypted PDFs can be modified.
        doc = await PDFDocument.load(
          pdfBytes,
          password ? { password } : undefined,
        );
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

      const stampBytes = new Uint8Array(found.bytes);
      const image =
        found.stamp.ext === 'png'
          ? await doc.embedPng(stampBytes)
          : await doc.embedJpg(stampBytes);

      const drawW = rect.w * pageW;
      const drawH = rect.h * pageH;
      const drawX = rect.x * pageW;
      // PDF coords have origin at bottom-left; the renderer uses top-left.
      const drawY = pageH - rect.y * pageH - drawH;

      page.drawImage(image, { x: drawX, y: drawY, width: drawW, height: drawH });

      // Re-encrypt with the same password so the modified PDF stays
      // protected. v1 caveat: original permissions are NOT preserved — we
      // re-grant the default broad set.
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

      return { applied: true };
    },
  );

  handle<[string, PrintOptions | undefined], void>(
    IPC_CHANNELS.pdf.print,
    async (event, filePath, options) => {
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
        throw new NodePdfError('INVALID_PATH', 'Invalid PDF path');
      }
      try {
        await fs.access(filePath);
      } catch {
        throw new NodePdfError('FILE_NOT_FOUND', `File not found: ${filePath}`);
      }

      const parent = BrowserWindow.fromWebContents(event.sender);
      const printWin = new BrowserWindow({
        show: false,
        parent: parent ?? undefined,
        webPreferences: {
          plugins: true,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });

      try {
        await printWin.webContents.loadFile(filePath);
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        void app;
        await new Promise<void>((resolve, reject) => {
          printWin.webContents.print(
            {
              // We have our own preview/printer-picker in the renderer, so
              // bypass the OS dialog and print straight to the chosen device.
              silent: true,
              deviceName: options?.deviceName,
              copies: options?.copies && options.copies > 0 ? options.copies : 1,
              printBackground: true,
            },
            (success, failureReason) => {
              if (success || failureReason === 'cancelled') {
                resolve();
              } else {
                reject(new Error(failureReason || 'print failed'));
              }
            },
          );
        });
      } catch (err) {
        throw new NodePdfError('READ_FAILED', `Failed to print PDF: ${filePath}`, err);
      } finally {
        if (!printWin.isDestroyed()) printWin.destroy();
      }
    },
  );

  handle<[ProtectInput], void>(
    IPC_CHANNELS.pdf.protect,
    async (_event, input) => {
      if (
        !input ||
        typeof input.filePath !== 'string' ||
        !path.isAbsolute(input.filePath)
      ) {
        throw new NodePdfError('INVALID_PATH', 'Invalid PDF path');
      }

      const newPassword =
        typeof input.newPassword === 'string' ? input.newPassword : '';
      const currentPassword =
        typeof input.currentPassword === 'string' && input.currentPassword.length > 0
          ? input.currentPassword
          : undefined;

      let pdfBytes: Buffer;
      try {
        pdfBytes = await fs.readFile(input.filePath);
      } catch (err) {
        throw new NodePdfError(
          'READ_FAILED',
          `Failed to read PDF: ${input.filePath}`,
          err,
        );
      }

      let doc: PDFDocument;
      try {
        doc = await PDFDocument.load(
          pdfBytes,
          currentPassword ? { password: currentPassword } : undefined,
        );
      } catch (err) {
        throw new NodePdfError(
          'INVALID_PDF',
          currentPassword
            ? 'PDF could not be parsed — wrong password?'
            : 'PDF could not be parsed (encrypted?)',
          err,
        );
      }

      const wantsEncryption = newPassword.length > 0;
      if (wantsEncryption) {
        try {
          (doc as unknown as PdfDocumentLike).encrypt({
            userPassword: newPassword,
            ownerPassword: newPassword,
            permissions: toPdfLibPermissions(input.permissions),
          });
        } catch (err) {
          throw new NodePdfError('READ_FAILED', 'Failed to apply encryption', err);
        }
      }

      let outBytes: Uint8Array;
      try {
        // Object streams must be off when emitting an encrypted PDF.
        outBytes = await doc.save(
          wantsEncryption ? { useObjectStreams: false } : {},
        );
      } catch (err) {
        throw new NodePdfError('READ_FAILED', 'Failed to serialize PDF', err);
      }

      try {
        await fs.writeFile(input.filePath, outBytes);
      } catch (err) {
        throw new NodePdfError(
          'READ_FAILED',
          `Failed to write PDF: ${input.filePath}`,
          err,
        );
      }
    },
  );

  handle<[], PrinterInfo[]>(IPC_CHANNELS.printer.list, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return [];
    try {
      const printers = await win.webContents.getPrintersAsync();
      return printers.map((p) => ({
        name: p.name,
        displayName: p.displayName || p.name,
        description: p.description || '',
        isDefault: Boolean(p.isDefault),
      }));
    } catch (err) {
      console.warn('[pdf:print] getPrintersAsync failed', err);
      return [];
    }
  });
}
