import { useEffect } from 'react';

import { HomeView } from './components/HomeView.js';
import { PdfView } from './components/PdfView.js';
import { TitleBar } from './components/TitleBar.js';
import { UpdateBanner } from './components/UpdateBanner.js';
import { ipc } from './lib/ipc.js';
import { applyTheme } from './lib/theme.js';
import { useSettingsStore } from './stores/settings.js';
import { useTabsStore } from './stores/tabs.js';

export function App(): JSX.Element {
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const view = useTabsStore((s) => s.view);
  const openPdf = useTabsStore((s) => s.openPdf);
  const loadSettings = useSettingsStore((s) => s.load);
  const theme = useSettingsStore((s) => s.settings.theme);

  // Pull the persisted settings on mount. main.tsx already applied the
  // cached theme synchronously to avoid a flash, but settings.json is
  // the source of truth — reconcile here once it lands.
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Open paths handed to us by the OS shell ("Open with NodePDF" / file
  // double-click). Two channels:
  //   1. flushPending() — paths that arrived before the renderer mounted
  //      (cold start launched from Finder/Explorer).
  //   2. onOpenExternal — live pushes while the app is already running
  //      (macOS 'open-file' or a second-instance launch).
  useEffect(() => {
    void ipc.pdf.flushPending().then((paths) => {
      for (const p of paths) openPdf({ filePath: p });
    });
    return ipc.pdf.onOpenExternal((filePath) => openPdf({ filePath }));
  }, [openPdf]);

  // Cmd+W (macOS) / Ctrl+W (Win/Linux): close the active tab instead of
  // the whole window. preventDefault() in the renderer stops Electron's
  // built-in "close window" shortcut from firing. The store is read via
  // getState() so the effect doesn't need to re-bind on every tab change.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const accel = ipc.platform === 'darwin' ? e.metaKey : e.ctrlKey;
      if (!accel) return;
      if (e.key !== 'w' && e.key !== 'W') return;
      e.preventDefault();
      const state = useTabsStore.getState();
      if (state.activeId) state.close(state.activeId);
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);

  // Render every open tab's PdfView side-by-side and toggle visibility via
  // CSS instead of mounting/unmounting. That way each tab keeps its parsed
  // PDF, snapshot cache, page, scroll position and zoom across tab switches.
  //
  // Belt-and-suspenders: if there are no tabs at all, always show home
  // regardless of `view`/`activeId`. The tabs store normalizes on
  // rehydration to keep these in sync, but stale state from older
  // builds (or a future code path that forgets to clear them when
  // tabs hits zero) shouldn't leave the user staring at a blank surface.
  const showHome = tabs.length === 0 || view !== 'tab' || activeId === null;

  return (
    <main className="app">
      <TitleBar />
      <div className="app-content">
        <div className="app-body">
          {tabs.map((tab) => {
            const isActive = view === 'tab' && tab.id === activeId;
            return (
              <div
                key={tab.id}
                className={`pdf-view-host${isActive ? '' : ' pdf-view-host-hidden'}`}
              >
                <PdfView filePath={tab.filePath} />
              </div>
            );
          })}
          {showHome && <HomeView />}
        </div>
      </div>
      <UpdateBanner />
    </main>
  );
}
