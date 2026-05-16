import { app } from 'electron';

import { IPC_CHANNELS } from '~shared/types/ipc.js';
import { handle } from './register.js';

export function registerAppIpc(): void {
  handle<[], string>(IPC_CHANNELS.app.version, () => app.getVersion());
}
