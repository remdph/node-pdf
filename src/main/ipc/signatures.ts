import { BrowserWindow, dialog } from 'electron';
import path from 'node:path';

import { NodePdfError } from '~shared/types/errors.js';
import { IPC_CHANNELS } from '~shared/types/ipc.js';
import type {
  ApplySignatureInput,
  ApplySignatureResult,
  CreateSignatureFromBytesInput,
  InspectSignaturesResult,
  Signature,
  SignDigitalInput,
  SignDigitalResult,
} from '~shared/types/signatures.js';

import { embedImageOnPage } from '../pdf/embed.js';
import { inspectSignatures } from '../signatures/inspect.js';
import { signPdfDigitally } from '../signatures/sign-digital.js';
import {
  addSignatureFromBytes,
  addSignatureFromFile,
  findSignature,
  listSignatures,
  removeSignature,
} from '../signatures/storage.js';
import { handle } from './register.js';

export function registerSignaturesIpc(): void {
  handle<[], Signature[]>(IPC_CHANNELS.signatures.list, () => listSignatures());

  handle<[CreateSignatureFromBytesInput], Signature>(
    IPC_CHANNELS.signatures.createFromBytes,
    (_event, input) => {
      if (!input || (input.kind !== 'drawn' && input.kind !== 'typed')) {
        throw new NodePdfError('VALIDATION_ERROR', 'Invalid signature kind');
      }
      if (!(input.bytes instanceof Uint8Array)) {
        throw new NodePdfError('VALIDATION_ERROR', 'Signature bytes are required');
      }
      return addSignatureFromBytes(input.kind, input.label ?? '', input.bytes);
    },
  );

  handle<[], Signature | null>(IPC_CHANNELS.signatures.createFromFile, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const opts: Electron.OpenDialogOptions = {
      title: 'Import signature image',
      properties: ['openFile'],
      filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg'] }],
    };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return null;
    const srcPath = result.filePaths[0];
    if (!srcPath) return null;
    return addSignatureFromFile(srcPath);
  });

  handle<[string], void>(IPC_CHANNELS.signatures.remove, (_event, id) => removeSignature(id));

  handle<[ApplySignatureInput], ApplySignatureResult>(
    IPC_CHANNELS.signatures.apply,
    async (event, input) => {
      const { filePath, pageIndex, signatureId, rect, password } = input;

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
        throw new NodePdfError('VALIDATION_ERROR', 'Invalid signature rectangle');
      }

      const found = await findSignature(signatureId);
      if (!found) {
        throw new NodePdfError('VALIDATION_ERROR', `Unknown signature: ${signatureId}`);
      }

      const win = BrowserWindow.fromWebContents(event.sender);
      const confirm = win
        ? await dialog.showMessageBox(win, {
            type: 'question',
            buttons: ['Cancel', 'Sign'],
            defaultId: 1,
            cancelId: 0,
            message: `Sign ${path.basename(filePath)}?`,
            detail:
              'The signature will be permanently embedded in this file. ' +
              'This is a visual signature only — for cryptographic signing ' +
              'use the Digital signing flow (coming soon).',
          })
        : { response: 1 };

      if (confirm.response !== 1) return { applied: false };

      await embedImageOnPage({
        filePath,
        pageIndex,
        rect,
        imageBytes: new Uint8Array(found.bytes),
        imageFormat: found.signature.ext,
        password,
      });

      return { applied: true };
    },
  );

  handle<[string, string | undefined], InspectSignaturesResult>(
    IPC_CHANNELS.signatures.inspect,
    async (_event, filePath, password) => {
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
        throw new NodePdfError('INVALID_PATH', 'Invalid PDF path');
      }
      const signatures = await inspectSignatures(filePath, password);
      return { signatures };
    },
  );

  handle<[SignDigitalInput], SignDigitalResult>(
    IPC_CHANNELS.signatures.signDigital,
    async (event, input) => {
      if (!input || typeof input.filePath !== 'string' || !path.isAbsolute(input.filePath)) {
        throw new NodePdfError('INVALID_PATH', 'Invalid PDF path');
      }
      if (typeof input.certId !== 'string' || !input.certId) {
        throw new NodePdfError('VALIDATION_ERROR', 'Certificate id is required');
      }
      if (typeof input.certPassword !== 'string') {
        throw new NodePdfError('VALIDATION_ERROR', 'Certificate password is required');
      }

      const win = BrowserWindow.fromWebContents(event.sender);
      const confirm = win
        ? await dialog.showMessageBox(win, {
            type: 'question',
            buttons: ['Cancel', 'Sign'],
            defaultId: 1,
            cancelId: 0,
            message: `Digitally sign ${path.basename(input.filePath)}?`,
            detail:
              'A cryptographic signature will be embedded in this file. ' +
              'The signature can be verified later in any PDF viewer that ' +
              'supports PKCS#7 signatures (Adobe Reader, Foxit, etc.).',
          })
        : { response: 1 };
      if (confirm.response !== 1) return { applied: false };

      // Forward EVERY field — earlier versions of this handler whitelisted
      // a subset and silently dropped the visible-appearance + TSA + LT
      // fields, which made signers think the operation failed (no on-page
       // mark, no timestamp, no DSS) even though an invisible signature
      // had actually been embedded.
      await signPdfDigitally({
        filePath: input.filePath,
        certId: input.certId,
        certPassword: input.certPassword,
        password: input.password,
        reason: input.reason,
        location: input.location,
        contactInfo: input.contactInfo,
        visualSignatureId: input.visualSignatureId,
        pageIndex: input.pageIndex,
        rect: input.rect,
        tsaUrl: input.tsaUrl,
        embedRevocationInfo: input.embedRevocationInfo,
      });
      return { applied: true };
    },
  );
}
