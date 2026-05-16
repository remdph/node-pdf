import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';

import { IPC_CHANNELS } from '~shared/types/ipc.js';

function appIconPath(): string {
  // In dev, app.getAppPath() == the project root, so icon.png lives next to it.
  // In packaged builds the icon is copied into the app's resources directory
  // via forge's `extraResource`.
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(app.getAppPath(), 'icon.png');
}

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    show: false,
    title: 'NodePDF',
    icon: appIconPath(),
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const broadcastMaximize = (maximized: boolean) =>
    win.webContents.send(IPC_CHANNELS.window.maximizeChange, maximized);
  win.on('maximize', () => broadcastMaximize(true));
  win.on('unmaximize', () => broadcastMaximize(false));

  win.on('ready-to-show', () => win.show());

  // DevTools shortcuts (the native menu is hidden, so we register them here).
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    const isDevTools =
      input.key === 'F12' ||
      (input.control && input.shift && (input.key === 'I' || input.key === 'i'));
    if (isDevTools) win.webContents.toggleDevTools();
    if (input.control && input.shift && (input.key === 'R' || input.key === 'r')) {
      win.webContents.reloadIgnoringCache();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined' && MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    win.webContents.once('did-finish-load', () => {
      win.webContents.openDevTools({ mode: 'detach' });
    });
  } else {
    void win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  return win;
}
