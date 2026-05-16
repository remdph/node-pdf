import { BrowserWindow } from 'electron';

import { IPC_CHANNELS } from '~shared/types/ipc.js';
import { handle } from './register.js';

function fromEvent(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

export function registerWindowIpc(): void {
  handle(IPC_CHANNELS.window.minimize, (event) => {
    fromEvent(event)?.minimize();
  });

  handle(IPC_CHANNELS.window.maximizeToggle, (event) => {
    const win = fromEvent(event);
    if (!win) return false;
    if (win.isMaximized()) {
      win.unmaximize();
      return false;
    }
    win.maximize();
    return true;
  });

  handle(IPC_CHANNELS.window.close, (event) => {
    fromEvent(event)?.close();
  });

  handle(IPC_CHANNELS.window.isMaximized, (event) => {
    return fromEvent(event)?.isMaximized() ?? false;
  });
}
