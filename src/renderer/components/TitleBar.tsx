import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useTabsStore, type PdfTab } from '../stores/tabs.js';
import { ipc } from '../lib/ipc.js';
import iconUrl from '../assets/icon.png';
import { AboutDialog } from './AboutDialog.js';

// Layout caps mirrored from .tab in global.css. Used only as fallbacks
// when measurement hasn't run yet — the actual widths come from the
// off-screen measurement container's offsetWidth.
const TAB_MAX_WIDTH = 200;
const OVERFLOW_BTN_WIDTH = 30;
const DND_MIME = 'application/x-nodepdf-tab';

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
  const reorder = useTabsStore((s) => s.reorder);

  const [maximized, setMaximized] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // Measured natural width of each tab, keyed by tab id. Populated by the
  // off-screen .titlebar-tabs-measure container after each render.
  const measureRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [tabWidths, setTabWidths] = useState<Map<string, number>>(new Map());
  const [draggingId, setDraggingId] = useState<string | null>(null);

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

  // Read each tab's natural offsetWidth from the off-screen measurement
  // container after every render that could change a tab's intrinsic
  // size: open/close/reorder (tabs identity), active swap (the star
  // button only renders for the active tab and adds 22+gap to width),
  // or rename (title text length). Only commit a new Map if something
  // actually changed so we don't trigger render loops.
  useLayoutEffect(() => {
    const widths = new Map<string, number>();
    for (const t of tabs) {
      const el = measureRefs.current.get(t.id);
      if (el) widths.set(t.id, el.offsetWidth);
    }
    setTabWidths((prev) => {
      if (prev.size !== widths.size) return widths;
      for (const [k, v] of widths) {
        if (prev.get(k) !== v) return widths;
      }
      return prev;
    });
  }, [tabs, activeId]);

  // Decide which tabs are visible and which spill into the overflow menu.
  // The active tab is pinned so it always shows, even if its natural slot
  // would have been hidden (Chrome / VSCode behavior). Widths come from
  // the measurement pass above; before that lands we render everything
  // and let the next paint correct it.
  const { visibleTabs, hiddenTabs } = useMemo(() => {
    if (tabs.length === 0) return { visibleTabs: [], hiddenTabs: [] };
    if (containerWidth === 0 || tabWidths.size === 0) {
      return { visibleTabs: tabs, hiddenTabs: [] };
    }
    const widthOf = (id: string) => tabWidths.get(id) ?? TAB_MAX_WIDTH;

    let total = 0;
    for (const t of tabs) total += widthOf(t.id);
    if (total <= containerWidth) {
      return { visibleTabs: tabs, hiddenTabs: [] };
    }

    // Doesn't fit — reserve room for the overflow chevron and greedily
    // pack tabs from the start until budget is exhausted.
    const budget = containerWidth - OVERFLOW_BTN_WIDTH;
    const visibleIds = new Set<string>();
    let used = 0;
    for (const t of tabs) {
      const w = widthOf(t.id);
      if (used + w > budget) break;
      visibleIds.add(t.id);
      used += w;
    }
    // Always keep at least one tab on-screen so the user has something to
    // click; if even the first tab busts the budget, show it anyway.
    if (visibleIds.size === 0 && tabs[0]) {
      visibleIds.add(tabs[0].id);
      used = widthOf(tabs[0].id);
    }

    // Pin the active tab. If it's not in the greedy head, evict trailing
    // visible tabs (preserving original order) until the active fits.
    if (activeId && !visibleIds.has(activeId)) {
      const activeW = widthOf(activeId);
      const visibleOrdered = tabs.filter((t) => visibleIds.has(t.id));
      while (visibleOrdered.length > 0 && used + activeW > budget) {
        const removed = visibleOrdered.pop()!;
        visibleIds.delete(removed.id);
        used -= widthOf(removed.id);
      }
      visibleIds.add(activeId);
    }

    const visible = tabs.filter((t) => visibleIds.has(t.id));
    const hidden = tabs.filter((t) => !visibleIds.has(t.id));
    return { visibleTabs: visible, hiddenTabs: hidden };
  }, [tabs, tabWidths, containerWidth, activeId]);

  const setMeasureRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el) measureRefs.current.set(id, el);
    else measureRefs.current.delete(id);
  };

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
        <>
          <div className="titlebar-brand">
            <img src={iconUrl} alt="NodePDF" className="titlebar-icon" draggable={false} />
          </div>
          <span className="titlebar-sep" aria-hidden />
        </>
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
            index={tabs.findIndex((t) => t.id === tab.id)}
            active={view === 'tab' && tab.id === activeId}
            starred={starred.includes(tab.filePath)}
            isDragging={draggingId === tab.id}
            onActivate={() => activate(tab.id)}
            onClose={() => close(tab.id)}
            onToggleStar={() => toggleStarred(tab.filePath)}
            onDragStartTab={(id) => setDraggingId(id)}
            onDragEndTab={() => setDraggingId(null)}
            onReorder={(from, to) => {
              setDraggingId(null);
              reorder(from, to);
            }}
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

      {/* Off-screen sizing pass — same .tab markup so each item gets its
       * real intrinsic width measured into tabWidths above. Kept outside
       * the titlebar's flex flow so it can't affect the live layout. */}
      <div className="titlebar-tabs-measure" aria-hidden>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            ref={setMeasureRef(tab.id)}
            className={`tab tab-pdf${tab.id === activeId ? ' tab-active' : ''}`}
          >
            {tab.id === activeId && <div className="tab-star" />}
            <span className="tab-title">{tab.title}</span>
            <div className="tab-close" />
          </div>
        ))}
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
  index,
  active,
  starred,
  isDragging,
  onActivate,
  onClose,
  onToggleStar,
  onDragStartTab,
  onDragEndTab,
  onReorder,
}: {
  tab: PdfTab;
  /** Absolute index in the full `tabs` array — what `reorder` expects. */
  index: number;
  active: boolean;
  starred: boolean;
  isDragging: boolean;
  onActivate: () => void;
  onClose: () => void;
  onToggleStar: () => void;
  onDragStartTab: (id: string) => void;
  onDragEndTab: () => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}): JSX.Element {
  const [dropEdge, setDropEdge] = useState<'before' | 'after' | null>(null);

  return (
    <div
      className={
        `tab tab-pdf${active ? ' tab-active' : ''}` +
        `${isDragging ? ' tab-dragging' : ''}` +
        `${dropEdge === 'before' ? ' tab-drop-before' : ''}` +
        `${dropEdge === 'after' ? ' tab-drop-after' : ''}`
      }
      onClick={onActivate}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      role="button"
      tabIndex={0}
      // Native tooltip on the whole tab (not just the title text) so it
      // shows up no matter where on the tab the cursor lands. First line
      // is the filename (the only thing the eye needs when titles are
      // ellipsized at 200px); second line is the absolute path for
      // disambiguating same-name files in different folders.
      title={`${tab.title}\n${tab.filePath}`}
      draggable
      onDragStart={(e) => {
        // Use a custom MIME so we can reject foreign drops (files etc.)
        // in onDragOver without picking up text drops from elsewhere.
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(DND_MIME, String(index));
        e.dataTransfer.setData('text/plain', tab.title);
        onDragStartTab(tab.id);
      }}
      onDragEnd={() => {
        setDropEdge(null);
        onDragEndTab();
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DND_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (isDragging) {
          setDropEdge(null);
          return;
        }
        const r = e.currentTarget.getBoundingClientRect();
        setDropEdge(e.clientX < r.left + r.width / 2 ? 'before' : 'after');
      }}
      onDragLeave={(e) => {
        // Ignore bubbles from children — only clear when the cursor truly
        // leaves the tab box.
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDropEdge(null);
      }}
      onDrop={(e) => {
        const raw = e.dataTransfer.getData(DND_MIME);
        setDropEdge(null);
        if (!raw) return;
        e.preventDefault();
        const fromIndex = Number(raw);
        if (!Number.isFinite(fromIndex)) return;
        const r = e.currentTarget.getBoundingClientRect();
        const before = e.clientX < r.left + r.width / 2;
        const toIndex = before ? index : index + 1;
        onReorder(fromIndex, toIndex);
      }}
    >
      {active && (
        <button
          type="button"
          className={`tab-star${starred ? ' tab-star-on' : ''}`}
          aria-label={starred ? `Unstar ${tab.title}` : `Star ${tab.title}`}
          aria-pressed={starred}
          title={starred ? 'Unstar' : 'Star'}
          // Buttons inside a draggable parent become drag handles by
          // default; opt out so star/close clicks aren't read as drags.
          draggable={false}
          onClick={(e) => {
            e.stopPropagation();
            onToggleStar();
          }}
        >
          <StarIcon filled={starred} />
        </button>
      )}
      <span className="tab-title">{tab.title}</span>
      <button
        type="button"
        className="tab-close"
        aria-label={`Close ${tab.title}`}
        draggable={false}
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
