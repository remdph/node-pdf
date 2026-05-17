import { app, BrowserWindow, Menu } from 'electron';

import { createMainWindow } from './windows.js';
import { registerFileAssociations } from './file-association.js';
import { registerAllIpc } from './ipc/index.js';
import { addPendingFile, deliverFileToRenderer } from './ipc/pdf.js';
import { buildApplicationMenu } from './menu.js';
import { registerStampProtocol, registerStampScheme } from './stamps/protocol.js';

// Windows installer entry; resolves before app is "ready" when Squirrel kicks in.
import electronSquirrelStartup from 'electron-squirrel-startup';
if (electronSquirrelStartup) {
  app.quit();
}

// Make sure a second "Open with NodePDF" launch forwards the file to the
// already-running instance instead of spawning a duplicate window. macOS
// uses 'open-file' for this and doesn't need the lock, but Windows/Linux
// rely on it because Explorer/Nautilus launch a fresh process per file.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
}

function findPdfInArgv(argv: readonly string[]): string | null {
  // argv[0] is the binary path. In dev `electron .` adds "." as argv[1] —
  // skip anything that doesn't look like an absolute path ending in .pdf.
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue;
    if (arg.toLowerCase().endsWith('.pdf')) return arg;
  }
  return null;
}

// macOS dispatches `open-file` for double-click + "Open with" from Finder,
// and it can fire BEFORE app.whenReady() resolves. Apple's documented
// pattern is to register inside `will-finish-launching` (the Electron
// translation of NSApplication's `applicationWillFinishLaunching`) which
// eliminates a small race window between module load and the first
// Apple Event. We always buffer the path; the renderer drains the
// buffer on mount.
app.on('will-finish-launching', () => {
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (!deliverFileToRenderer(filePath)) {
      addPendingFile(filePath);
    }
  });
});

// Windows / Linux second-instance: argv from the new process contains the
// file path that Explorer/Nautilus passed. Hand it to the existing window.
app.on('second-instance', (_event, argv) => {
  const file = findPdfInArgv(argv);
  if (file && !deliverFileToRenderer(file)) {
    addPendingFile(file);
  }
  const [win] = BrowserWindow.getAllWindows();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// Cold start with "Open with NodePDF" on Windows/Linux: the path is sitting
// in our own argv. (On macOS it's the 'open-file' event instead.)
if (app.isPackaged) {
  const launchFile = findPdfInArgv(process.argv);
  if (launchFile) addPendingFile(launchFile);
}

// HiDPI / fractional scale on Linux. On Wayland the compositor reports the
// effective scale via WaylandFractionalScaleV1, so trust it and only fall
// back to GDK_SCALE on X11 (where toolkits historically used that var).
// NODEPDF_SCALE remains an explicit override for either session type.
// Privileged scheme registration MUST happen before app is ready.
registerStampScheme();

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch(
    'enable-features',
    'WaylandFractionalScaleV1,WaylandWindowDecorations',
  );
  const isWayland = process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY;
  // On Wayland the compositor owns scaling. GTK env vars still leak into
  // Chromium's font/UI sizing path even when we don't pass them as flags,
  // so wipe them unless the user explicitly opts in via NODEPDF_SCALE.
  if (isWayland && !process.env.NODEPDF_SCALE) {
    delete process.env.GDK_SCALE;
    delete process.env.GDK_DPI_SCALE;
  }
  const rawScale = process.env.NODEPDF_SCALE ?? (isWayland ? undefined : process.env.GDK_SCALE);
  const scale = rawScale ? Number.parseFloat(rawScale) : NaN;
  if (Number.isFinite(scale) && scale > 0) {
    app.commandLine.appendSwitch('force-device-scale-factor', String(scale));
    app.commandLine.appendSwitch('high-dpi-support', '1');
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(buildApplicationMenu());
  registerStampProtocol();
  registerAllIpc();
  // Best-effort PDF handler registration on Win/Linux (macOS handles
  // this declaratively via Info.plist).
  registerFileAssociations();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
