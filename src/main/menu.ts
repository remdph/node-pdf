import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  type MenuItemConstructorOptions,
} from 'electron';

import { IPC_CHANNELS } from '~shared/types/ipc.js';
import { addPendingFile, deliverFileToRenderer } from './ipc/pdf.js';

/** Builds the macOS-style app menu (also shown on Win/Linux when the user
 * presses Alt). The File → Open File item drives the same flow as the
 * in-app "Open PDF" button: dialog.showOpenDialog + delivery via the
 * existing 'pdf:open-external' channel. */
export function buildApplicationMenu(): Menu {
  const isMac = process.platform === 'darwin';

  const openFilePrompt = async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const opts = {
      title: 'Open PDF',
      properties: ['openFile' as const],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return;
    const filePath = result.filePaths[0];
    if (!filePath) return;
    if (!deliverFileToRenderer(filePath)) addPendingFile(filePath);
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              {
                // Routes to the same React AboutDialog as the in-app
                // about button so the user gets clickable links/styled
                // copy instead of the native plain-text panel.
                label: `About ${app.name}`,
                click: () => {
                  const win =
                    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
                  win?.webContents.send(IPC_CHANNELS.app.showAbout);
                },
              },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open File…',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            void openFilePrompt();
          },
        },
        { type: 'separator' },
        isMac
          ? ({ role: 'close' } satisfies MenuItemConstructorOptions)
          : ({ role: 'quit' } satisfies MenuItemConstructorOptions),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        ...(isMac
          ? [{ role: 'front' as const } satisfies MenuItemConstructorOptions]
          : [{ role: 'close' as const } satisfies MenuItemConstructorOptions]),
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}
