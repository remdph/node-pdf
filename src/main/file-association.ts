import { app } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * Register NodePDF as a handler for application/pdf on the host OS so
 * the app shows up in the system "Open With" menus with a custom file
 * icon. Idempotent — safe to call on every launch.
 *
 * What is NOT done here:
 * - macOS: declarations live in the bundle Info.plist (see forge.config
 *   `extendInfo`). Launch Services picks them up when the .app is
 *   moved into /Applications or registered via lsregister. No runtime
 *   work needed.
 * - Setting NodePDF as the *default* handler programmatically. macOS
 *   and Windows 10/11 both forbid that — only the user can change the
 *   default. We attempt it on Linux (where `xdg-mime default` works
 *   per-user) and rely on the user otherwise.
 */
export function registerFileAssociations(): void {
  if (process.platform === 'win32') {
    registerWindowsFileAssociations();
    return;
  }
  if (process.platform === 'linux') {
    setLinuxDefaultHandler();
    return;
  }
  // macOS: handled declaratively via Info.plist + Launch Services. No-op.
}

/**
 * Windows: write HKCU registry keys so NodePDF appears in Explorer's
 * "Open with" list for .pdf files with a custom document icon. We can
 * NOT set NodePDF as the default — Microsoft removed that capability
 * for third-party apps in Windows 10 1803.
 *
 * All keys live under HKCU so no admin elevation is needed (Squirrel.
 * Windows installs are per-user anyway).
 */
function registerWindowsFileAssociations(): void {
  const exe = process.execPath;
  // `pdf-document.ico` was copied into the app via packagerConfig.extraResource.
  // In dev (not packaged) the file lives next to the project root.
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'pdf-document.ico')
    : path.join(app.getAppPath(), 'build', 'pdf-document.ico');
  const progId = 'NodePDF.PDFDocument';
  const command = `"${exe}" "%1"`;

  type RegEntry = [string, string | null, string];
  const entries: RegEntry[] = [
    [`HKCU\\Software\\Classes\\${progId}`, null, 'PDF Document'],
    [`HKCU\\Software\\Classes\\${progId}`, 'FriendlyTypeName', 'PDF Document'],
    [`HKCU\\Software\\Classes\\${progId}\\DefaultIcon`, null, iconPath],
    [`HKCU\\Software\\Classes\\${progId}\\shell\\open\\command`, null, command],
    // Add NodePDF as an "Open with" candidate for .pdf
    [`HKCU\\Software\\Classes\\.pdf\\OpenWithProgids`, progId, ''],
    // App-list entry (separate from the ProgID — controls the
    // "FriendlyAppName" shown in the picker)
    [`HKCU\\Software\\Classes\\Applications\\node-pdf.exe`, 'FriendlyAppName', 'NodePDF'],
    [
      `HKCU\\Software\\Classes\\Applications\\node-pdf.exe\\DefaultIcon`,
      null,
      iconPath,
    ],
    [
      `HKCU\\Software\\Classes\\Applications\\node-pdf.exe\\shell\\open\\command`,
      null,
      command,
    ],
    [
      `HKCU\\Software\\Classes\\Applications\\node-pdf.exe\\SupportedTypes`,
      '.pdf',
      '',
    ],
    // Capabilities + RegisteredApplications — surfaces NodePDF in the
    // "Default apps by file type" picker in Settings so the user has
    // somewhere to confirm us as default.
    [`HKCU\\Software\\NodePDF\\Capabilities`, 'ApplicationName', 'NodePDF'],
    [
      `HKCU\\Software\\NodePDF\\Capabilities`,
      'ApplicationDescription',
      'Lightweight PDF viewer',
    ],
    [`HKCU\\Software\\NodePDF\\Capabilities\\FileAssociations`, '.pdf', progId],
    [`HKCU\\Software\\RegisteredApplications`, 'NodePDF', 'Software\\NodePDF\\Capabilities'],
  ];

  for (const [key, valueName, data] of entries) {
    const args = ['ADD', key, '/f', '/t', 'REG_SZ', '/d', data];
    if (valueName) args.splice(2, 0, '/v', valueName);
    else args.splice(2, 0, '/ve');
    spawn('reg.exe', args, { stdio: 'ignore', windowsHide: true }).on('error', () => {
      // Swallow individual key failures — we don't want a crashed shell
      // to break the launch. Worst case the entry is missing and the
      // user picks NodePDF manually via Browse.
    });
  }

  // Nudge Explorer to refresh its icon cache so the new doc icon shows
  // up immediately instead of after a logoff. Best-effort; ignore errors.
  spawn('ie4uinit.exe', ['-ClearIconCache'], {
    stdio: 'ignore',
    windowsHide: true,
  }).on('error', () => {});
}

/**
 * Linux: ask xdg-mime to set node-pdf.desktop as the user's default
 * handler for application/pdf. Per-user op (writes ~/.config/mimeapps.list)
 * so it only affects the user who launched the app, which is exactly
 * what we want — system installs can't know which user "installed" the
 * package.
 *
 * Idempotent: re-running `xdg-mime default` with the same args is a
 * no-op. We don't track first-run state; if the user later changes
 * the default to something else, they can change it back via their
 * file manager and we won't fight them on subsequent launches because
 * we only invoke this once per process start.
 *
 * NB: this is a one-shot fire-and-forget at startup. If you want to
 * prompt the user before reassigning the default, gate it behind a
 * "ask on first run" flag in the persisted store.
 */
function setLinuxDefaultHandler(): void {
  const child = spawn('xdg-mime', ['default', 'node-pdf.desktop', 'application/pdf'], {
    stdio: 'ignore',
  });
  child.on('error', () => {
    // xdg-mime not installed (rare) — silently give up.
  });
}
