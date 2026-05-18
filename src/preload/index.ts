import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

import { IPC_CHANNELS } from '~shared/types/ipc.js';
import type {
  HomeFolder,
  PrinterInfo,
  PrintOptions,
  ProtectInput,
  UpdateInfo,
} from '~shared/types/ipc.js';
import type {
  Certificate,
  GenerateCertInput,
  ImportCertInput,
} from '~shared/types/certs.js';
import type { AppSettings } from '~shared/types/settings.js';
import type {
  ApplySignatureInput,
  ApplySignatureResult,
  CreateSignatureFromBytesInput,
  InspectSignaturesResult,
  Signature,
  SignDigitalInput,
  SignDigitalResult,
} from '~shared/types/signatures.js';
import type { ApplyStampInput, ApplyStampResult, Stamp } from '~shared/types/stamps.js';

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api = {
  /** Static OS identifier ("darwin" | "win32" | "linux" | …). Saves the
   * renderer a round-trip when toggling platform-specific chrome. */
  platform: process.platform,
  window: {
    minimize: () => invoke<void>(IPC_CHANNELS.window.minimize),
    maximizeToggle: () => invoke<boolean>(IPC_CHANNELS.window.maximizeToggle),
    close: () => invoke<void>(IPC_CHANNELS.window.close),
    isMaximized: () => invoke<boolean>(IPC_CHANNELS.window.isMaximized),
    onMaximizeChange: (handler: (maximized: boolean) => void) =>
      subscribe<boolean>(IPC_CHANNELS.window.maximizeChange, handler),
  },
  app: {
    version: () => invoke<string>(IPC_CHANNELS.app.version),
    onShowAbout: (handler: () => void) =>
      subscribe<void>(IPC_CHANNELS.app.showAbout, () => handler()),
    onUpdateAvailable: (handler: (info: UpdateInfo) => void) =>
      subscribe<UpdateInfo>(IPC_CHANNELS.app.updateAvailable, handler),
  },
  pdf: {
    open: (defaultPath?: string) =>
      invoke<string | null>(IPC_CHANNELS.pdf.open, defaultPath),
    read: (filePath: string) => invoke<Uint8Array>(IPC_CHANNELS.pdf.read, filePath),
    flushPending: () => invoke<string[]>(IPC_CHANNELS.pdf.flushPending),
    onOpenExternal: (handler: (filePath: string) => void) =>
      subscribe<string>(IPC_CHANNELS.pdf.openExternal, handler),
    applyStamp: (input: ApplyStampInput) =>
      invoke<ApplyStampResult>(IPC_CHANNELS.pdf.applyStamp, input),
    print: (filePath: string, options?: PrintOptions) =>
      invoke<void>(IPC_CHANNELS.pdf.print, filePath, options),
    protect: (input: ProtectInput) =>
      invoke<void>(IPC_CHANNELS.pdf.protect, input),
  },
  printer: {
    list: () => invoke<PrinterInfo[]>(IPC_CHANNELS.printer.list),
  },
  stamps: {
    list: () => invoke<Stamp[]>(IPC_CHANNELS.stamps.list),
    add: () => invoke<Stamp | null>(IPC_CHANNELS.stamps.add),
    remove: (id: string) => invoke<void>(IPC_CHANNELS.stamps.remove, id),
  },
  signatures: {
    list: () => invoke<Signature[]>(IPC_CHANNELS.signatures.list),
    createFromBytes: (input: CreateSignatureFromBytesInput) =>
      invoke<Signature>(IPC_CHANNELS.signatures.createFromBytes, input),
    createFromFile: () =>
      invoke<Signature | null>(IPC_CHANNELS.signatures.createFromFile),
    remove: (id: string) => invoke<void>(IPC_CHANNELS.signatures.remove, id),
    apply: (input: ApplySignatureInput) =>
      invoke<ApplySignatureResult>(IPC_CHANNELS.signatures.apply, input),
    inspect: (filePath: string, password?: string) =>
      invoke<InspectSignaturesResult>(IPC_CHANNELS.signatures.inspect, filePath, password),
    signDigital: (input: SignDigitalInput) =>
      invoke<SignDigitalResult>(IPC_CHANNELS.signatures.signDigital, input),
  },
  certs: {
    list: () => invoke<Certificate[]>(IPC_CHANNELS.certs.list),
    generate: (input: GenerateCertInput) =>
      invoke<Certificate>(IPC_CHANNELS.certs.generate, input),
    pickFile: () => invoke<string | null>(IPC_CHANNELS.certs.pickFile),
    import: (input: ImportCertInput) =>
      invoke<Certificate>(IPC_CHANNELS.certs.import, input),
    remove: (id: string) => invoke<void>(IPC_CHANNELS.certs.remove, id),
  },
  recents: {
    readThumb: (filePath: string) =>
      invoke<Uint8Array | null>(IPC_CHANNELS.recents.readThumb, filePath),
    saveThumb: (input: { filePath: string; bytes: Uint8Array }) =>
      invoke<void>(IPC_CHANNELS.recents.saveThumb, input),
  },
  shell: {
    homeFolders: () => invoke<HomeFolder[]>(IPC_CHANNELS.shell.homeFolders),
  },
  settings: {
    get: () => invoke<AppSettings>(IPC_CHANNELS.settings.get),
    set: (patch: Partial<AppSettings>) =>
      invoke<AppSettings>(IPC_CHANNELS.settings.set, patch),
  },
};

contextBridge.exposeInMainWorld('nodePdf', api);

export type NodePdfApi = typeof api;
