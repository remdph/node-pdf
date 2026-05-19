import type {
  Certificate,
  GenerateCertInput,
  ImportCertInput,
} from './certs.js';
import type { AppSettings } from './settings.js';
import type {
  ApplySignatureInput,
  ApplySignatureResult,
  CreateSignatureFromBytesInput,
  InspectSignaturesResult,
  Signature,
  SignDigitalInput,
  SignDigitalResult,
} from './signatures.js';
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

/**
 * Lifecycle of the auto-updater, surfaced to the renderer so the
 * sidebar can show a persistent status row and the toast banner can
 * react to transitions. See src/main/updater.ts for how each platform
 * walks the machine.
 *
 *   idle      → before any check has finished (initial app load)
 *   checking  → request to GitHub / update.electronjs.org is in flight
 *   current   → confirmed: no newer release than `app.getVersion()`
 *   available → newer release exists.
 *               Win/macOS: download is already in progress in the
 *                 background; we'll transition to `ready` when done.
 *               Linux:   final state — there is nothing to download
 *                 in-app; user must update through their package manager
 *                 or the release page.
 *   ready     → Win/macOS only: bits downloaded, click → quitAndInstall.
 *   error     → most recent check failed; surfaces as a muted status.
 *   disabled  → user opted out via Settings → "Check for updates on
 *               startup". No network has been touched; the renderer
 *               shows just the current version with no "up to date"
 *               claim (which would be misleading without a check).
 */
export type UpdaterStatus =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'ready'
  | 'error'
  | 'disabled';

export interface UpdaterState {
  status: UpdaterStatus;
  /** Version we're running right now, included on every push so the
   * renderer can render the "Up to date · v0.3.0" label without an
   * extra IPC round-trip. */
  currentVersion: string;
  /** Latest version found on GitHub. Set when status is `available`,
   * `ready`, or `current` (in which case it equals `currentVersion`). */
  latestVersion?: string;
  /** Release page URL — used by the Linux "View release" link. */
  htmlUrl?: string;
  /** Human-readable error from the last failed check. */
  error?: string;
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
    /** Snapshot the current updater state. Called once on mount so the
     * UI can render the right status without waiting for the next
     * state-change push (which may not happen for a long time once
     * `current` is reached). */
    updaterState(): Promise<UpdaterState>;
    /** Push fired every time the updater transitions between statuses
     * (see UpdaterStatus). Replaces the previous one-shot
     * `update-available` event. */
    onUpdaterStateChange(handler: (state: UpdaterState) => void): () => void;
    /** Win/macOS only: triggers `autoUpdater.quitAndInstall()`, which
     * closes the app and relaunches it from the just-downloaded
     * Squirrel update. No-op when status !== 'ready' or when running
     * on Linux. */
    installUpdate(): Promise<void>;
    /** Manual / forced check. Works regardless of the
     * `checkUpdatesOnStartup` setting — that flag only gates the
     * automatic polling, not on-demand checks. */
    checkForUpdates(): Promise<void>;
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
  signatures: {
    list(): Promise<Signature[]>;
    /** Persist a drawn or typed signature produced by a renderer canvas. */
    createFromBytes(input: CreateSignatureFromBytesInput): Promise<Signature>;
    /** Open the OS file picker and import a PNG/JPG as a signature image. */
    createFromFile(): Promise<Signature | null>;
    remove(id: string): Promise<void>;
    /** Apply a visual signature to a page (does NOT add a cryptographic
     * /Sig field — that's Fase 3). */
    apply(input: ApplySignatureInput): Promise<ApplySignatureResult>;
    /** Inspect existing /Sig fields in a PDF and report their integrity. */
    inspect(filePath: string, password?: string): Promise<InspectSignaturesResult>;
    /** Apply a cryptographic PKCS#7 signature to a PDF using a stored cert.
     * `visualSignatureId` + `rect` + `pageIndex` are optional: omitting them
     * produces an invisible signature with no on-page mark. */
    signDigital(input: SignDigitalInput): Promise<SignDigitalResult>;
  };
  certs: {
    list(): Promise<Certificate[]>;
    generate(input: GenerateCertInput): Promise<Certificate>;
    /** Open the OS file picker for a .p12/.pfx and return the chosen path.
     * Used by the renderer's two-step import flow (pick file, then prompt
     * for the cert password in a UI dialog). */
    pickFile(): Promise<string | null>;
    import(input: ImportCertInput): Promise<Certificate>;
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
  settings: {
    get(): Promise<AppSettings>;
    /** Partial patch — unspecified keys keep their current value. Returns
     * the merged settings so the renderer can reconcile its own store. */
    set(patch: Partial<AppSettings>): Promise<AppSettings>;
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
    updaterStateGet: 'app:updater-state-get',
    updaterStateChange: 'app:updater-state-change',
    updaterInstall: 'app:updater-install',
    updaterCheckNow: 'app:updater-check-now',
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
  signatures: {
    list: 'signatures:list',
    createFromBytes: 'signatures:create-from-bytes',
    createFromFile: 'signatures:create-from-file',
    remove: 'signatures:remove',
    apply: 'signatures:apply',
    inspect: 'signatures:inspect',
    signDigital: 'signatures:sign-digital',
  },
  certs: {
    list: 'certs:list',
    generate: 'certs:generate',
    pickFile: 'certs:pick-file',
    import: 'certs:import',
    remove: 'certs:remove',
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
  settings: {
    get: 'settings:get',
    set: 'settings:set',
  },
} as const;
