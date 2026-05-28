import { app, BrowserWindow, dialog } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';

import { NodePdfError } from '~shared/types/errors.js';
import type {
  FillFormInput,
  FillFormResult,
  FormInfo,
} from '~shared/types/forms.js';
import { IPC_CHANNELS } from '~shared/types/ipc.js';
import type {
  PrinterInfo,
  PrintOptions,
  ProtectInput,
  SplitInput,
  SplitResult,
} from '~shared/types/ipc.js';
import type { ApplyStampInput, ApplyStampResult } from '~shared/types/stamps.js';
import { embedImageOnPage } from '../pdf/embed.js';
import { toPdfLibPermissions, type PdfDocumentLike } from '../pdf/encryption.js';
import { safeWritePdf } from '../pdf/safe-write.js';
import { fillForm, inspectForm } from '../pdf/form.js';
import { findStamp } from '../stamps/storage.js';
import { handle } from './register.js';

// Files received from the OS shell before a renderer is ready to receive
// them (cold start with "Open with NodePDF", or 'open-file' firing before
// app.ready on macOS). The renderer drains this list on mount.
const pendingFiles: string[] = [];

export function addPendingFile(filePath: string): void {
  pendingFiles.push(filePath);
}

/** Push a file path to the first ready renderer. Returns false if no
 * renderer is ready yet so the caller knows to buffer it instead. */
export function deliverFileToRenderer(filePath: string): boolean {
  const [win] = BrowserWindow.getAllWindows();
  if (!win || win.webContents.isLoading()) return false;
  win.webContents.send(IPC_CHANNELS.pdf.openExternal, filePath);
  return true;
}

const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');

export function registerPdfIpc(): void {
  // Renderer calls this on mount to grab any paths queued before it was
  // ready (cold start launched via "Open with NodePDF"). Drains and clears.
  handle<[], string[]>(IPC_CHANNELS.pdf.flushPending, async () => {
    const drained = pendingFiles.splice(0, pendingFiles.length);
    return drained;
  });

  handle<[string | undefined], string | null>(IPC_CHANNELS.pdf.open, async (event, defaultPath) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    // `defaultPath` lets callers (e.g. the home view's "Your computer" pane)
    // root the dialog at a specific folder. Without it, the OS picks
    // whichever directory it last remembered.
    const opts = {
      title: 'Open PDF',
      properties: ['openFile' as const],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      ...(defaultPath ? { defaultPath } : {}),
    };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);

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

    // macOS 15.4+: Gatekeeper shows "Apple could not verify <file>.pdf is
    // free of malware" when a third-party default handler opens a
    // quarantined PDF via double-click. The check fires BEFORE 'open-file'
    // reaches us, so we can't suppress the first occurrence — but once
    // the user has successfully gotten the PDF into NodePDF (via Open
    // With, File → Open, or by clicking "Open Anyway"), strip the
    // com.apple.quarantine xattr so subsequent double-clicks skip the
    // dialog. Best-effort, fire-and-forget; failures are silent.
    if (process.platform === 'darwin') {
      execFile('xattr', ['-d', 'com.apple.quarantine', filePath], () => {});
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

      await embedImageOnPage({
        filePath,
        pageIndex,
        rect,
        imageBytes: new Uint8Array(found.bytes),
        imageFormat: found.stamp.ext,
        password,
      });

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

  handle<[string, string | undefined], FormInfo>(
    IPC_CHANNELS.pdf.getFormInfo,
    async (_event, filePath, password) => {
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
        throw new NodePdfError('INVALID_PATH', 'Invalid PDF path');
      }
      return inspectForm(filePath, password);
    },
  );

  handle<[FillFormInput], FillFormResult>(
    IPC_CHANNELS.pdf.fillForm,
    async (_event, input) => {
      if (!input || typeof input.filePath !== 'string' || !path.isAbsolute(input.filePath)) {
        throw new NodePdfError('INVALID_PATH', 'Invalid PDF path');
      }
      return fillForm(input);
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

  handle<[SplitInput], SplitResult>(
    IPC_CHANNELS.pdf.split,
    async (event, input) => {
      if (!input || typeof input.filePath !== 'string' || !path.isAbsolute(input.filePath)) {
        throw new NodePdfError('INVALID_PATH', 'Invalid PDF path');
      }
      if (!Array.isArray(input.ranges) || input.ranges.length === 0) {
        throw new NodePdfError('VALIDATION_ERROR', 'At least one part is required');
      }

      let pdfBytes: Buffer;
      try {
        pdfBytes = await fs.readFile(input.filePath);
      } catch (err) {
        throw new NodePdfError('READ_FAILED', `Failed to read PDF: ${input.filePath}`, err);
      }

      let srcDoc: PDFDocument;
      try {
        srcDoc = await PDFDocument.load(pdfBytes, input.password ? { password: input.password } : undefined);
      } catch (err) {
        throw new NodePdfError('INVALID_PDF', 'Could not parse PDF', err);
      }

      const totalPages = srcDoc.getPageCount();

      // Validate all ranges upfront.
      for (let i = 0; i < input.ranges.length; i++) {
        const r = input.ranges[i]!;
        if (!Number.isInteger(r.start) || r.start < 1 || r.start > totalPages) {
          throw new NodePdfError('VALIDATION_ERROR', `Range ${i + 1}: start must be 1-${totalPages}`);
        }
        if (!Number.isInteger(r.end) || r.end < r.start || r.end > totalPages) {
          throw new NodePdfError('VALIDATION_ERROR', `Range ${i + 1}: end must be >= start and <= ${totalPages}`);
        }
      }

      // Check for overlap — sort by start, ensure each end < next start.
      const sorted = input.ranges
        .map((r, idx) => ({ idx, start: r.start, end: r.end }))
        .sort((a, b) => a.start - b.start);
      for (let i = 0; i < sorted.length - 1; i++) {
        if (sorted[i]!.end >= sorted[i + 1]!.start) {
          throw new NodePdfError('VALIDATION_ERROR', 'Page ranges must not overlap');
        }
      }

      const win = BrowserWindow.fromWebContents(event.sender);
      const basename = input.filePath.split(/[\\/]/).pop()?.replace(/\.pdf$/i, '') ?? 'document';
      const savedPaths: string[] = [];

      for (let i = 0; i < input.ranges.length; i++) {
        const { start, end } = input.ranges[i]!;
        const pageIndices: number[] = [];
        for (let p = start - 1; p <= end - 1; p++) pageIndices.push(p);

        let partDoc: PDFDocument;
        try {
          partDoc = await PDFDocument.create();
          // copyPages adds the copied pages to partDoc automatically.
          await partDoc.copyPages(srcDoc, pageIndices);
        } catch (err) {
          throw new NodePdfError('READ_FAILED', `Failed to create part ${i + 1}`, err);
        }

        let partBytes: Uint8Array;
        try {
          partBytes = await partDoc.save();
        } catch (err) {
          throw new NodePdfError('READ_FAILED', `Failed to serialize part ${i + 1}`, err);
        }

        const defaultName = `${basename}_part${i + 1}.pdf`;
        const saveOpts = win
          ? await dialog.showSaveDialog(win, {
              title: `Save part ${i + 1} of ${input.ranges.length}`,
              defaultPath: defaultName,
              filters: [{ name: 'PDF', extensions: ['pdf'] }],
            })
          : await dialog.showSaveDialog({
              title: `Save part ${i + 1} of ${input.ranges.length}`,
              defaultPath: defaultName,
              filters: [{ name: 'PDF', extensions: ['pdf'] }],
            });

        if (saveOpts.canceled || !saveOpts.filePath) {
          throw new NodePdfError('READ_FAILED', `Save cancelled for part ${i + 1}`);
        }

        await safeWritePdf(saveOpts.filePath, partBytes, {
          context: `split-part-${i + 1}`,
        });
        savedPaths.push(saveOpts.filePath);
      }

      return { savedPaths };
    },
  );
}
