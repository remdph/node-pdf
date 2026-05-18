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
  /** File paths the user has starred from the home view. Lookup is O(n)
   * but the list is tiny so it doesn't matter. */
  starred: string[];
  setView(view: View): void;
  close(id: string): void;
  activate(id: string): void;
  openPdf(input: { filePath: string; title?: string }): void;
  /** Update the visible title for a tab (e.g. after the user renames it). */
  updateTitle(tabId: string, title: string): void;
  /** Move a tab from `fromIndex` to `toIndex` (drag-and-drop reorder).
   * `toIndex` is the slot the tab should occupy AFTER removal — same
   * convention as the HTML5 DnD drop position the titlebar passes in. */
  reorder(fromIndex: number, toIndex: number): void;
  closeAll(): void;
  /** Toggle the side panel into a specific mode; clicking the active mode
   * collapses the panel. */
  toggleSidePanel(mode: Exclude<SidePanelMode, null>): void;
  addRecent(input: { filePath: string; title?: string }): void;
  removeRecent(filePath: string): void;
  toggleStarred(filePath: string): void;
}

const RECENTS_MAX = 10;

const makeId = () => `tab-${Math.random().toString(36).slice(2, 10)}`;

function deriveTitle(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

export const useTabsStore = create<TabsState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeId: null,
      view: 'picker',
      sidePanel: null,
      recents: [],
      starred: [],

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

      reorder: (fromIndex, toIndex) =>
        set((s) => {
          if (fromIndex === toIndex) return {};
          if (fromIndex < 0 || fromIndex >= s.tabs.length) return {};
          if (toIndex < 0 || toIndex > s.tabs.length) return {};
          const next = s.tabs.slice();
          const [moved] = next.splice(fromIndex, 1);
          if (!moved) return {};
          const insertAt = toIndex > fromIndex ? toIndex - 1 : toIndex;
          next.splice(insertAt, 0, moved);
          return { tabs: next };
        }),

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
        set((s) => ({
          recents: s.recents.filter((r) => r.filePath !== filePath),
          // Remove the starred mark too so we never end up with a dangling
          // path that the user can't unstar.
          starred: s.starred.filter((p) => p !== filePath),
        })),

      toggleStarred: (filePath) =>
        set((s) => ({
          starred: s.starred.includes(filePath)
            ? s.starred.filter((p) => p !== filePath)
            : [...s.starred, filePath],
        })),
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
        starred: state.starred,
      }),
      version: 6,
      migrate: (persisted, version) => {
        if (!persisted || typeof persisted !== 'object') return persisted;
        let next = persisted as Record<string, unknown>;
        // v3 → v4: thumbsOpen boolean → sidePanel discriminated mode.
        if (version < 4) {
          const old = next as { thumbsOpen?: boolean };
          const sidePanel: SidePanelMode = old.thumbsOpen ? 'thumbs' : null;
          next = { ...next, sidePanel };
          delete (next as { thumbsOpen?: boolean }).thumbsOpen;
        }
        // v4 → v5: introduces `starred` list.
        if (version < 5) {
          next = { ...next, starred: [] };
        }
        // v5 → v6: tab/recent titles now include the `.pdf` extension.
        // Re-derive any title that's the bare basename of its filePath —
        // updateTitle is never invoked from the UI today so this is safe.
        if (version < 6) {
          const restore = <T extends { title?: string; filePath?: string }>(t: T): T => {
            if (!t || typeof t.filePath !== 'string') return t;
            const base = t.filePath.split(/[\\/]/).pop() ?? t.filePath;
            const stripped = base.replace(/\.pdf$/i, '');
            // Only rewrite if the stored title matches the auto-derived
            // stripped basename; preserve anything bespoke (defensive — no
            // UI path produces a custom title yet).
            if (t.title === stripped && stripped !== base) {
              return { ...t, title: base };
            }
            return t;
          };
          const ntabs = Array.isArray(next.tabs) ? (next.tabs as PdfTab[]).map(restore) : next.tabs;
          const nrec = Array.isArray(next.recents) ? (next.recents as RecentDoc[]).map(restore) : next.recents;
          next = { ...next, tabs: ntabs, recents: nrec };
        }
        return next;
      },
    },
  ),
);
