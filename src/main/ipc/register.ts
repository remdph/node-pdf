import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

import { NodePdfError } from '~shared/types/errors.js';

type Handler<TArgs extends unknown[], TResult> = (
  event: IpcMainInvokeEvent,
  ...args: TArgs
) => Promise<TResult> | TResult;

export function handle<TArgs extends unknown[], TResult>(
  channel: string,
  handler: Handler<TArgs, TResult>,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...(args as TArgs));
    } catch (err) {
      if (err instanceof NodePdfError) {
        const { code, message, cause } = err.toIpc();
        const error = new Error(message) as Error & { code?: string; cause?: string };
        error.code = code;
        if (cause) error.cause = cause;
        throw error;
      }
      throw err;
    }
  });
}
