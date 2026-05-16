import { useEffect, useMemo, useRef, useState } from 'react';

import type { PrinterInfo } from '~shared/types/ipc.js';

import { ipc } from '../lib/ipc.js';

interface PrintDialogProps {
  filePath: string;
  /** Display name for the document (used as the dialog subtitle). */
  title: string;
  onClose(): void;
}

type PrintersState =
  | { kind: 'loading' }
  | { kind: 'ready'; printers: PrinterInfo[] }
  | { kind: 'error'; message: string };

export function PrintDialog({ filePath, title, onClose }: PrintDialogProps): JSX.Element {
  const [printers, setPrinters] = useState<PrintersState>({ kind: 'loading' });
  const [selectedName, setSelectedName] = useState<string>('');
  const [copies, setCopies] = useState(1);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);

  // Close on Escape; click on backdrop also closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Fetch printers.
  useEffect(() => {
    let cancelled = false;
    ipc.printer
      .list()
      .then((list) => {
        if (cancelled) return;
        setPrinters({ kind: 'ready', printers: list });
        const def = list.find((p) => p.isDefault) ?? list[0];
        if (def) setSelectedName(def.name);
      })
      .catch((err: Error) => {
        if (!cancelled) setPrinters({ kind: 'error', message: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the cached first-page thumbnail for the preview.
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const thumbUrlRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    ipc.recents
      .readThumb(filePath)
      .then((bytes) => {
        if (cancelled || !bytes) return;
        const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
        thumbUrlRef.current = url;
        setThumbUrl(url);
      })
      .catch(() => {
        // No preview — that's fine, the dialog still works without it.
      });
    return () => {
      cancelled = true;
      if (thumbUrlRef.current) {
        URL.revokeObjectURL(thumbUrlRef.current);
        thumbUrlRef.current = null;
      }
    };
  }, [filePath]);

  const canPrint = useMemo(
    () =>
      printers.kind === 'ready' &&
      printers.printers.length > 0 &&
      selectedName.length > 0 &&
      !printing,
    [printers, selectedName, printing],
  );

  const handlePrint = async () => {
    if (!canPrint) return;
    setPrinting(true);
    setPrintError(null);
    try {
      await ipc.pdf.print(filePath, {
        deviceName: selectedName,
        copies: Math.max(1, Math.min(99, Math.floor(copies))),
      });
      onClose();
    } catch (err) {
      console.error('[PrintDialog] print failed', err);
      setPrintError(err instanceof Error ? err.message : String(err));
    } finally {
      setPrinting(false);
    }
  };

  return (
    <div
      className="print-dialog-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="print-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Print"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="print-dialog-header">
          <div>
            <h2 className="print-dialog-title">Print</h2>
            <p className="print-dialog-subtitle muted small" title={filePath}>
              {title}
            </p>
          </div>
          <button
            type="button"
            className="print-dialog-close"
            onClick={onClose}
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <path
                d="M2,2 L12,12 M12,2 L2,12"
                stroke="currentColor"
                strokeWidth="1.4"
                fill="none"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        <div className="print-dialog-body">
          <div className="print-dialog-preview">
            {thumbUrl ? (
              <img src={thumbUrl} alt="" className="print-dialog-preview-img" />
            ) : (
              <div className="print-dialog-preview-empty muted small">
                Preview not available
              </div>
            )}
          </div>

          <div className="print-dialog-controls">
            {printers.kind === 'loading' && (
              <div className="muted small">Looking for printers…</div>
            )}

            {printers.kind === 'error' && (
              <div className="print-dialog-error">
                <strong>Could not list printers</strong>
                <p className="muted small">{printers.message}</p>
              </div>
            )}

            {printers.kind === 'ready' && printers.printers.length === 0 && (
              <div className="print-dialog-error">
                <strong>No printers available</strong>
                <p className="muted small">
                  No printers are configured on this system. Add one in your OS settings
                  and re-open the dialog.
                </p>
              </div>
            )}

            {printers.kind === 'ready' && printers.printers.length > 0 && (
              <>
                <label className="print-dialog-field">
                  <span className="print-dialog-label">Printer</span>
                  <select
                    className="print-dialog-select"
                    value={selectedName}
                    onChange={(e) => setSelectedName(e.target.value)}
                    disabled={printing}
                  >
                    {printers.printers.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.displayName}
                        {p.isDefault ? ' (default)' : ''}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="print-dialog-field">
                  <span className="print-dialog-label">Copies</span>
                  <input
                    type="number"
                    className="print-dialog-input"
                    min={1}
                    max={99}
                    value={copies}
                    onChange={(e) => {
                      const n = Number.parseInt(e.target.value, 10);
                      setCopies(Number.isFinite(n) ? n : 1);
                    }}
                    disabled={printing}
                  />
                </label>

                {printError && (
                  <div className="print-dialog-error small">{printError}</div>
                )}
              </>
            )}
          </div>
        </div>

        <footer className="print-dialog-footer">
          <button type="button" onClick={onClose} disabled={printing}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={handlePrint}
            disabled={!canPrint}
          >
            {printing ? 'Printing…' : 'Print'}
          </button>
        </footer>
      </div>
    </div>
  );
}
