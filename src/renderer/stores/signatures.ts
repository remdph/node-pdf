import { create } from 'zustand';

import type {
  CreateSignatureFromBytesInput,
  Signature,
} from '~shared/types/signatures.js';

import { ipc } from '../lib/ipc.js';

interface SignaturesState {
  signatures: Signature[];
  loaded: boolean;
  /** Currently armed signature for the placement overlay. */
  selectedId: string | null;
  load(): Promise<void>;
  createFromBytes(input: CreateSignatureFromBytesInput): Promise<Signature>;
  createFromFile(): Promise<Signature | null>;
  remove(id: string): Promise<void>;
  select(id: string | null): void;
}

export const useSignaturesStore = create<SignaturesState>()((set, get) => ({
  signatures: [],
  loaded: false,
  selectedId: null,

  load: async () => {
    const signatures = await ipc.signatures.list();
    set({ signatures, loaded: true });
  },

  createFromBytes: async (input) => {
    const signature = await ipc.signatures.createFromBytes(input);
    set({ signatures: [...get().signatures, signature] });
    return signature;
  },

  createFromFile: async () => {
    const signature = await ipc.signatures.createFromFile();
    if (!signature) return null;
    set({ signatures: [...get().signatures, signature] });
    return signature;
  },

  remove: async (id) => {
    await ipc.signatures.remove(id);
    set((s) => ({
      signatures: s.signatures.filter((x) => x.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    }));
  },

  select: (id) => set({ selectedId: id }),
}));
