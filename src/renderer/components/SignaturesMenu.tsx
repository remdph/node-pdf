import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { Signature } from '~shared/types/signatures.js';

import { useSignaturesStore } from '../stores/signatures.js';
import { SignatureEditor } from './SignatureEditor.js';

interface SignaturesMenuProps {
  anchor: HTMLElement;
  onClose(): void;
  /** Called when the user picks a signature for placement on the page. */
  onSelect(signatureId: string): void;
}

const KIND_LABEL: Record<Signature['kind'], string> = {
  drawn: 'Drawn',
  typed: 'Typed',
  image: 'Image',
};

export function SignaturesMenu({
  anchor,
  onClose,
  onSelect,
}: SignaturesMenuProps): JSX.Element {
  const signatures = useSignaturesStore((s) => s.signatures);
  const loaded = useSignaturesStore((s) => s.loaded);
  const load = useSignaturesStore((s) => s.load);
  const remove = useSignaturesStore((s) => s.remove);

  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    setPos({
      top: rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right),
    });
  }, [anchor]);

  // Close on outside click + ESC. The editor consumes its own ESC, so we
  // gate this on `!editorOpen` to avoid double-handling.
  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      if (editorOpen) return;
      if (!popoverRef.current) return;
      if (popoverRef.current.contains(e.target as Node)) return;
      if (anchor.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (editorOpen) return;
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose, editorOpen]);

  const handleSelect = (id: string) => {
    onSelect(id);
    onClose();
  };

  const handleRemove = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await remove(id);
    } catch (err) {
      console.error('[SignaturesMenu] remove failed', err);
    }
  };

  const handleCreated = (signature: Signature) => {
    onSelect(signature.id);
    onClose();
  };

  if (!pos) return <></>;

  return (
    <>
      <div
        ref={popoverRef}
        className="signatures-menu"
        role="dialog"
        aria-label="Signatures"
        style={{ top: pos.top, right: pos.right }}
      >
        <div className="signatures-menu-header">
          <span className="signatures-menu-title">Signatures</span>
          <div className="signatures-menu-actions">
            <button
              type="button"
              className="signatures-menu-action"
              onClick={() => setEditorOpen(true)}
            >
              + New
            </button>
          </div>
        </div>

        {signatures.length === 0 ? (
          <div className="signatures-menu-empty muted small">
            No signatures yet. Click <strong>+ New</strong> to draw, type or
            upload one.
          </div>
        ) : (
          <div className="signatures-menu-grid">
            {signatures.map((signature) => (
              <div
                key={signature.id}
                className="signature-chip"
                role="button"
                tabIndex={0}
                onClick={() => handleSelect(signature.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleSelect(signature.id);
                  }
                }}
                title={signature.label}
              >
                <img
                  src={`signature://${signature.id}`}
                  alt={signature.label}
                  className="signature-chip-img"
                  draggable={false}
                />
                <div className="signature-chip-meta">
                  <span className="signature-chip-label">{signature.label}</span>
                  <span className="signature-chip-kind">
                    {KIND_LABEL[signature.kind]}
                  </span>
                </div>
                <button
                  type="button"
                  className="signature-chip-remove"
                  aria-label={`Remove ${signature.label}`}
                  onClick={(e) => handleRemove(e, signature.id)}
                >
                  <span aria-hidden>×</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {editorOpen && (
        <SignatureEditor
          onClose={() => setEditorOpen(false)}
          onCreated={handleCreated}
        />
      )}
    </>
  );
}
