import { useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page } from 'react-pdf';

import { ipc } from '../lib/ipc.js';
import { useTabsStore, type RecentDoc } from '../stores/tabs.js';

const THUMB_WIDTH = 130;

export function RecentsCarousel(): JSX.Element | null {
  const recents = useTabsStore((s) => s.recents);
  if (recents.length === 0) return null;
  return (
    <section className="recents" aria-label="Recent documents">
      <h2 className="recents-heading">Recent</h2>
      <div className="recents-strip">
        {recents.map((r) => (
          <RecentItem key={r.filePath} recent={r} />
        ))}
      </div>
    </section>
  );
}

type LoadState =
  | { kind: 'loading' }
  /** Fast path: cached JPEG sibling is fresh, displayed as <img>. */
  | { kind: 'thumb'; url: string }
  /** Slow path: no cached thumb (or stale), parse the full PDF and render
   * page 1. The PdfView will refresh the cache next time the PDF is opened. */
  | { kind: 'pdf'; data: Uint8Array }
  | { kind: 'error' };

function RecentItem({ recent }: { recent: RecentDoc }): JSX.Element {
  const openPdf = useTabsStore((s) => s.openPdf);
  const removeRecent = useTabsStore((s) => s.removeRecent);
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const itemRef = useRef<HTMLDivElement>(null);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: 'loading' });

    (async () => {
      // 1. Try the cached thumb sibling first (fast).
      try {
        const thumbBytes = await ipc.recents.readThumb(recent.filePath);
        if (cancelled) return;
        if (thumbBytes) {
          const blob = new Blob([thumbBytes], { type: 'image/jpeg' });
          const url = URL.createObjectURL(blob);
          blobUrlRef.current = url;
          setLoad({ kind: 'thumb', url });
          return;
        }
      } catch {
        // ignore — fall through to PDF render
      }

      // 2. Fallback: read and render the actual PDF page 1.
      try {
        const data = await ipc.pdf.read(recent.filePath);
        if (!cancelled) setLoad({ kind: 'pdf', data });
      } catch {
        if (!cancelled) setLoad({ kind: 'error' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [recent.filePath]);

  // Revoke any blob URL we created when this item unmounts or reloads.
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [recent.filePath]);

  const file = useMemo(
    () => (load.kind === 'pdf' ? { data: load.data } : null),
    [load],
  );

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const onActivate = () => openPdf({ filePath: recent.filePath, title: recent.title });

  return (
    <div
      ref={itemRef}
      className="recent-item"
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate();
        }
      }}
      onContextMenu={onContextMenu}
      role="button"
      tabIndex={0}
      title={recent.filePath}
    >
      <div className="recent-thumb">
        {load.kind === 'loading' && <div className="recent-thumb-loading" />}
        {load.kind === 'error' && (
          <div className="recent-thumb-error" aria-hidden>
            !
          </div>
        )}
        {load.kind === 'thumb' && (
          <img src={load.url} alt="" className="recent-thumb-img" draggable={false} />
        )}
        {load.kind === 'pdf' && file && (
          <Document
            file={file}
            loading={<div className="recent-thumb-loading" />}
            error={
              <div className="recent-thumb-error" aria-hidden>
                !
              </div>
            }
            onLoadError={() => setLoad({ kind: 'error' })}
          >
            <Page
              pageNumber={1}
              width={THUMB_WIDTH}
              renderTextLayer={false}
              renderAnnotationLayer={false}
            />
          </Document>
        )}
      </div>
      <span className="recent-name" title={recent.title}>
        {recent.title}
      </span>

      {menu && (
        <RecentContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onRemove={() => {
            removeRecent(recent.filePath);
            setMenu(null);
          }}
        />
      )}
    </div>
  );
}

interface ContextMenuProps {
  x: number;
  y: number;
  onClose(): void;
  onRemove(): void;
}

function RecentContextMenu({ x, y, onClose, onRemove }: ContextMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ top: y, left: x }}
      role="menu"
      onClick={(e) => e.stopPropagation()}
    >
      <button type="button" className="context-menu-item" onClick={onRemove}>
        Remove from recents
      </button>
    </div>
  );
}
