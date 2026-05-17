import { create } from 'zustand';

import type {
  Certificate,
  GenerateCertInput,
} from '~shared/types/certs.js';

import { ipc } from '../lib/ipc.js';

interface CertsState {
  certs: Certificate[];
  loaded: boolean;
  load(): Promise<void>;
  generate(input: GenerateCertInput): Promise<Certificate>;
  /** Two-step import: pick the file via the OS dialog, then prompt the user
   * for the .p12 password in a renderer dialog and POST the bytes here. */
  importFromPath(filePath: string, password: string, label?: string): Promise<Certificate>;
  pickFile(): Promise<string | null>;
  remove(id: string): Promise<void>;
}

export const useCertsStore = create<CertsState>()((set, get) => ({
  certs: [],
  loaded: false,

  load: async () => {
    const certs = await ipc.certs.list();
    set({ certs, loaded: true });
  },

  generate: async (input) => {
    const cert = await ipc.certs.generate(input);
    set({ certs: [...get().certs, cert] });
    return cert;
  },

  pickFile: () => ipc.certs.pickFile(),

  importFromPath: async (filePath, password, label) => {
    const cert = await ipc.certs.import({ filePath, password, label });
    set({ certs: [...get().certs, cert] });
    return cert;
  },

  remove: async (id) => {
    await ipc.certs.remove(id);
    set((s) => ({ certs: s.certs.filter((c) => c.id !== id) }));
  },
}));
