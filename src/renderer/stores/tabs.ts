import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface PdfTab {
  id: string;
  /** Display name (typically the file basename without extension). */
  title: string;
  /** Absolute path to the PDF on disk. */
  filePath: string;
}

export interface RecentDoc {
  filePath: string;
  title: string;
  /** ISO timestamp of the most recent open. */
  lastOpenedAt: string;
}

export type View = 'picker' | 'tab';
/** Which mode the per-tab side panel shows. `null` = panel collapsed. */
export type SidePanelMode = 'thumbs' | 'outline' | null;

interface TabsState {
  tabs: PdfTab[];
  activeId: string | null;
  view: View;
  sidePanel: SidePanelMode;
  recents: RecentDoc[];
  setView(view: View): void;
  close(id: string): void;
  activate(id: string): void;
  openPdf(input: { filePath: string; title?: string }): void;
  /** Update the visible title for a tab (e.g. after the user renames it). */
  updateTitle(tabId: string, title: string): void;
  closeAll(): void;
  /** Toggle the side panel into a specific mode; clicking the active mode
   * collapses the panel. */
  toggleSidePanel(mode: Exclude<SidePanelMode, null>): void;
  addRecent(input: { filePath: string; title?: string }): void;
  removeRecent(filePath: string): void;
}

const RECENTS_MAX = 10;

const makeId = () => `tab-${Math.random().toString(36).slice(2, 10)}`;

function deriveTitle(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  return base.replace(/\.pdf$/i, '');
}

export const useTabsStore = create<TabsState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeId: null,
      view: 'picker',
      sidePanel: null,
      recents: [],

      setView: (view) => set({ view }),

      toggleSidePanel: (mode) =>
        set((s) => ({ sidePanel: s.sidePanel === mode ? null : mode })),

      close: (id) => {
        const { tabs, activeId } = get();
        const idx = tabs.findIndex((t) => t.id === id);
        if (idx === -1) return;
        const next = tabs.filter((t) => t.id !== id);
        if (next.length === 0) {
          set({ tabs: [], activeId: null, view: 'picker' });
          return;
        }
        let nextActive = activeId;
        if (activeId === id) {
          const fallback = next[idx] ?? next[idx - 1] ?? next[0] ?? null;
          nextActive = fallback?.id ?? null;
        }
        set({ tabs: next, activeId: nextActive });
      },

      activate: (id) => {
        if (get().tabs.some((t) => t.id === id)) {
          set({ activeId: id, view: 'tab' });
        }
      },

      openPdf: ({ filePath, title }) => {
        const finalTitle = title?.trim() || deriveTitle(filePath);
        const { tabs } = get();
        const existing = tabs.find((t) => t.filePath === filePath);
        if (existing) {
          set({ activeId: existing.id, view: 'tab' });
        } else {
          const tab: PdfTab = {
            id: makeId(),
            title: finalTitle,
            filePath,
          };
          set({ tabs: [...tabs, tab], activeId: tab.id, view: 'tab' });
        }
        get().addRecent({ filePath, title: finalTitle });
      },

      updateTitle: (tabId, title) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)),
        })),

      closeAll: () => set({ tabs: [], activeId: null, view: 'picker' }),

      addRecent: ({ filePath, title }) => {
        const finalTitle = title?.trim() || deriveTitle(filePath);
        set((s) => {
          const filtered = s.recents.filter((r) => r.filePath !== filePath);
          const next: RecentDoc = {
            filePath,
            title: finalTitle,
            lastOpenedAt: new Date().toISOString(),
          };
          return { recents: [next, ...filtered].slice(0, RECENTS_MAX) };
        });
      },

      removeRecent: (filePath) =>
        set((s) => ({ recents: s.recents.filter((r) => r.filePath !== filePath) })),
    }),
    {
      name: 'node-pdf:tabs',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        tabs: state.tabs,
        activeId: state.activeId,
        view: state.view,
        sidePanel: state.sidePanel,
        recents: state.recents,
      }),
      version: 4,
      migrate: (persisted, version) => {
        if (!persisted || typeof persisted !== 'object') return persisted;
        // v3 → v4: thumbsOpen boolean → sidePanel discriminated mode.
        if (version < 4) {
          const old = persisted as { thumbsOpen?: boolean };
          const sidePanel: SidePanelMode = old.thumbsOpen ? 'thumbs' : null;
          const next = { ...old, sidePanel };
          delete (next as { thumbsOpen?: boolean }).thumbsOpen;
          return next;
        }
        return persisted;
      },
    },
  ),
);
