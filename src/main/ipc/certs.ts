import { BrowserWindow, dialog } from 'electron';

import { NodePdfError } from '~shared/types/errors.js';
import { IPC_CHANNELS } from '~shared/types/ipc.js';
import type {
  Certificate,
  GenerateCertInput,
  ImportCertInput,
} from '~shared/types/certs.js';

import {
  generateCertificate,
  importCertificate,
  listCertificates,
  removeCertificate,
} from '../certs/storage.js';
import { handle } from './register.js';

export function registerCertsIpc(): void {
  handle<[], Certificate[]>(IPC_CHANNELS.certs.list, () => listCertificates());

  handle<[GenerateCertInput], Certificate>(
    IPC_CHANNELS.certs.generate,
    (_event, input) => {
      if (!input || typeof input.commonName !== 'string' || !input.commonName.trim()) {
        throw new NodePdfError('VALIDATION_ERROR', 'Common Name is required');
      }
      if (!input.password || typeof input.password !== 'string') {
        throw new NodePdfError('VALIDATION_ERROR', 'Cert password is required');
      }
      return generateCertificate(input);
    },
  );

  /** Pop the OS file picker; the caller follows up with `certs.import`
   * passing the chosen path + a password collected in a separate dialog. */
  handle<[], string | null>(IPC_CHANNELS.certs.pickFile, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const opts: Electron.OpenDialogOptions = {
      title: 'Import PKCS#12 certificate',
      properties: ['openFile'],
      filters: [
        { name: 'PKCS#12 / PFX', extensions: ['p12', 'pfx'] },
        { name: 'All files', extensions: ['*'] },
      ],
    };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });

  handle<[ImportCertInput], Certificate>(
    IPC_CHANNELS.certs.import,
    (_event, input) => {
      if (!input || typeof input.filePath !== 'string') {
        throw new NodePdfError('INVALID_PATH', 'File path is required');
      }
      return importCertificate(input);
    },
  );

  handle<[string], void>(IPC_CHANNELS.certs.remove, (_event, id) =>
    removeCertificate(id),
  );
}
