import type { ApplyStampInput, ApplyStampResult, Stamp } from './stamps.js';

export interface PrinterInfo {
  name: string;
  displayName: string;
  description: string;
  isDefault: boolean;
}

export interface PrintOptions {
  /** Native printer name returned by `printer.list`. If omitted, the OS uses
   * the default printer (or fails if there isn't one). */
  deviceName?: string;
  copies?: number;
}

export interface PdfPermissions {
  /** Allow printing. */
  printing: boolean;
  /** Allow copying text + images. */
  copying: boolean;
  /** Allow modifying the document (page reorder, edit content, etc.). */
  modifying: boolean;
  /** Allow adding annotations and form fields. */
  annotating: boolean;
}

export interface ProtectInput {
  filePath: string;
  /** Required when the PDF is currently encrypted (used to decrypt). */
  currentPassword?: string;
  /** Empty / undefined removes the password (decrypts the file). */
  newPassword?: string;
  /** Only applied when newPassword is non-empty. */
  permissions?: PdfPermissions;
}

export interface HomeFolder {
  /** Display label (e.g. "Downloads"). */
  name: string;
  /** Absolute path to the folder on disk. */
  path: string;
}

export interface IpcApi {
  /** Host OS identifier — same shape as Node's `process.platform`. */
  platform: NodeJS.Platform;
  window: {
    minimize(): Promise<void>;
    maximizeToggle(): Promise<boolean>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
    onMaximizeChange(handler: (maximized: boolean) => void): () => void;
  };
  app: {
    version(): Promise<string>;
    /** Push fired by the macOS app menu's "About NodePDF" item so the
     * renderer can open the in-app About dialog (clickable links etc.)
     * instead of the plain-text native panel. */
    onShowAbout(handler: () => void): () => void;
  };
  pdf: {
    /** Show the system "Open PDF" dialog. Pass `defaultPath` to root the
     * dialog at a specific folder (e.g. the user's Downloads). */
    open(defaultPath?: string): Promise<string | null>;
    read(filePath: string): Promise<Uint8Array>;
    /** Drain any PDF paths the OS shell handed us before the renderer was
     * ready (cold start launched via "Open with NodePDF"). */
    flushPending(): Promise<string[]>;
    /** Live push from main: file path received via 'open-file' (macOS) or
     * a second-instance launch (Windows/Linux) while the app is running. */
    onOpenExternal(handler: (filePath: string) => void): () => void;
    applyStamp(input: ApplyStampInput): Promise<ApplyStampResult>;
    print(filePath: string, options?: PrintOptions): Promise<void>;
    /** Manage PDF password protection. Behaviour depends on inputs:
     *  - `currentPassword` is required if the PDF is currently encrypted.
     *  - If `newPassword` is a non-empty string, the PDF is (re)encrypted
     *    with it using the supplied permissions.
     *  - If `newPassword` is null/empty AND the PDF was encrypted, the
     *    encryption is removed.
     */
    protect(input: ProtectInput): Promise<void>;
  };
  printer: {
    list(): Promise<PrinterInfo[]>;
  };
  stamps: {
    list(): Promise<Stamp[]>;
    add(): Promise<Stamp | null>;
    remove(id: string): Promise<void>;
  };
  recents: {
    readThumb(filePath: string): Promise<Uint8Array | null>;
    saveThumb(input: { filePath: string; bytes: Uint8Array }): Promise<void>;
  };
  shell: {
    /** List of common home subdirectories that exist on this machine. */
    homeFolders(): Promise<HomeFolder[]>;
  };
}

export const IPC_CHANNELS = {
  window: {
    minimize: 'window:minimize',
    maximizeToggle: 'window:maximize-toggle',
    close: 'window:close',
    isMaximized: 'window:is-maximized',
    maximizeChange: 'window:maximize-change',
  },
  app: {
    version: 'app:version',
    showAbout: 'app:show-about',
  },
  pdf: {
    open: 'pdf:open',
    read: 'pdf:read',
    flushPending: 'pdf:flush-pending',
    openExternal: 'pdf:open-external',
    applyStamp: 'pdf:apply-stamp',
    print: 'pdf:print',
    protect: 'pdf:protect',
  },
  stamps: {
    list: 'stamps:list',
    add: 'stamps:add',
    remove: 'stamps:remove',
  },
  recents: {
    readThumb: 'recents:read-thumb',
    saveThumb: 'recents:save-thumb',
  },
  printer: {
    list: 'printer:list',
  },
  shell: {
    homeFolders: 'shell:home-folders',
  },
} as const;
