import { BrowserWindow, dialog } from 'electron';

import { addStampFromFile, listStamps, removeStamp } from '../stamps/storage.js';
import { IPC_CHANNELS } from '~shared/types/ipc.js';
import type { Stamp } from '~shared/types/stamps.js';
import { handle } from './register.js';

export function registerStampsIpc(): void {
  handle<[], Stamp[]>(IPC_CHANNELS.stamps.list, () => listStamps());

  handle<[], Stamp | null>(IPC_CHANNELS.stamps.add, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const opts: Electron.OpenDialogOptions = {
      title: 'Add stamp',
      properties: ['openFile'],
      filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg'] }],
    };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);

    if (result.canceled || result.filePaths.length === 0) return null;
    const srcPath = result.filePaths[0];
    if (!srcPath) return null;
    return addStampFromFile(srcPath);
  });

  handle<[string], void>(IPC_CHANNELS.stamps.remove, (_event, id) => removeStamp(id));
}
