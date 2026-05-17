import { create } from 'zustand';

import { DEFAULT_SETTINGS, type AppSettings } from '~shared/types/settings.js';

import { ipc } from '../lib/ipc.js';

interface SettingsState {
  settings: AppSettings;
  loaded: boolean;
  load(): Promise<void>;
  /** Partial update — local state is patched optimistically and reconciled
   * with whatever the main process returns (defaults filling in missing
   * keys, future server-side validation, etc.). */
  update(patch: Partial<AppSettings>): Promise<void>;
}

export const useSettingsStore = create<SettingsState>()((set) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  load: async () => {
    const settings = await ipc.settings.get();
    set({ settings, loaded: true });
  },

  update: async (patch) => {
    const next = await ipc.settings.set(patch);
    set({ settings: next });
  },
}));
