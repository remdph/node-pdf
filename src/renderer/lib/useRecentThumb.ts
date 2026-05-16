import { useEffect, useState } from 'react';

import { ipc } from './ipc.js';

export type RecentThumbState =
  | { kind: 'loading' }
  /** Fast path: cached JPEG sibling exists. */
  | { kind: 'thumb'; url: string }
  /** Slow path: render the PDF's first page client-side via react-pdf. */
  | { kind: 'pdf'; data: Uint8Array }
  | { kind: 'error' };

/** Loads a thumbnail for a recent PDF: tries the cached JPEG sibling first,
 * falls back to parsing the PDF and rendering page 1. The caller decides
 * how to display each state (the cached JPEG is just an <img>; the PDF
 * fallback needs <Document>/<Page>). */
export function useRecentThumb(filePath: string): RecentThumbState {
  const [load, setLoad] = useState<RecentThumbState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: 'loading' });
    let blobUrl: string | null = null;

    (async () => {
      try {
        const thumbBytes = await ipc.recents.readThumb(filePath);
        if (cancelled) return;
        if (thumbBytes) {
          const blob = new Blob([thumbBytes], { type: 'image/jpeg' });
          blobUrl = URL.createObjectURL(blob);
          setLoad({ kind: 'thumb', url: blobUrl });
          return;
        }
      } catch {
        // fall through to PDF render
      }

      try {
        const data = await ipc.pdf.read(filePath);
        if (!cancelled) setLoad({ kind: 'pdf', data });
      } catch {
        if (!cancelled) setLoad({ kind: 'error' });
      }
    })();

    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [filePath]);

  return load;
}
