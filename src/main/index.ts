import { app, BrowserWindow, Menu } from 'electron';

import { createMainWindow } from './windows.js';
import { registerAllIpc } from './ipc/index.js';
import { registerStampProtocol, registerStampScheme } from './stamps/protocol.js';

// Windows installer entry; resolves before app is "ready" when Squirrel kicks in.
import electronSquirrelStartup from 'electron-squirrel-startup';
if (electronSquirrelStartup) {
  app.quit();
}

// HiDPI / fractional scale on Linux. Chromium's Wayland fractional-scale
// support is unreliable, so we read the desired factor from NODEPDF_SCALE
// (fallback: GDK_SCALE) and force it. Unset both to let the OS decide.
// Privileged scheme registration MUST happen before app is ready.
registerStampScheme();

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch(
    'enable-features',
    'WaylandFractionalScaleV1,WaylandWindowDecorations',
  );
  const rawScale = process.env.NODEPDF_SCALE ?? process.env.GDK_SCALE;
  const scale = rawScale ? Number.parseFloat(rawScale) : NaN;
  if (Number.isFinite(scale) && scale > 0) {
    app.commandLine.appendSwitch('force-device-scale-factor', String(scale));
    app.commandLine.appendSwitch('high-dpi-support', '1');
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerStampProtocol();
  registerAllIpc();
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
