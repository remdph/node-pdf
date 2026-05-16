import { create } from 'zustand';

import type { Stamp } from '~shared/types/stamps.js';

import { ipc } from '../lib/ipc.js';

interface StampsState {
  stamps: Stamp[];
  loaded: boolean;
  selectedId: string | null;
  load(): Promise<void>;
  add(): Promise<Stamp | null>;
  remove(id: string): Promise<void>;
  select(id: string | null): void;
}

export const useStampsStore = create<StampsState>()((set, get) => ({
  stamps: [],
  loaded: false,
  selectedId: null,

  load: async () => {
    const stamps = await ipc.stamps.list();
    set({ stamps, loaded: true });
  },

  add: async () => {
    const stamp = await ipc.stamps.add();
    if (!stamp) return null;
    set({ stamps: [...get().stamps, stamp] });
    return stamp;
  },

  remove: async (id) => {
    await ipc.stamps.remove(id);
    set((s) => ({
      stamps: s.stamps.filter((x) => x.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    }));
  },

  select: (id) => set({ selectedId: id }),
}));
