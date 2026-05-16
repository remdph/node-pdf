import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useTabsStore, type PdfTab } from '../stores/tabs.js';
import { ipc } from '../lib/ipc.js';
import iconUrl from '../assets/icon.png';
import { AboutDialog } from './AboutDialog.js';

const TAB_FIXED_WIDTH = 200;
const OVERFLOW_BTN_WIDTH = 30;

// macOS draws native traffic lights over our titlebar; render an empty
// drag-reserved spacer of the same width where the brand icon would sit
// on Win/Linux so tabs don't slip under them.
const isMac = ipc?.platform === 'darwin';

export function TitleBar(): JSX.Element {
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const view = useTabsStore((s) => s.view);
  const activate = useTabsStore((s) => s.activate);
  const close = useTabsStore((s) => s.close);
  const setView = useTabsStore((s) => s.setView);
  const starred = useTabsStore((s) => s.starred);
  const toggleStarred = useTabsStore((s) => s.toggleStarred);

  const [maximized, setMaximized] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    if (!ipc?.window) return;
    void ipc.window.isMaximized().then(setMaximized);
    return ipc.window.onMaximizeChange(setMaximized);
  }, []);

  // The macOS app menu's "About NodePDF" item routes here so the user
  // sees the same rich React dialog (with clickable links) as the
  // titlebar's about button.
  useEffect(() => {
    if (!ipc?.app?.onShowAbout) return;
    return ipc.app.onShowAbout(() => setAboutOpen(true));
  }, []);

  useLayoutEffect(() => {
    const el = tabsContainerRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Decide which tabs are visible and which spill into the overflow menu.
  // The active tab is pinned so it always shows, even if its natural slot
  // would have been hidden (Chrome / VSCode behavior).
  const { visibleTabs, hiddenTabs } = useMemo(() => {
    if (tabs.length === 0) return { visibleTabs: [], hiddenTabs: [] };
    const idealVisible = Math.max(1, Math.floor(containerWidth / TAB_FIXED_WIDTH));
    if (idealVisible >= tabs.length) {
      return { visibleTabs: tabs, hiddenTabs: [] };
    }
    const withButtonVisible = Math.max(
      1,
      Math.floor((containerWidth - OVERFLOW_BTN_WIDTH) / TAB_FIXED_WIDTH),
    );
    const visibleSet = new Set(tabs.slice(0, withButtonVisible).map((t) => t.id));
    if (activeId && !visibleSet.has(activeId)) {
      const lastInHead = tabs.slice(0, withButtonVisible).at(-1);
      if (lastInHead) {
        visibleSet.delete(lastInHead.id);
        visibleSet.add(activeId);
      }
    }
    const visible = tabs.filter((t) => visibleSet.has(t.id));
    const hidden = tabs.filter((t) => !visibleSet.has(t.id));
    return { visibleTabs: visible, hiddenTabs: hidden };
  }, [tabs, containerWidth, activeId]);

  const onMinimize = () => {
    ipc?.window?.minimize().catch((err) => console.error('[TitleBar] minimize failed', err));
  };
  const onMaximize = () => {
    ipc?.window?.maximizeToggle().catch((err) => console.error('[TitleBar] maximize failed', err));
  };
  const onClose = () => {
    ipc?.window?.close().catch((err) => console.error('[TitleBar] close failed', err));
  };

  return (
    <div className="titlebar">
      {isMac ? (
        <div className="titlebar-traffic-light-slot" aria-hidden />
      ) : (
        <div className="titlebar-brand">
          <img src={iconUrl} alt="NodePDF" className="titlebar-icon" draggable={false} />
        </div>
      )}

      <button
        type="button"
        className={`titlebar-leading${view === 'picker' ? ' titlebar-leading-active' : ''}`}
        aria-label="Home"
        aria-pressed={view === 'picker'}
        onClick={() => setView('picker')}
        title="Home"
      >
        <svg width="17" height="17" viewBox="0 0 14 14" fill="none" aria-hidden>
          <path
            d="M2 6.5 L7 2 L12 6.5 V12 a0.6 0.6 0 0 1 -0.6 0.6 H8.5 V9 H5.5 V12.6 H2.6 A0.6 0.6 0 0 1 2 12 Z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      </button>

      <div className="titlebar-tabs" ref={tabsContainerRef}>
        {visibleTabs.map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            active={view === 'tab' && tab.id === activeId}
            starred={starred.includes(tab.filePath)}
            onActivate={() => activate(tab.id)}
            onClose={() => close(tab.id)}
            onToggleStar={() => toggleStarred(tab.filePath)}
          />
        ))}
        {hiddenTabs.length > 0 && (
          <TabOverflow
            tabs={hiddenTabs}
            onActivate={activate}
            onClose={close}
          />
        )}
      </div>

      <div className="titlebar-controls">
        <button
          type="button"
          className="titlebar-btn titlebar-btn-about"
          aria-label="About NodePDF"
          title="About"
          onClick={() => setAboutOpen(true)}
        >
          <svg width="17" height="17" viewBox="0 0 14 14" fill="none" aria-hidden>
            <circle cx="7" cy="7" r="5.6" stroke="currentColor" strokeWidth="1.2" />
            <path
              d="M5.4 5.4 a1.6 1.6 0 1 1 2.6 1.3 c-0.6 0.45 -1 0.7 -1 1.4"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              fill="none"
            />
            <circle cx="7" cy="10.2" r="0.7" fill="currentColor" />
          </svg>
        </button>
        {!isMac && (
          <>
            <button type="button" className="titlebar-btn" aria-label="Minimize" onClick={onMinimize}>
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <rect x="1" y="4.5" width="8" height="1" fill="currentColor" />
              </svg>
            </button>
            <button
              type="button"
              className="titlebar-btn"
              aria-label={maximized ? 'Restore' : 'Maximize'}
              onClick={onMaximize}
            >
              {maximized ? (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                  <rect x="1.5" y="2.5" width="6" height="6" fill="none" stroke="currentColor" />
                  <rect x="3" y="1" width="6" height="6" fill="none" stroke="currentColor" />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                  <rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" />
                </svg>
              )}
            </button>
            <button
              type="button"
              className="titlebar-btn titlebar-btn-close"
              aria-label="Close"
              onClick={onClose}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <path d="M1,1 L9,9 M9,1 L1,9" stroke="currentColor" strokeWidth="1.1" fill="none" />
              </svg>
            </button>
          </>
        )}
      </div>

      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
    </div>
  );
}

function TabItem({
  tab,
  active,
  starred,
  onActivate,
  onClose,
  onToggleStar,
}: {
  tab: PdfTab;
  active: boolean;
  starred: boolean;
  onActivate: () => void;
  onClose: () => void;
  onToggleStar: () => void;
}): JSX.Element {
  return (
    <div
      className={`tab tab-pdf${active ? ' tab-active' : ''}`}
      onClick={onActivate}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      role="button"
      tabIndex={0}
    >
      {active && (
        <button
          type="button"
          className={`tab-star${starred ? ' tab-star-on' : ''}`}
          aria-label={starred ? `Unstar ${tab.title}` : `Star ${tab.title}`}
          aria-pressed={starred}
          title={starred ? 'Unstar' : 'Star'}
          onClick={(e) => {
            e.stopPropagation();
            onToggleStar();
          }}
        >
          <StarIcon filled={starred} />
        </button>
      )}
      <span className="tab-title" title={tab.filePath}>
        {tab.title}
      </span>
      <button
        type="button"
        className="tab-close"
        aria-label={`Close ${tab.title}`}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M1,1 L9,9 M9,1 L1,9" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
    </div>
  );
}

function StarIcon({ filled }: { filled: boolean }): JSX.Element {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M8 1.8l1.95 3.92 4.32.63-3.12 3.04.74 4.3L8 11.66 4.11 13.69l.74-4.3L1.73 6.35l4.32-.63z"
        fill={filled ? '#f7c948' : 'none'}
        stroke={filled ? '#f7c948' : 'currentColor'}
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TabOverflow({
  tabs,
  onActivate,
  onClose,
}: {
  tabs: PdfTab[];
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setPos({
      top: rect.bottom + 4,
      right: Math.max(8, window.innerWidth - rect.right),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (popoverRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`titlebar-tabs-overflow${open ? ' titlebar-tabs-overflow-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-label={`Show ${tabs.length} more tab${tabs.length === 1 ? '' : 's'}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${tabs.length} more`}
      >
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path
            d="M3 4.5 L6 7.5 L9 4.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && pos && (
        <div
          ref={popoverRef}
          className="tabs-overflow-menu"
          style={{ top: pos.top, right: pos.right }}
          role="menu"
        >
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className="tabs-overflow-item"
              role="menuitem"
              tabIndex={0}
              title={tab.filePath}
              onClick={() => {
                onActivate(tab.id);
                setOpen(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onActivate(tab.id);
                  setOpen(false);
                }
              }}
            >
              <PdfIcon />
              <span className="tabs-overflow-item-title">{tab.title}</span>
              <button
                type="button"
                className="tabs-overflow-item-close"
                aria-label={`Close ${tab.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
              >
                <span aria-hidden>×</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function PdfIcon(): JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden
    >
      <path d="M3 1.5h6.5L13 5v9.5H3z" />
      <path d="M9.5 1.5V5H13" />
    </svg>
  );
}
