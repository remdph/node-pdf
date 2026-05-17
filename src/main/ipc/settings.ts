import { IPC_CHANNELS } from '~shared/types/ipc.js';
import type { AppSettings } from '~shared/types/settings.js';

import { getSettings, setSettings } from '../settings/store.js';
import { handle } from './register.js';

export function registerSettingsIpc(): void {
  handle<[], AppSettings>(IPC_CHANNELS.settings.get, () => getSettings());

  handle<[Partial<AppSettings>], AppSettings>(
    IPC_CHANNELS.settings.set,
    (_event, patch) => setSettings(patch ?? {}),
  );
}
