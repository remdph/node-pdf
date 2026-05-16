import { useEffect } from 'react';

import { PdfView } from './components/PdfView.js';
import { RecentsCarousel } from './components/RecentsCarousel.js';
import { TitleBar } from './components/TitleBar.js';
import { ipc } from './lib/ipc.js';
import { useTabsStore } from './stores/tabs.js';

export function App(): JSX.Element {
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const view = useTabsStore((s) => s.view);
  const openPdf = useTabsStore((s) => s.openPdf);

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

  const handleOpenPdf = async () => {
    const filePath = await ipc.pdf.open();
    if (filePath) openPdf({ filePath });
  };

  // Render every open tab's PdfView side-by-side and toggle visibility via
  // CSS instead of mounting/unmounting. That way each tab keeps its parsed
  // PDF, snapshot cache, page, scroll position and zoom across tab switches.
  const showPicker = view !== 'tab' || activeId === null;

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
          {showPicker && (
            <div className="picker">
              <div className="picker-stack">
                <section className="recents" aria-label="Open document">
                  <h2 className="recents-heading">Open</h2>
                  <div className="recents-strip">
                    <button
                      type="button"
                      className="recent-item recent-item-add"
                      onClick={handleOpenPdf}
                      aria-label="Open PDF"
                      title="Open PDF"
                    >
                      <div className="recent-thumb recent-thumb-add">
                        <svg viewBox="0 0 48 48" fill="none" aria-hidden>
                          <path
                            d="M24 14 V34 M14 24 H34"
                            stroke="currentColor"
                            strokeWidth="2.4"
                            strokeLinecap="round"
                          />
                        </svg>
                      </div>
                    </button>
                  </div>
                </section>
                <RecentsCarousel />
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
