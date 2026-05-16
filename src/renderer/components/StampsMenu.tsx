import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useStampsStore } from '../stores/stamps.js';

interface StampsMenuProps {
  anchor: HTMLElement;
  onClose(): void;
  onSelect(stampId: string): void;
}

export function StampsMenu({ anchor, onClose, onSelect }: StampsMenuProps): JSX.Element {
  const stamps = useStampsStore((s) => s.stamps);
  const loaded = useStampsStore((s) => s.loaded);
  const load = useStampsStore((s) => s.load);
  const add = useStampsStore((s) => s.add);
  const remove = useStampsStore((s) => s.remove);

  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  useLayoutEffect(() => {
    // Anchor the popover's right edge to the button's right edge so it
    // grows leftward — the stamps button sits in the right toolbar group
    // and the popover would otherwise overflow off-screen.
    const rect = anchor.getBoundingClientRect();
    setPos({
      top: rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right),
    });
  }, [anchor]);

  // Close on outside click + ESC.
  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      if (!popoverRef.current) return;
      if (popoverRef.current.contains(e.target as Node)) return;
      if (anchor.contains(e.target as Node)) return;
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
  }, [anchor, onClose]);

  const handleAdd = async () => {
    try {
      await add();
    } catch (err) {
      console.error('[StampsMenu] add failed', err);
    }
  };

  const handleSelect = (id: string) => {
    onSelect(id);
    onClose();
  };

  const handleRemove = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await remove(id);
    } catch (err) {
      console.error('[StampsMenu] remove failed', err);
    }
  };

  if (!pos) return <></>;

  return (
    <div
      ref={popoverRef}
      className="stamps-menu"
      role="dialog"
      aria-label="Stamps"
      style={{ top: pos.top, right: pos.right }}
    >
      <div className="stamps-menu-header">
        <span className="stamps-menu-title">Stamps</span>
        <button type="button" className="stamps-menu-add" onClick={handleAdd}>
          + Add
        </button>
      </div>

      {stamps.length === 0 ? (
        <div className="stamps-menu-empty muted small">
          No stamps yet. Add a PNG (with transparency) or JPEG.
        </div>
      ) : (
        <div className="stamps-menu-grid">
          {stamps.map((stamp) => (
            <div
              key={stamp.id}
              className="stamp-chip"
              role="button"
              tabIndex={0}
              onClick={() => handleSelect(stamp.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleSelect(stamp.id);
                }
              }}
              title={stamp.name}
            >
              <img
                src={`stamp://${stamp.id}`}
                alt={stamp.name}
                className="stamp-chip-img"
                draggable={false}
              />
              <span className="stamp-chip-label">{stamp.name}</span>
              <button
                type="button"
                className="stamp-chip-remove"
                aria-label={`Remove ${stamp.name}`}
                onClick={(e) => handleRemove(e, stamp.id)}
              >
                <span aria-hidden>×</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
