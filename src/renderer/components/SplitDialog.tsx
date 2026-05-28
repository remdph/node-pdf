import { useEffect, useRef, useState } from 'react';

import type { SplitInput, SplitRange } from '~shared/types/ipc.js';

interface SplitDialogProps {
  filePath: string;
  totalPages: number;
  isEncrypted: boolean;
  unlockedPassword?: string;
  busy?: boolean;
  onSubmit(payload: { input: SplitInput; openAfterSave: boolean }): void;
  onCancel(): void;
}

/** Distribute pages as evenly as possible, preferring larger first parts
 * when there is a remainder. */
function divideEqually(total: number, parts: number): SplitRange[] {
  const base = Math.floor(total / parts);
  const remainder = total % parts;
  const ranges: SplitRange[] = [];
  let current = 1;
  for (let i = 0; i < parts; i++) {
    const size = base + (i < remainder ? 1 : 0);
    ranges.push({ start: current, end: current + size - 1 });
    current += size;
  }
  return ranges;
}

function validateRanges(
  ranges: SplitRange[],
  total: number,
): { fieldErrors: string[]; overlapError: boolean; valid: boolean } {
  const fieldErrors: string[] = [];

  for (const r of ranges) {
    if (!Number.isInteger(r.start) || r.start < 1 || r.start > total) {
      fieldErrors.push(`Start must be 1-${total}`);
    } else if (!Number.isInteger(r.end) || r.end < r.start || r.end > total) {
      fieldErrors.push(`End must be ${r.start}-${total}`);
    } else {
      fieldErrors.push('');
    }
  }

  const sorted = ranges
    .map((r, i) => ({ i, start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start);
  let overlapError = false;
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i]!.end >= sorted[i + 1]!.start) {
      overlapError = true;
      break;
    }
  }

  const valid = !overlapError && fieldErrors.every((e) => e === '');
  return { fieldErrors, overlapError, valid };
}

const PREVIEW_COLORS = ['#6aa3ff', '#86efac', '#f9a8d4', '#fbbf24', '#c084fc'];

export function SplitDialog({
  filePath,
  totalPages,
  isEncrypted,
  unlockedPassword,
  busy,
  onSubmit,
  onCancel,
}: SplitDialogProps): JSX.Element {
  const [numParts, setNumParts] = useState(2);
  const [ranges, setRanges] = useState<SplitRange[]>(() => divideEqually(totalPages, 2));
  const [openAfterSave, setOpenAfterSave] = useState(true);
  const prevNumParts = useRef(numParts);

  const { fieldErrors, overlapError, valid } = validateRanges(ranges, totalPages);

  useEffect(() => {
    if (prevNumParts.current !== numParts) {
      setRanges(divideEqually(totalPages, numParts));
      prevNumParts.current = numParts;
    }
  }, [numParts, totalPages]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const updateRange = (idx: number, field: 'start' | 'end', raw: string) => {
    const num = parseInt(raw, 10);
    if (!Number.isInteger(num)) return;
    setRanges((prev) => {
      const next = [...prev];
      const existing = next[idx];
      if (!existing) return next;
      next[idx] = { ...existing, [field]: num };
      return next;
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    onSubmit({
      input: {
        filePath,
        ranges,
        openAfterSave,
        ...(isEncrypted && unlockedPassword ? { password: unlockedPassword } : {}),
      },
      openAfterSave,
    });
  };

  const basename = filePath.split(/[\\/]/).pop()?.replace(/\.pdf$/i, '') ?? 'document';

  return (
    <div
      className="password-dialog-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <form
        className="password-dialog split-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Split PDF"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <header className="password-dialog-header">
          <div>
            <h2 className="password-dialog-title">Split PDF</h2>
            <p className="password-dialog-subtitle muted small" title={filePath}>
              {basename}
            </p>
          </div>
          <button
            type="button"
            className="password-dialog-close"
            onClick={onCancel}
            aria-label="Close"
            disabled={busy}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
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

        <div className="password-dialog-body">
          <p className="muted small">{totalPages} pages total</p>

          <label className="password-dialog-field">
            <span className="password-dialog-label">Number of parts</span>
            <div className="split-parts-stepper">
              <button
                type="button"
                onClick={() => setNumParts(Math.max(2, numParts - 1))}
                disabled={busy || numParts <= 2}
              >
                −
              </button>
              <span>{numParts}</span>
              <button
                type="button"
                onClick={() => setNumParts(Math.min(20, numParts + 1))}
                disabled={busy || numParts >= 20}
              >
                +
              </button>
            </div>
          </label>

          <div className="split-ranges">
            {ranges.map((r, i) => (
              <div
                key={i}
                className={`split-range-row${fieldErrors[i] ? ' split-range-error' : ''}`}
              >
                <span className="split-range-label">Part {i + 1}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  className="password-dialog-input split-range-input"
                  value={r.start}
                  onChange={(e) => updateRange(i, 'start', e.target.value)}
                  disabled={busy}
                  aria-label={`Part ${i + 1} start page`}
                />
                <span className="split-range-to">to</span>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  className="password-dialog-input split-range-input"
                  value={r.end}
                  onChange={(e) => updateRange(i, 'end', e.target.value)}
                  disabled={busy}
                  aria-label={`Part ${i + 1} end page`}
                />
                <span className="split-range-count">
                  {r.end - r.start + 1}p
                </span>
              </div>
            ))}
          </div>

          {overlapError && (
            <div className="password-dialog-error small">
              Page ranges must not overlap.
            </div>
          )}
          {fieldErrors.some((e) => e !== '') && (
            <div className="password-dialog-error small">
              {fieldErrors.find((e) => e !== '') ?? 'Invalid range'}
            </div>
          )}

          <div className="split-preview-bar" aria-hidden="true">
            {ranges.map((r, i) => (
              <div
                key={i}
                className="split-preview-segment"
                style={{
                  width: `${((r.end - r.start + 1) / totalPages) * 100}%`,
                  background: PREVIEW_COLORS[i % PREVIEW_COLORS.length],
                  opacity: overlapError ? 0.4 : 1,
                }}
                title={`Part ${i + 1}: pages ${r.start}–${r.end}`}
              />
            ))}
          </div>

          <label className="split-open-after">
            <input
              type="checkbox"
              checked={openAfterSave}
              onChange={(e) => setOpenAfterSave(e.target.checked)}
              disabled={busy}
            />
            <span>Open split parts as new tabs</span>
          </label>
        </div>

        <footer className="password-dialog-footer">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!valid || busy}>
            {busy ? 'Splitting…' : `Split into ${numParts} parts`}
          </button>
        </footer>
      </form>
    </div>
  );
}
